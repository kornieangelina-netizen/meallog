import importlib
import os
import struct
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class PushTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["DB_PATH"] = os.path.join(self.tmp.name, "t.db")
        import db
        importlib.reload(db)
        import push
        importlib.reload(push)
        self.db, self.push = db, push
        db.init_db()

    def tearDown(self):
        self.tmp.cleanup()

    def test_encrypt_roundtrip(self):
        p = self.push
        ua = ec.generate_private_key(ec.SECP256R1())
        ua_pub = p._raw_pub(ua)
        auth = os.urandom(16)
        blob = p.encrypt(b'{"title":"hi"}', p._b64e(ua_pub), p._b64e(auth))
        salt, rs, idlen = blob[:16], *struct.unpack(">IB", blob[16:21])
        as_pub = blob[21:21 + idlen]
        self.assertEqual(rs, 4096)
        shared = ua.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_pub))
        ikm = p._hkdf(auth, shared, b"WebPush: info\x00" + ua_pub + as_pub, 32)
        cek = p._hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
        nonce = p._hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)
        plain = AESGCM(cek).decrypt(nonce, blob[21 + idlen:], None)
        self.assertEqual(plain, b'{"title":"hi"}\x02')
        self.assertEqual(len(p._b64d(p.public_key())), 65)

    def test_measure_reminder_schedule(self):
        db, p = self.db, self.push
        with db.tx() as c:
            db.log_measurements(c, day="2026-10-15")
            self.assertEqual(db.measure_due(c), "2026-10-29")
            p.save_subscription(c, {"endpoint": "https://push.example/x", "keys": {"p256dh": "a", "auth": "b"}})
        sent = []

        def at(ts):
            with mock.patch.object(db, "now_local", return_value=datetime.fromisoformat(ts)), \
                 mock.patch.object(p, "send", side_effect=lambda s, d: sent.append(ts) or 201):
                with db.tx() as c:
                    return p.remind_tick(c)

        self.assertFalse(at("2026-10-28T12:00"))
        self.assertFalse(at("2026-10-29T09:50"))
        self.assertTrue(at("2026-10-29T10:05"))
        self.assertFalse(at("2026-10-29T15:00"))   # once a day
        self.assertFalse(at("2026-10-30T10:05"))
        self.assertTrue(at("2026-10-31T10:05"))    # one repeat two days later
        self.assertFalse(at("2026-11-01T10:05"))
        with db.tx() as c:
            db.log_measurements(c, waist=70, day="2026-11-01")
            self.assertEqual(db.measure_due(c), "2026-11-15")
        self.assertEqual(len(sent), 2)


if __name__ == "__main__":
    unittest.main()
