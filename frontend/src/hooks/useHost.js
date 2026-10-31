import { useCallback, useEffect, useRef, useState } from 'react'
import { Signaling } from '../lib/signaling'
import { StatsSampler } from '../lib/stats'
import { createStream, getIce, endStream } from '../lib/api'

const mean = (a) => { const v = a.filter((x) => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null }

// Host = captures camera/mic and keeps ONE RTCPeerConnection per receiver (fan-out).
export function useHost(onSample) {
  const [info, setInfo] = useState(null)
  const [live, setLive] = useState(false)
  const [sigState, setSigState] = useState('closed')
  const [receivers, setReceivers] = useState([])
  const [metrics, setMetrics] = useState(null)
  const [history, setHistory] = useState([])
  const [bitrateKbps, setBitrateKbpsState] = useState(1500)
  const [mic, setMic] = useState({ present: false, level: 0 })
  const [error, setError] = useState('')
  const previewRef = useRef(null)
  const cb = useRef(onSample); cb.current = onSample
  const R = useRef({ peers: new Map(), recv: new Map(), stream: null, sig: null, ice: [], timer: null, saved: null, bitrate: 1500, audio: null })

  const sync = () => setReceivers([...R.current.recv.values()].sort((a, b) => a.n - b.n).map((r) => ({ ...r })))
  const setRecv = (rid, patch) => { const r = R.current.recv.get(rid); if (r) { Object.assign(r, patch); sync() } }

  const applyBitrate = (pc) => pc.getSenders().forEach((s) => {
    if (s.track?.kind !== 'video') return
    const p = s.getParameters(); if (!p.encodings?.length) p.encodings = [{}]
    p.encodings[0].maxBitrate = R.current.bitrate * 1000
    s.setParameters(p).catch(() => {})
  })
  const closePeer = (rid) => { const p = R.current.peers.get(rid); if (p) { p.pc.onconnectionstatechange = null; p.pc.close(); R.current.peers.delete(rid) } }

  const offer = async (rid, pc, restart) => {
    await pc.setLocalDescription(await pc.createOffer(restart ? { iceRestart: true } : undefined))
    R.current.sig.send({ type: 'offer', to: rid, sdp: pc.localDescription, restart })
  }
  const createPeer = async (rid) => {
    const r = R.current; closePeer(rid)
    const pc = new RTCPeerConnection({ iceServers: r.ice })
    r.stream.getTracks().forEach((t) => pc.addTrack(t, r.stream))
    applyBitrate(pc)
    pc.onicecandidate = (e) => e.candidate && r.sig.send({ type: 'ice', to: rid, candidate: e.candidate })
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState
      if (s === 'connected') setRecv(rid, { state: 'Connected' })
      else if (s === 'disconnected' || s === 'failed') setRecv(rid, { state: 'Reconnecting' })
      else if (s === 'connecting') setRecv(rid, { state: 'Connecting' })
    }
    r.peers.set(rid, { pc, pending: [], sampler: new StatsSampler() })
    await offer(rid, pc, false)
  }
  const flush = async (p) => { for (const c of p.pending.splice(0)) await p.pc.addIceCandidate(c).catch(() => {}) }

  const onMsg = async (m) => {
    const r = R.current
    try {
      switch (m.type) {
        case 'host-ready':
          for (const x of m.receivers) { r.recv.set(x.rid, { rid: x.rid, n: x.n, state: 'Connecting' }); await createPeer(x.rid) }
          sync(); break
        case 'receiver-joined': {
          const old = r.peers.get(m.rid)
          if (m.resumed && old?.pc.connectionState === 'connected') break // only signaling reconnected
          r.recv.set(m.rid, { rid: m.rid, n: m.n, state: 'Connecting' }); sync()
          await createPeer(m.rid); break
        }
        case 'answer': { const p = r.peers.get(m.from); if (p) { await p.pc.setRemoteDescription(m.sdp); await flush(p) } break }
        case 'ice': { const p = r.peers.get(m.from); if (!p) break
          if (p.pc.remoteDescription) await p.pc.addIceCandidate(m.candidate).catch(() => {}); else p.pending.push(m.candidate); break }
        case 'restart-request': { const p = r.peers.get(m.from)
          if (p && p.pc.signalingState === 'stable') await offer(m.from, p.pc, true)   // ICE restart, same PeerConnection
          else if (!p) await createPeer(m.from)
          break }
        case 'receiver-offline': { const x = r.recv.get(m.rid); if (x && x.state !== 'Connected') setRecv(m.rid, { state: 'Reconnecting' }); break }
        case 'receiver-gone': closePeer(m.rid); r.recv.delete(m.rid); sync(); break
      }
    } catch (e) { console.warn('signal error', e) }
  }

  const tick = async () => {
    const r = R.current, list = []
    for (const [rid, p] of r.peers) {
      if (p.pc.connectionState !== 'connected') continue
      try { const s = await p.sampler.sample(p.pc); list.push(s); setRecv(rid, { rtt: s.rtt, mbps: s.upMbps }) } catch { /* ignore */ }
    }
    let level = 0
    if (r.audio) { const d = new Uint8Array(r.audio.an.fftSize); r.audio.an.getByteTimeDomainData(d)
      level = Math.min(1, Math.sqrt(d.reduce((s, v) => s + ((v - 128) / 128) ** 2, 0) / d.length) * 4) }
    setMic((m) => ({ ...m, level }))
    const s = {
      t: Date.now(), rtt: mean(list.map((x) => x.rtt)), latency: mean(list.map((x) => x.rtt)), jitter: mean(list.map((x) => x.jitter)),
      lossPct: mean(list.map((x) => x.lossPct)) ?? 0, upMbps: list.reduce((a, x) => a + x.upMbps, 0), downMbps: list.reduce((a, x) => a + x.downMbps, 0),
      fps: mean(list.map((x) => x.fps)), framesDropped: list.reduce((a, x) => a + x.framesDropped, 0),
      packetsSent: list.reduce((a, x) => a + x.packetsSent, 0), packetsReceived: list.reduce((a, x) => a + x.packetsReceived, 0),
      packetsLost: list.reduce((a, x) => a + x.packetsLost, 0), receivers: list.length,
      connState: list.length ? 'connected' : 'no peers', iceState: [...r.peers.values()][0]?.pc.iceConnectionState ?? '-',
    }
    setMetrics(s); setHistory((h) => [...h.slice(-119), s]); cb.current?.(s)
  }

  const cleanup = () => {
    const r = R.current; clearInterval(r.timer)
    ;[...r.peers.keys()].forEach(closePeer); r.recv.clear(); sync()
    r.sig?.close(); r.sig = null
    r.stream?.getTracks().forEach((t) => t.stop()); r.stream = null
    r.audio?.ctx.close().catch(() => {}); r.audio = null
    if (previewRef.current) previewRef.current.srcObject = null
    setLive(false); setSigState('closed'); setMic({ present: false, level: 0 })
  }

  const start = useCallback(async () => {
    setError('')
    const r = R.current
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: { echoCancellation: true, noiseSuppression: true } })
      r.stream = stream; previewRef.current.srcObject = stream
      if (stream.getAudioTracks().length) {
        const ctx = new AudioContext(), an = ctx.createAnalyser(); an.fftSize = 512
        ctx.createMediaStreamSource(stream).connect(an); r.audio = { ctx, an }; setMic({ present: true, level: 0 })
      }
      let saved = JSON.parse(sessionStorage.getItem('host') || 'null')
      if (!saved) { saved = await createStream(); sessionStorage.setItem('host', JSON.stringify(saved)) }
      r.saved = saved; setInfo(saved)
      r.ice = await getIce(saved.stream_key)
      r.sig = new Signaling({
        onState: setSigState, onMessage: onMsg,
        onOpen: () => r.sig.send({ type: 'host-join', stream_id: saved.stream_id, host_token: saved.host_token }),
        onClose: (e) => { if (e.code === 4403 || e.code === 4404) { sessionStorage.removeItem('host'); setError('Stream expired. Press Start again.'); cleanup() } },
      })
      r.sig.connect(); r.timer = setInterval(tick, 1000); setLive(true)
    } catch (e) { setError(e.message || String(e)); cleanup() }
  }, [])

  const stop = useCallback(() => {
    const s = R.current.saved
    if (s) endStream(s.stream_id, s.host_token)
    sessionStorage.removeItem('host'); R.current.saved = null; cleanup(); setInfo(null); setReceivers([]); setMetrics(null)
  }, [])

  const setBitrateKbps = (k) => { R.current.bitrate = k; setBitrateKbpsState(k); R.current.peers.forEach((p) => applyBitrate(p.pc)) }
  useEffect(() => () => cleanup(), [])
  return { info, live, sigState, receivers, metrics, history, bitrateKbps, setBitrateKbps, mic, error, previewRef, start, stop }
}
