import { useCallback, useMemo, useRef, useState } from 'react'
const avg = (a) => { const v = a.filter((x) => x != null && !Number.isNaN(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null }

// Start/Stop performance test. bitrateKey: 'upMbps' (host) or 'downMbps' (receiver)
export function useTest(bitrateKey) {
  const [running, setRunning] = useState(false)
  const [rows, setRows] = useState([])
  const [reconn, setReconn] = useState([])
  const rr = useRef({ on: false, rows: [], reconn: [] })
  const onSample = useCallback((s) => { if (rr.current.on) { rr.current.rows.push(s); setRows(rr.current.rows.slice()) } }, [])
  const onReconnect = useCallback((secs) => { if (rr.current.on) { rr.current.reconn.push(secs); setReconn(rr.current.reconn.slice()) } }, [])
  const start = () => { rr.current = { on: true, rows: [], reconn: [] }; setRows([]); setReconn([]); setRunning(true) }
  const stop = () => { rr.current.on = false; setRunning(false) }
  const summary = useMemo(() => ({
    samples: rows.length,
    avgLatency: avg(rows.map((r) => r.latency)),
    maxLatency: rows.length ? Math.max(...rows.map((r) => r.latency ?? 0)) : null,
    avgJitter: avg(rows.map((r) => r.jitter)),
    avgLoss: avg(rows.map((r) => r.lossPct)),
    avgBitrate: avg(rows.map((r) => r[bitrateKey])),
    avgFps: avg(rows.map((r) => r.fps)),
    reconnections: reconn.length,
    avgReconnect: avg(reconn),
  }), [rows, reconn, bitrateKey])
  const exportCsv = () => {
    const h = 'time,rtt_ms,latency_ms,jitter_ms,loss_pct,down_mbps,up_mbps,fps,frames_dropped,receivers'
    const body = rows.map((r) => [new Date(r.t).toISOString(), r.rtt, r.latency, r.jitter, r.lossPct, r.downMbps, r.upMbps, r.fps, r.framesDropped, r.receivers ?? ''].join(','))
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([[h, ...body].join('\n')], { type: 'text/csv' }))
    a.download = 'webrtc-test.csv'; a.click()
  }
  return { running, start, stop, summary, exportCsv, onSample, onReconnect, reconnTimes: reconn }
}
