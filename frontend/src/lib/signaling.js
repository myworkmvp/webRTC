import { wsUrl } from './api'
const FATAL = [4401, 4403, 4404, 4429] // bad key / bad token / no stream / rate-limited: don't retry

// WebSocket with automatic reconnect + exponential backoff (1s,2s,4s ... max 30s, with jitter)
export class Signaling {
  constructor(h) { this.h = h; this.attempt = 0; this.closed = false; this.ws = null }
  connect() {
    if (this.closed) return
    this.h.onState?.('connecting', this.attempt)
    const ws = new WebSocket(wsUrl())
    this.ws = ws
    ws.onopen = () => { this.attempt = 0; this.h.onState?.('open'); this.h.onOpen?.() }
    ws.onmessage = (e) => { try { this.h.onMessage(JSON.parse(e.data)) } catch (err) { console.warn(err) } }
    ws.onclose = (e) => {
      if (this.ws !== ws) return
      this.h.onClose?.(e)
      if (this.closed || FATAL.includes(e.code)) return this.h.onState?.('closed')
      const delay = Math.min(30000, 1000 * 2 ** this.attempt) * (0.5 + Math.random() / 2)
      this.attempt++
      this.h.onState?.('reconnecting', this.attempt, delay)
      this.timer = setTimeout(() => this.connect(), delay)
    }
  }
  send(o) { if (this.ws?.readyState === 1) { this.ws.send(JSON.stringify(o)); return true } return false }
  close() { this.closed = true; clearTimeout(this.timer); this.ws?.close() }
}
