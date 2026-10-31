import os, uvicorn
d = os.path.join(os.path.dirname(os.path.abspath(__file__)), "certs")
key, cert = os.path.join(d, "key.pem"), os.path.join(d, "cert.pem")
tls = os.path.exists(key) and os.path.exists(cert)
if not tls:
    print("WARNING: no certs found - running plain HTTP/WS. Run ./gen_certs.sh for HTTPS/WSS.")
uvicorn.run("main:app", host="0.0.0.0", port=8443,
            ssl_keyfile=key if tls else None, ssl_certfile=cert if tls else None)
