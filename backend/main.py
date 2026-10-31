import asyncio, base64, hashlib, hmac, os, secrets, time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.staticfiles import StaticFiles

GRACE = int(os.getenv("RECEIVER_GRACE_SECONDS", "30"))
MAX_RECEIVERS = int(os.getenv("MAX_RECEIVERS", "20"))
STUN_URLS = [u for u in os.getenv("STUN_URLS", "stun:stun.l.google.com:19302").split(",") if u]
TURN_URL = os.getenv("TURN_URL", "")
TURN_SECRET = os.getenv("TURN_SECRET", "")
ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I

app = FastAPI(title="WebRTC Stream Signaling")


def sha(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def new_key() -> str:
    return "-".join("".join(secrets.choice(ALPHABET) for _ in range(4)) for _ in range(3))


@dataclass
class Receiver:
    rid: str
    n: int
    token_hash: str
    ws: Optional[WebSocket] = None
    gone_task: Optional[asyncio.Task] = None


@dataclass
class Stream:
    stream_id: str
    key_hash: str
    host_hash: str
    host_ws: Optional[WebSocket] = None
    receivers: dict = field(default_factory=dict)
    counter: int = 0


STREAMS: dict[str, Stream] = {}
BY_KEY: dict[str, str] = {}
FAILS: dict[str, list] = {}


def ip_of(c) -> str:
    return c.client.host if c.client else "?"


def blocked(ip: str) -> bool:
    now = time.time()
    FAILS[ip] = [t for t in FAILS.get(ip, []) if now - t < 60]
    return len(FAILS[ip]) >= 10


def fail(ip: str):
    FAILS.setdefault(ip, []).append(time.time())


async def send(ws, obj):
    if ws is None:
        return
    try:
        await ws.send_json(obj)
    except Exception:
        pass


def stream_by_key(key: str) -> Optional[Stream]:
    sid = BY_KEY.get(sha((key or "").strip().upper()))
    return STREAMS.get(sid) if sid else None


# ---------------- REST ----------------
@app.post("/api/streams")
def create_stream():
    """Host creates a stream. Key + host token are returned ONCE; only hashes are kept."""
    key, token, sid = new_key(), secrets.token_urlsafe(24), secrets.token_hex(4)
    s = Stream(sid, sha(key), sha(token))
    STREAMS[sid] = s
    BY_KEY[s.key_hash] = sid
    return {"stream_id": sid, "stream_key": key, "host_token": token}


@app.get("/api/ice-config")
def ice_config(request: Request):
    """STUN/TURN config. Requires a valid stream key, so TURN can't be abused anonymously."""
    ip = ip_of(request)
    if blocked(ip):
        raise HTTPException(429, "Too many attempts")
    if not stream_by_key(request.headers.get("x-stream-key", "")):
        fail(ip)
        raise HTTPException(401, "Invalid stream key")
    servers = [{"urls": STUN_URLS}]
    if TURN_URL and TURN_SECRET:
        user = f"{int(time.time()) + 3600}:viewer"  # coturn "use-auth-secret" format
        cred = base64.b64encode(hmac.new(TURN_SECRET.encode(), user.encode(), hashlib.sha1).digest()).decode()
        servers.append({"urls": [TURN_URL], "username": user, "credential": cred})
    return {"iceServers": servers}


@app.delete("/api/streams/{sid}")
async def end_stream(sid: str, request: Request):
    s = STREAMS.get(sid)
    tok = request.headers.get("x-host-token", "")
    if not s or not hmac.compare_digest(sha(tok), s.host_hash):
        raise HTTPException(403, "Forbidden")
    for r in list(s.receivers.values()):
        await send(r.ws, {"type": "stream-ended"})
        if r.gone_task:
            r.gone_task.cancel()
    STREAMS.pop(sid, None)
    BY_KEY.pop(s.key_hash, None)
    return {"ok": True}


# ---------------- WebSocket signaling ----------------
async def drop_later(s: Stream, r: Receiver):
    await asyncio.sleep(GRACE)
    if r.ws is None and s.receivers.get(r.rid) is r:
        s.receivers.pop(r.rid, None)
        await send(s.host_ws, {"type": "receiver-gone", "rid": r.rid})


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    ip = ip_of(ws)
    s: Optional[Stream] = None
    role, rid = None, None
    try:
        first = await asyncio.wait_for(ws.receive_json(), 10)
        if blocked(ip):
            return await ws.close(4429)

        # ---- HOST joins ----
        if first.get("type") == "host-join":
            s = STREAMS.get(first.get("stream_id", ""))
            if not s:
                return await ws.close(4404)
            if not hmac.compare_digest(sha(first.get("host_token", "")), s.host_hash):
                fail(ip)
                return await ws.close(4403)
            role = "host"
            if s.host_ws:
                try:
                    await s.host_ws.close(4000)
                except Exception:
                    pass
            s.host_ws = ws
            await send(ws, {"type": "host-ready",
                            "receivers": [{"rid": r.rid, "n": r.n} for r in s.receivers.values()]})
            for r in s.receivers.values():
                await send(r.ws, {"type": "host-online"})
            async for m in ws.iter_json():
                r = s.receivers.get(m.get("to"))
                if r and m.get("type") in ("offer", "ice"):
                    out = {"type": m["type"]}
                    for k in ("sdp", "candidate", "restart"):
                        if k in m:
                            out[k] = m[k]
                    await send(r.ws, out)

        # ---- RECEIVER joins ----
        elif first.get("type") == "receiver-join":
            s = stream_by_key(first.get("stream_key", ""))
            if not s:
                fail(ip)
                return await ws.close(4401)
            tok = first.get("receiver_token") or ""
            r = next((x for x in s.receivers.values()
                      if tok and hmac.compare_digest(x.token_hash, sha(tok))), None)
            if r is None:
                if len(s.receivers) >= MAX_RECEIVERS:
                    return await ws.close(4429)
                s.counter += 1
                tok = secrets.token_urlsafe(16)
                r = Receiver(secrets.token_hex(4), s.counter, sha(tok))
                s.receivers[r.rid] = r
            if r.gone_task:
                r.gone_task.cancel()
            if r.ws and r.ws is not ws:
                try:
                    await r.ws.close(4000)
                except Exception:
                    pass
            r.ws, rid, role = ws, r.rid, "receiver"
            await send(ws, {"type": "joined", "receiver_token": tok, "label": f"Receiver {r.n}",
                            "host_online": s.host_ws is not None})
            await send(s.host_ws, {"type": "receiver-joined", "rid": r.rid, "n": r.n,
                                   "resumed": bool(first.get("resume"))})
            async for m in ws.iter_json():
                t = m.get("type")
                if t == "answer":
                    await send(s.host_ws, {"type": "answer", "from": r.rid, "sdp": m.get("sdp")})
                elif t == "ice":
                    await send(s.host_ws, {"type": "ice", "from": r.rid, "candidate": m.get("candidate")})
                elif t == "restart-request":
                    await send(s.host_ws, {"type": "restart-request", "from": r.rid})
                elif t == "receiver-join":  # fresh re-join (hard re-init)
                    await send(s.host_ws, {"type": "receiver-joined", "rid": r.rid, "n": r.n, "resumed": False})
        else:
            await ws.close(4400)
    except Exception:
        pass
    finally:
        if s and role == "host" and s.host_ws is ws:
            s.host_ws = None
            for r in s.receivers.values():
                await send(r.ws, {"type": "host-offline"})
        elif s and role == "receiver":
            r = s.receivers.get(rid)
            if r and r.ws is ws:
                r.ws = None
                await send(s.host_ws, {"type": "receiver-offline", "rid": rid})
                r.gone_task = asyncio.create_task(drop_later(s, r))


# Serve the built React app (production, single HTTPS origin)
DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if DIST.exists():
    app.mount("/", StaticFiles(directory=DIST, html=True), name="web")
