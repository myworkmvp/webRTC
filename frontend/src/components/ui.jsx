import React from 'react'
export const fmt = (v, d = 1) => (v == null || Number.isNaN(v) ? '–' : Number(v).toFixed(d))

export function Stat({ label, value, unit, tone }) {
  return (
    <div className={`stat ${tone || ''}`}>
      <div className="stat-l">{label}</div>
      <div className="stat-v">{value}<small>{unit ? ` ${unit}` : ''}</small></div>
    </div>
  )
}
export const Badge = ({ tone = 'gray', children }) => <span className={`badge ${tone}`}>{children}</span>

// Tiny dependency-free SVG line chart (last 60 samples)
export function Chart({ title, unit, data, series }) {
  const W = 300, H = 110, P = 6, d = data.slice(-60)
  const vals = series.flatMap((s) => d.map((x) => x[s.key]).filter((v) => v != null))
  const max = Math.max(1, ...vals)
  const pts = (k) => d.map((x, i) => (x[k] == null ? null : `${(i / Math.max(d.length - 1, 1)) * W},${H - P - (x[k] / max) * (H - 2 * P)}`)).filter(Boolean).join(' ')
  return (
    <div className="card chart">
      <div className="chart-h"><b>{title}</b><span>max {fmt(max)} {unit}</span></div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {[0.25, 0.5, 0.75].map((g) => <line key={g} x1="0" x2={W} y1={H * g} y2={H * g} className="grid" />)}
        {series.map((s) => <polyline key={s.key} points={pts(s.key)} fill="none" stroke={s.color} strokeWidth="2" vectorEffect="non-scaling-stroke" />)}
      </svg>
      <div className="legend">{series.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>)}</div>
    </div>
  )
}

export function Charts({ history }) {
  return (
    <div className="grid charts">
      <Chart title="Latency & Jitter" unit="ms" data={history} series={[{ key: 'latency', label: 'Latency', color: '#2563eb' }, { key: 'jitter', label: 'Jitter', color: '#f59e0b' }]} />
      <Chart title="Bitrate" unit="Mbps" data={history} series={[{ key: 'downMbps', label: 'Download', color: '#16a34a' }, { key: 'upMbps', label: 'Upload', color: '#9333ea' }]} />
      <Chart title="FPS & Packet loss" unit="" data={history} series={[{ key: 'fps', label: 'FPS', color: '#0891b2' }, { key: 'lossPct', label: 'Loss %', color: '#dc2626' }]} />
    </div>
  )
}

// Performance evaluation: live metric table + Start/Stop test + summary
export function PerfPanel({ test, metrics, extraRows = [] }) {
  const m = metrics || {}
  const rows = [
    ['Latency / RTT', fmt(m.latency), 'ms'], ['Jitter', fmt(m.jitter), 'ms'], ['Packet Loss', fmt(m.lossPct, 2), '%'],
    ['Download Bitrate', fmt(m.downMbps, 2), 'Mbps'], ['Upload Bitrate', fmt(m.upMbps, 2), 'Mbps'], ['FPS', fmt(m.fps, 0), 'frames/sec'],
    ['Frames Dropped', m.framesDropped ?? '–', 'count'], ...extraRows,
  ]
  const s = test.summary
  return (
    <div className="card">
      <div className="row between"><h3>Performance evaluation</h3>
        <div className="row">
          {!test.running ? <button className="btn" onClick={test.start}>Start Test</button> : <button className="btn danger" onClick={test.stop}>Stop Test ({s.samples}s)</button>}
          <button className="btn ghost" disabled={!s.samples} onClick={test.exportCsv}>Export CSV</button>
        </div>
      </div>
      <div className="two">
        <table><thead><tr><th>Metric</th><th>Value</th><th>Unit</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r[0]}><td>{r[0]}</td><td><b>{r[1]}</b></td><td>{r[2]}</td></tr>)}</tbody></table>
        <table><thead><tr><th>Test summary</th><th>Result</th></tr></thead>
          <tbody>
            <tr><td>Average latency</td><td>{fmt(s.avgLatency)} ms</td></tr>
            <tr><td>Maximum latency</td><td>{fmt(s.maxLatency)} ms</td></tr>
            <tr><td>Average jitter</td><td>{fmt(s.avgJitter)} ms</td></tr>
            <tr><td>Average packet loss</td><td>{fmt(s.avgLoss, 2)} %</td></tr>
            <tr><td>Average bitrate</td><td>{fmt(s.avgBitrate, 2)} Mbps</td></tr>
            <tr><td>Average FPS</td><td>{fmt(s.avgFps, 0)}</td></tr>
            <tr><td>Total reconnections</td><td>{s.reconnections}</td></tr>
            <tr><td>Avg reconnection time</td><td>{fmt(s.avgReconnect)} s</td></tr>
          </tbody></table>
      </div>
    </div>
  )
}
