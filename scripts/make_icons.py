"""Generate PWA icons without Pillow: a rounded green square with a white ring."""
from __future__ import annotations

import struct
import zlib
from pathlib import Path

BG = (34, 139, 94)
FG = (255, 255, 255)


def png(size: int) -> bytes:
    rows = []
    c = size / 2
    r_out, r_in = size * 0.30, size * 0.20
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            dx, dy = x - c + 0.5, y - c + 0.5
            d = (dx * dx + dy * dy) ** 0.5
            px = FG if r_in <= d <= r_out else BG
            row += bytes(px)
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


if __name__ == "__main__":
    out = Path(__file__).resolve().parent.parent / "webapp"
    for s in (192, 512):
        (out / f"icon-{s}.png").write_bytes(png(s))
        print(f"wrote icon-{s}.png")
