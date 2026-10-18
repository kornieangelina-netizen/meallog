"""Web Push (RFC 8030/8291/8292) without extra dependencies: VAPID keys, payload encryption, send.

The VAPID private key is generated on first use into data/vapid.pem next to the database and never
leaves the server. Subscriptions live in the push_subs table. remind_tick() is called by a background
thread in server.py and sends the "time for measurements" reminder once on the due day after 10:00
(Moscow time) and once more two days later if nothing was recorded.
"""
from __future__ import annotations

import base64
import json
import logging
import os
import struct
import time
from datetime import date
import urllib.error
import urllib.request
from urllib.parse import urlsplit

import jwt
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

import db

log = logging.getLogger("meallog.push")

REMIND_HOUR = 10
VAPID_SUB = "mailto:meallog@example.com"


def _b64e(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _raw_pub(key: ec.EllipticCurvePrivateKey) -> bytes:
    return key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def _key_path() -> str:
    return os.path.join(os.path.dirname(db.DB_PATH) or ".", "vapid.pem")


def vapid_key() -> ec.EllipticCurvePrivateKey:
    path = _key_path()
    if not os.path.exists(path):
        key = ec.generate_private_key(ec.SECP256R1())
        pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                serialization.NoEncryption())
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(pem)
    with open(path, "rb") as f:
        return serialization.load_pem_private_key(f.read(), password=None)


def public_key() -> str:
    """applicationServerKey for pushManager.subscribe()."""
    return _b64e(_raw_pub(vapid_key()))


def _hkdf(salt: bytes, ikm: bytes, info: bytes, length: int) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=salt, info=info).derive(ikm)


def encrypt(payload: bytes, p256dh: str, auth: str) -> bytes:
    """aes128gcm content coding (RFC 8291): one record, header carries salt and our ephemeral key."""
    ua_pub = _b64d(p256dh)
    eph = ec.generate_private_key(ec.SECP256R1())
    as_pub = _raw_pub(eph)
    shared = eph.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_pub))
    ikm = _hkdf(_b64d(auth), shared, b"WebPush: info\x00" + ua_pub + as_pub, 32)
    salt = os.urandom(16)
    cek = _hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)
    body = AESGCM(cek).encrypt(nonce, payload + b"\x02", None)
    return salt + struct.pack(">IB", 4096, len(as_pub)) + as_pub + body


def send(sub: dict, data: dict) -> int:
    """Send one notification; returns the push service HTTP status (0 on network error)."""
    u = urlsplit(sub["endpoint"])
    token = jwt.encode({"aud": f"{u.scheme}://{u.netloc}", "exp": int(time.time()) + 12 * 3600, "sub": VAPID_SUB},
                       vapid_key(), algorithm="ES256")
    req = urllib.request.Request(sub["endpoint"], data=encrypt(json.dumps(data).encode(), sub["p256dh"], sub["auth"]),
                                 method="POST", headers={
                                     "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
                                     "TTL": "86400", "Urgency": "normal",
                                     "Authorization": f"vapid t={token}, k={public_key()}"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status
    except urllib.error.HTTPError as e:
        log.warning("push %s -> %s %s", u.netloc, e.code, e.read()[:200])
        return e.code
    except OSError as e:
        log.warning("push %s failed: %s", u.netloc, e)
        return 0


def save_subscription(conn, sub: dict) -> None:
    keys = sub.get("keys") or {}
    if not sub.get("endpoint") or not keys.get("p256dh") or not keys.get("auth"):
        raise ValueError("bad subscription")
    conn.execute("INSERT INTO push_subs (endpoint, p256dh, auth, created_at) VALUES (?,?,?,?) "
                 "ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth",
                 (sub["endpoint"], keys["p256dh"], keys["auth"], db.now_local().isoformat(timespec="seconds")))


def send_all(conn, data: dict) -> int:
    """Send to every subscription, drop the ones the push service says are gone; returns how many got it."""
    ok = 0
    for s in [dict(r) for r in conn.execute("SELECT * FROM push_subs")]:
        code = send(s, data)
        if code in (404, 410):
            conn.execute("DELETE FROM push_subs WHERE endpoint=?", (s["endpoint"],))
        elif 200 <= code < 300:
            ok += 1
    return ok


MEASURE_MSG = {"title": "Пора сделать замеры", "body": "Прошло две недели: запиши ОГ, ОТ и ОБ.", "tag": "measure",
               "url": "/?checkin=1"}


def remind_tick(conn) -> bool:
    """Measurement reminder: on the due day and once more two days later, after 10:00. True if sent."""
    now = db.now_local()
    due = db.measure_due(conn)
    today = now.date().isoformat()
    if not due or now.hour < REMIND_HOUR or today < due:
        return False
    days_over = (now.date() - date.fromisoformat(due)).days
    if days_over not in (0, 2) or db.kv_get(conn, "measure_reminded") == today:
        return False
    db.kv_set(conn, "measure_reminded", today)
    n = send_all(conn, MEASURE_MSG)
    log.info("measurement reminder sent to %d device(s)", n)
    return True


def reminder_loop(interval: int = 600) -> None:
    while True:
        try:
            with db.tx() as conn:
                remind_tick(conn)
        except Exception:  # never let the reminder thread die
            log.exception("reminder tick failed")
        time.sleep(interval)
