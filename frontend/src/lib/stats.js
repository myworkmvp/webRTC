// Turns RTCPeerConnection.getStats() into human metrics. Call sample(pc) once per second.
// Counters (bytes, packets) are cumulative, so every rate = (now - previous) / elapsed time.
export class StatsSampler {
  constructor() { this.prev = null }
  async sample(pc) {
    const rep = await pc.getStats()
    const c = { t: performance.now(), bytesIn: 0, bytesOut: 0, pktIn: 0, pktOut: 0, lostIn: 0, lostOut: 0,
      framesRecv: 0, framesDropped: 0, jbDelay: 0, jbCount: 0 }
    let pairRtt = null, rtcpRtt = null, jitIn = null, jitOut = null, fps = null
    rep.forEach((r) => {
      if (r.type === 'inbound-rtp') {
        c.bytesIn += r.bytesReceived || 0; c.pktIn += r.packetsReceived || 0; c.lostIn += r.packetsLost || 0
        if (r.kind === 'video') {
          c.framesRecv = r.framesReceived || 0; c.framesDropped = r.framesDropped || 0
          jitIn = r.jitter; c.jbDelay = r.jitterBufferDelay || 0; c.jbCount = r.jitterBufferEmittedCount || 0
          if (r.framesPerSecond != null) fps = r.framesPerSecond
        }
      } else if (r.type === 'outbound-rtp') {
        c.bytesOut += r.bytesSent || 0; c.pktOut += r.packetsSent || 0
        if (r.kind === 'video' && r.framesPerSecond != null) fps = r.framesPerSecond
      } else if (r.type === 'remote-inbound-rtp') {
        c.lostOut += r.packetsLost || 0
        if (r.kind === 'video') { jitOut = r.jitter; if (r.roundTripTime != null) rtcpRtt = r.roundTripTime * 1000 }
      } else if (r.type === 'candidate-pair' && (r.nominated || r.selected) && r.state === 'succeeded') {
        if (r.currentRoundTripTime != null) pairRtt = r.currentRoundTripTime * 1000
      }
    })
    const p = this.prev; this.prev = c
    const rtt = pairRtt ?? rtcpRtt
    const out = { rtt, jitter: (jitIn ?? jitOut) != null ? (jitIn ?? jitOut) * 1000 : null, fps,
      downMbps: 0, upMbps: 0, lossPct: 0, framesDropped: c.framesDropped, framesReceived: c.framesRecv,
      packetsReceived: c.pktIn, packetsSent: c.pktOut, packetsLost: c.lostIn + c.lostOut, latency: rtt }
    if (p) {
      const dt = (c.t - p.t) / 1000 || 1
      out.downMbps = Math.max(0, ((c.bytesIn - p.bytesIn) * 8) / dt / 1e6)
      out.upMbps = Math.max(0, ((c.bytesOut - p.bytesOut) * 8) / dt / 1e6)
      const dLostIn = Math.max(0, c.lostIn - p.lostIn), dIn = Math.max(0, c.pktIn - p.pktIn)
      const dLostOut = Math.max(0, c.lostOut - p.lostOut), dOut = Math.max(0, c.pktOut - p.pktOut)
      if (dIn + dLostIn > 0) out.lossPct = (dLostIn / (dIn + dLostIn)) * 100       // receiver view
      else if (dOut > 0) out.lossPct = (dLostOut / dOut) * 100                      // sender view (from RTCP)
      if (fps == null && dt) out.fps = Math.max(0, (c.framesRecv - p.framesRecv) / dt)
      // Estimated one-way latency = RTT/2 + average jitter-buffer delay (receiver only)
      const dj = c.jbCount - p.jbCount
      if (rtt != null && dj > 0) out.latency = rtt / 2 + ((c.jbDelay - p.jbDelay) / dj) * 1000
    }
    return out
  }
}
