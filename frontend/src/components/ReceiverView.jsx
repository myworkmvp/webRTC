import React, { useState } from 'react'
import { useReceiver } from '../hooks/useReceiver'
import { useTest } from '../hooks/useTest'
import { Stat, Badge, Charts, PerfPanel, fmt } from './ui'

const label = { idle: 'Not connected', connecting: 'Connecting…', waiting: 'Waiting for host…', live: 'Connected', reconnecting: 'Reconnecting…', failed: 'Failed' }
const tone = { idle: 'gray', connecting: 'blue', waiting: 'amber', live: 'green', reconnecting: 'amber', failed: 'red' }

export default function ReceiverView() {
  const [key, setKey] = useState('')
  const test = useTest('downMbps')
  const r = useReceiver(test.onSample, test.onReconnect)
  const m = r.metrics || {}
  const v = r.videoRef
  const active = r.status !== 'idle' && r.status !== 'failed'
  return (
    <>
      <div className="grid two-col">
        <div className="card">
          <div className="video-wrap"><video ref={v} autoPlay playsInline />
            {r.status !== 'live' && <div className="overlay">{r.status === 'reconnecting' ? <><span className="spin" />Reconnecting…<small>{r.recoveryInfo}</small></> : label[r.status]}</div>}
          </div>
          <div className="row">
            <button className="btn ghost" onClick={() => { if (v.current) v.current.muted = !v.current.muted }}>🔊 Mute/Unmute</button>
            <input type="range" min="0" max="1" step="0.05" defaultValue="1" onChange={(e) => { if (v.current) v.current.volume = +e.target.value }} />
            <button className="btn ghost" onClick={() => v.current?.requestFullscreen?.()}>⛶</button>
          </div>
        </div>
        <div className="card">
          <h3>Join a stream</h3>
          <div className="label">Enter Stream Key</div>
          <div className="row">
            <input className="input" placeholder="XXXX-XXXX-XXXX" value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} disabled={active} onKeyDown={(e) => e.key === 'Enter' && !active && r.join(key)} />
            {!active ? <button className="btn" disabled={key.length < 12} onClick={() => r.join(key)}>Connect</button> : <button className="btn danger" onClick={() => r.leave()}>Leave</button>}
          </div>
          {r.error && <p className="err">{r.error}</p>}
          <div className="row wrap" style={{ marginTop: 12 }}>
            <Badge tone={tone[r.status]}>{label[r.status]}</Badge>
            <Badge tone={r.sigState === 'open' ? 'green' : r.sigState === 'closed' ? 'gray' : 'amber'}>Signaling: {r.sigState}</Badge>
          </div>
          <div className="label">Auto-recovery: re-initialise if down longer than</div>
          <div className="row"><input className="input small" type="number" min="5" max="120" value={r.timeoutSec} onChange={(e) => r.setTimeoutSec(Math.max(5, +e.target.value || 15))} /><span className="muted">seconds (doubles on each failed attempt, max 60 s)</span></div>
          <p className="muted">Reconnections: <b>{r.reconnects}</b> · Last reconnection time: <b>{fmt(r.lastReconnect)} s</b></p>
        </div>
      </div>
      <div className="grid stats">
        <Stat label="Connection state" value={m.connState ?? '-'} />
        <Stat label="ICE state" value={m.iceState ?? '-'} />
        <Stat label="Latency (est.)" value={fmt(m.latency)} unit="ms" />
        <Stat label="RTT" value={fmt(m.rtt)} unit="ms" />
        <Stat label="Jitter" value={fmt(m.jitter)} unit="ms" />
        <Stat label="Packet loss" value={fmt(m.lossPct, 2)} unit="%" />
        <Stat label="Bitrate" value={fmt(m.downMbps, 2)} unit="Mbps" />
        <Stat label="FPS" value={fmt(m.fps, 0)} />
        <Stat label="Packets recv / lost" value={`${m.packetsReceived ?? 0} / ${m.packetsLost ?? 0}`} />
        <Stat label="Frames recv / dropped" value={`${m.framesReceived ?? 0} / ${m.framesDropped ?? 0}`} />
      </div>
      <Charts history={r.history} />
      <PerfPanel test={test} metrics={r.metrics} extraRows={[['Reconnection Time', fmt(r.lastReconnect), 'seconds']]} />
    </>
  )
}
