import React from 'react'
import { useHost } from '../hooks/useHost'
import { useTest } from '../hooks/useTest'
import { Stat, Badge, Charts, PerfPanel, fmt } from './ui'

const tone = { Connected: 'green', Connecting: 'blue', Reconnecting: 'amber', Disconnected: 'red' }

export default function HostView() {
  const test = useTest('upMbps')
  const h = useHost(test.onSample)
  const m = h.metrics || {}
  const connected = h.receivers.filter((r) => r.state === 'Connected').length
  const copy = () => navigator.clipboard?.writeText(h.info?.stream_key || '')
  return (
    <>
      <div className="grid two-col">
        <div className="card">
          <div className="video-wrap"><video ref={h.previewRef} autoPlay muted playsInline />{!h.live && <div className="overlay">Camera preview</div>}</div>
          <div className="row">
            {!h.live ? <button className="btn" onClick={h.start}>▶ Start Stream</button> : <button className="btn danger" onClick={h.stop}>■ Stop Stream</button>}
            <Badge tone={h.live ? 'green' : 'gray'}>{h.live ? 'LIVE' : 'Offline'}</Badge>
            <Badge tone={h.sigState === 'open' ? 'green' : h.sigState === 'closed' ? 'gray' : 'amber'}>Signaling: {h.sigState}</Badge>
            <label className="sel">Max bitrate/receiver
              <select value={h.bitrateKbps} onChange={(e) => h.setBitrateKbps(+e.target.value)}>
                {[500, 1000, 1500, 2500].map((k) => <option key={k} value={k}>{k / 1000} Mbps</option>)}
              </select></label>
          </div>
          {h.error && <p className="err">{h.error}</p>}
          <div className="mic"><span>🎤 Microphone: {h.mic.present ? 'active' : 'not active'}</span><div className="bar"><i style={{ width: `${h.mic.level * 100}%` }} /></div></div>
        </div>
        <div className="card">
          <h3>Stream access</h3>
          <p className="muted">Share this key with receivers. It is validated on the server; your host token never leaves this browser.</p>
          <div className="label">Stream ID</div><code className="big">{h.info?.stream_id || '—'}</code>
          <div className="label">Stream key</div>
          <div className="row"><code className="big key">{h.info?.stream_key || '—'}</code><button className="btn ghost" disabled={!h.info} onClick={copy}>Copy</button></div>
          <h3>Receivers ({connected}/{h.receivers.length})</h3>
          <ul className="rlist">
            {h.receivers.length === 0 && <li className="muted">No receivers yet</li>}
            {h.receivers.map((r) => (
              <li key={r.rid}><span>Receiver {r.n}</span><span className="muted">{r.rtt != null ? `${fmt(r.rtt, 0)} ms · ${fmt(r.mbps, 2)} Mbps` : ''}</span><Badge tone={tone[r.state]}>{r.state}</Badge></li>
            ))}
          </ul>
        </div>
      </div>
      <div className="grid stats">
        <Stat label="Connected receivers" value={connected} />
        <Stat label="Streaming status" value={h.live ? 'LIVE' : 'Offline'} tone={h.live ? 'good' : ''} />
        <Stat label="Upload bitrate (total)" value={fmt(m.upMbps, 2)} unit="Mbps" />
        <Stat label="FPS" value={fmt(m.fps, 0)} />
        <Stat label="Avg RTT" value={fmt(m.rtt)} unit="ms" />
        <Stat label="Jitter" value={fmt(m.jitter)} unit="ms" />
        <Stat label="Packet loss" value={fmt(m.lossPct, 2)} unit="%" />
        <Stat label="Packets sent / lost" value={`${m.packetsSent ?? 0} / ${m.packetsLost ?? 0}`} />
        <Stat label="Connection / ICE" value={`${m.connState ?? '-'} / ${m.iceState ?? '-'}`} />
      </div>
      <Charts history={h.history} />
      <PerfPanel test={test} metrics={h.metrics} extraRows={[['Connected Receivers', connected, 'count']]} />
    </>
  )
}
