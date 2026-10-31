import { useEffect, useRef, useState } from 'react'
import { Signaling } from '../lib/signaling'
import { StatsSampler } from '../lib/stats'
import { getIce } from '../lib/api'

// Receiver with 3 recovery layers (never reloads the page):
//  1) signaling WebSocket auto-reconnect (exponential backoff)
//  2) ICE restart on the SAME peer connection (after 'disconnected' 3s, or at once on 'failed')
//  3) full re-initialisation of the peer connection if still down after `timeoutSec` (backoff doubles each time)
export function useReceiver(onSample, onReconnect) {
  const [status, setStatus] = useState('idle')   // idle|connecting|waiting|live|reconnecting|failed
  const [sigState, setSigState] = useState('closed')
  const [error, setError] = useState('')
  const [metrics, setMetrics] = useState(null)
  const [history, setHistory] = useState([])
  const [reconnects, setReconnects] = useState(0)
  const [lastReconnect, setLastReconnect] = useState(null)
  const [recoveryInfo, setRecoveryInfo] = useState('')
  const [timeoutSec, setTimeoutSec] = useState(15)
  const videoRef = useRef(null)
  const toRef = useRef(15); toRef.current = timeoutSec
  const cb = useRef({}); cb.current = { onSample, onReconnect }
  const R = useRef({ sig: null, pc: null, pending: [], joined: false, token: null, key: '', ice: [], lostAt: null,
    attempt: 0, sampler: new StatsSampler(), timer: null, restartT: null, hardT: null, leaving: false })

  const sendJoin = (resume) => R.current.sig?.send({ type: 'receiver-join', stream_key: R.current.key, receiver_token: R.current.token, resume })
  const closePc = () => {
    const r = R.current
    if (r.pc) { r.pc.onconnectionstatechange = null; r.pc.ontrack = null; r.pc.onicecandidate = null; r.pc.close(); r.pc = null }
    r.pending = []; r.sampler = new StatsSampler()
  }
  const armHard = () => {
    const r = R.current; clearTimeout(r.hardT)
    const wait = Math.min(60, toRef.current * 2 ** r.attempt)
    setRecoveryInfo(`Full re-initialise in ${wait}s (attempt ${r.attempt + 1})`)
    r.hardT = setTimeout(() => {
      if (!r.lostAt || r.leaving) return
      r.attempt++; closePc(); r.joined = false; sendJoin(false); armHard()
    }, wait * 1000)
  }
  const lost = (immediate) => {
    const r = R.current; if (r.leaving) return
    const first = !r.lostAt
    if (first) { r.lostAt = performance.now(); r.attempt = 0 }
    setStatus('reconnecting')
    clearTimeout(r.restartT)
    r.restartT = setTimeout(() => r.sig?.send({ type: 'restart-request' }), immediate ? 0 : 3000)
    if (first) armHard()
  }
  const recovered = () => {
    const r = R.current
    clearTimeout(r.restartT); clearTimeout(r.hardT)
    if (r.lostAt) {
      const secs = (performance.now() - r.lostAt) / 1000; r.lostAt = null
      setLastReconnect(secs); setReconnects((c) => c + 1); cb.current.onReconnect?.(secs)
    }
    r.attempt = 0; setRecoveryInfo(''); setStatus('live'); setError('')
    videoRef.current?.play().catch(() => {})
  }
  const newPc = () => {
    const r = R.current
    const pc = new RTCPeerConnection({ iceServers: r.ice })
    pc.onicecandidate = (e) => e.candidate && r.sig?.send({ type: 'ice', candidate: e.candidate })
    pc.ontrack = (e) => {
      const v = videoRef.current; if (!v) return
      v.srcObject = e.streams[0]
      v.play().catch(() => { v.muted = true; v.play().catch(() => {}) })   // autoplay policy fallback
    }
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState
      if (s === 'connected') recovered()
      else if (s === 'disconnected') lost(false)
      else if (s === 'failed') lost(true)
    }
    return pc
  }
  const handleOffer = async (m) => {
    const r = R.current
    let pc = r.pc
    if (!(m.restart && pc && pc.signalingState !== 'closed')) { closePc(); pc = newPc(); r.pc = pc }
    await pc.setRemoteDescription(m.sdp)
    for (const c of r.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {})
    await pc.setLocalDescription(await pc.createAnswer())
    r.sig.send({ type: 'answer', sdp: pc.localDescription })
  }
  const onMsg = async (m) => {
    const r = R.current
    try {
      if (m.type === 'joined') { r.token = m.receiver_token; r.joined = true; if (!m.host_online) setStatus('waiting'); else if (!r.pc) setStatus('connecting') }
      else if (m.type === 'offer') await handleOffer(m)
      else if (m.type === 'ice') { if (r.pc?.remoteDescription) await r.pc.addIceCandidate(m.candidate).catch(() => {}); else r.pending.push(m.candidate) }
      else if (m.type === 'host-offline') { setError('Host is offline - waiting for host...'); lost(false) }
      else if (m.type === 'host-online') setError('')
      else if (m.type === 'stream-ended') { setError('The host ended the stream.'); leave(true) }
    } catch (e) { console.warn('signal error', e) }
  }
  const tick = async () => {
    const r = R.current; if (!r.pc) return
    try {
      const s = await r.sampler.sample(r.pc)
      s.t = Date.now(); s.connState = r.pc.connectionState; s.iceState = r.pc.iceConnectionState
      setMetrics(s); setHistory((h) => [...h.slice(-119), s]); cb.current.onSample?.(s)
    } catch { /* pc closed */ }
  }

  const join = async (key) => {
    const r = R.current; setError(''); r.leaving = false
    r.key = key.trim().toUpperCase()
    try { r.ice = await getIce(r.key) } catch (e) { setError(e.message); setStatus('failed'); return }   // server-side key check
    setStatus('connecting')
    r.sig = new Signaling({
      onState: setSigState, onMessage: onMsg,
      onOpen: () => sendJoin(r.joined),
      onClose: (e) => { if ([4401, 4404, 4429].includes(e.code)) { setError(e.code === 4401 ? 'Invalid stream key' : 'Stream not available'); setStatus('failed') }
        else if (r.pc?.connectionState !== 'connected') lost(false) },
    })
    r.sig.connect(); r.timer = setInterval(tick, 1000)
  }
  const leave = (keepError) => {
    const r = R.current; r.leaving = true
    clearInterval(r.timer); clearTimeout(r.restartT); clearTimeout(r.hardT)
    r.sig?.close(); r.sig = null; closePc(); r.joined = false; r.token = null; r.lostAt = null
    if (videoRef.current) videoRef.current.srcObject = null
    setStatus('idle'); setSigState('closed'); setRecoveryInfo(''); setMetrics(null); if (!keepError) setError('')
  }
  useEffect(() => () => leave(), [])
  return { status, sigState, error, metrics, history, reconnects, lastReconnect, recoveryInfo, timeoutSec, setTimeoutSec, videoRef, join, leave }
}
