export const wsUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`

export async function createStream() {
  const r = await fetch('/api/streams', { method: 'POST' })
  if (!r.ok) throw new Error('Could not create stream')
  return r.json()
}
// Server validates the key; rejects (401) if wrong. Returns STUN/TURN servers.
export async function getIce(key) {
  const r = await fetch('/api/ice-config', { headers: { 'X-Stream-Key': key } })
  if (!r.ok) throw new Error(r.status === 429 ? 'Too many attempts' : 'Invalid stream key')
  return (await r.json()).iceServers
}
export const endStream = (id, token) =>
  fetch(`/api/streams/${id}`, { method: 'DELETE', headers: { 'X-Host-Token': token } }).catch(() => {})
