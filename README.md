# WebRTC Live Stream (One Host → Many Receivers)

React frontend · Python (FastAPI) signaling backend · WebRTC media over UDP (DTLS-SRTP) · signaling over TCP (WSS)

## Folder structure
```
webrtc-stream/
├── backend/
│   ├── main.py            # REST (key creation/validation, ICE config) + WebSocket signaling
│   ├── run.py             # starts HTTPS/WSS server on :8443
│   ├── gen_certs.sh       # self-signed certificate
│   └── requirements.txt
└── frontend/
    ├── vite.config.js     # dev server (HTTPS) + proxy to backend
    └── src/
        ├── App.jsx                     # Host / Receiver selection
        ├── lib/signaling.js            # WebSocket + exponential-backoff reconnect
        ├── lib/stats.js                # getStats() -> RTT, jitter, loss, bitrate, FPS
        ├── lib/api.js
        ├── hooks/useHost.js            # capture, one RTCPeerConnection per receiver
        ├── hooks/useReceiver.js        # 3-layer auto recovery
        ├── hooks/useTest.js            # Start/Stop test + averages + CSV
        └── components/ (HostView, ReceiverView, ui)
```

## How it works
1. Host clicks **Start Stream** → `POST /api/streams` → server returns `stream_id`, random `stream_key`, secret `host_token` (only SHA-256 hashes are stored on the server).
2. Host opens `wss://…/ws` and sends `host-join` (token checked server-side).
3. Receiver enters the key. `/api/ice-config` validates it (401 if wrong, rate-limited), then the receiver joins via WSS.
4. Server tells the host "receiver joined" (just an opaque random id). Host creates a **separate RTCPeerConnection per receiver** and sends an SDP offer; the server forwards it **only to that receiver**. Answers/ICE flow back the same way.
5. Media then flows browser → browser over **UDP** (SRTP keyed by DTLS). The server never sees media. TCP carries only signaling.

## Setup
Requirements: Python 3.10+, Node 18+, openssl.
```bash
# Backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
./gen_certs.sh 192.168.1.50      # optional arg: your LAN IP (for phones/other PCs)
python run.py                    # https://localhost:8443

# Frontend (dev, new terminal)
cd frontend
npm install
npm run dev                      # https://localhost:5173  (proxies /api and /ws to the backend)
```
Production style (single origin): `npm run build` in `frontend/`, then just run `python run.py` and open `https://localhost:8443`.

Optional TURN (for strict NATs): run coturn with `use-auth-secret`, then
`export TURN_URL=turn:YOUR_IP:3478 TURN_SECRET=yoursecret` before `python run.py`. The secret never reaches the browser; viewers get 1-hour credentials.

## Local testing
1. Open `https://localhost:5173` (accept the self-signed warning), choose **Host**, **Start Stream**, allow camera/mic.
2. Open 2–3 more tabs (or another device at `https://<LAN-IP>:5173`, accept the cert warning), choose **Receiver**, paste the key, **Connect**.
3. Host shows `Receiver 1 → Connected`, etc.; wrong key → "Invalid stream key".
4. Recovery tests: restart `python run.py` (signaling reconnect + host rejoin), toggle Wi-Fi off/on on a receiver (ICE restart), or use netem below (re-init after the timeout).
5. Click **Start Test**, run for a few minutes, **Stop Test**, **Export CSV**.
Also useful: `chrome://webrtc-internals`.

## Wireshark testing
Capture on the interface used (use `lo` for same-machine tests).
- Signaling: `tcp.port == 8443` (TLS - payload encrypted, proves WSS).
- NAT discovery: `stun`
- Key exchange: `dtls` (ClientHello → Finished = DTLS handshake that derives SRTP keys)
- Media: `udp` – find the big flow, right-click → **Decode As… → RTP**, then `rtp` / `rtcp`.
- **Telephony → RTP → RTP Streams → Analyze**: shows packet loss %, jitter, sequence errors per stream; compare with the app's numbers.
- Show the payload is encrypted: SRTP payload looks random; you cannot see video content.
- Optional: Statistics → Conversations → UDP for throughput per flow.

## Network impairment (Linux tc/netem)
Replace `eth0` with your interface (`lo` for localhost tests; it also affects signaling, which is fine for recovery demos).
```bash
sudo tc qdisc add dev eth0 root netem delay 100ms 20ms          # latency 100ms ±20ms (jitter)
sudo tc qdisc change dev eth0 root netem delay 100ms 20ms loss 5%
sudo tc qdisc change dev eth0 root netem loss 15% rate 1mbit    # heavy loss + bandwidth cap
sudo tc qdisc change dev eth0 root netem loss 100%              # full outage -> watch recovery
sudo tc qdisc show dev eth0
sudo tc qdisc del dev eth0 root                                 # ALWAYS clean up
```
Suggested experiment table: baseline, 50 ms, 100 ms+20 ms jitter, 2 % loss, 5 % loss, 10 s outage; run a 2-minute test for each and export CSV.

## How each metric is measured (`frontend/src/lib/stats.js`)
`RTCPeerConnection.getStats()` is polled every 1 s. Byte/packet counters are cumulative, so rates use the difference between two samples.
- **RTT (latency):** `candidate-pair.currentRoundTripTime` (STUN consent checks); falls back to `remote-inbound-rtp.roundTripTime` (RTCP). **Latency shown on the receiver ≈ RTT/2 + jitter-buffer delay** (`Δ jitterBufferDelay / Δ jitterBufferEmittedCount`) - an estimate, since true one-way delay needs synchronized clocks.
- **Jitter:** `inbound-rtp.jitter` (receiver) or `remote-inbound-rtp.jitter` (host) - RFC 3550 variation in packet inter-arrival time, seconds × 1000 → ms.
- **Packet loss %:** `Δ packetsLost / (Δ packetsReceived + Δ packetsLost) × 100` per second (host uses RTCP loss reports vs packets sent).
- **Throughput:** `Δ bytes × 8 / Δ seconds / 10⁶` → Mbps. Download = `inbound-rtp.bytesReceived`; upload = `outbound-rtp.bytesSent` (summed over all receivers on the host). Host download and receiver upload are ~0 because media only flows one way (only RTCP feedback comes back).
- **FPS:** `framesPerSecond`, or `Δ framesReceived / Δ time` if the browser lacks it. **Frames dropped:** `framesDropped` (cumulative).
- **Reconnection time:** time from the moment the connection was lost (`disconnected`/`failed`/host offline) until `connectionState === 'connected'` again.
- **Test summary:** averages/maximum over the 1 s samples collected between Start and Stop Test.

## Auto-recovery design (no needless page reloads)
| Layer | Trigger | Action |
|---|---|---|
| Signaling | WebSocket closes | reconnect with backoff 1,2,4…30 s (+jitter); rejoin with a resume token |
| ICE | `disconnected` (after 3 s) / `failed` (immediately) | receiver sends `restart-request`; host makes an `iceRestart` offer on the same connection |
| Re-init | still down after *N* s (configurable, default 15) | receiver closes and rebuilds its peer connection and re-joins; *N* doubles each failed attempt (max 60 s) |
After `connected` again, counters reset and `video.play()` is called automatically. The UI shows "Reconnecting…" with the countdown.

## Security notes
- HTTPS + WSS (self-signed for dev; use a real cert, e.g. Let's Encrypt, in production). Media is DTLS-SRTP (mandatory in WebRTC).
- Keys: 60-bit random key, 192-bit host token; hashes stored; constant-time compare; failed-attempt rate limit per IP; no secrets in frontend code.
- The server forwards only whitelisted fields to a single target; receivers never get other receivers' ids or messages.
- Note: stream key = shared secret. Anyone who has it can watch; the host can end the stream (Stop) to revoke it.

## Scalability
This uses a **mesh fan-out**: the host uploads one copy per receiver (upload ≈ receivers × bitrate). That is fine for ~5–10 receivers at 1–1.5 Mbps; use the *Max bitrate* selector to trade quality for capacity. To scale to hundreds, replace the host fan-out with an SFU (e.g. aiortc relay, mediasoup, LiveKit); the signaling and dashboard here stay the same.
