"""Print a ready-to-paste cloud-config with fresh secrets.

    python3 scripts/make_cloud_init.py [app-password]

Keep the printed values: APP_PASSWORD is the login for the phone app, MCP_PATH is the
secret part of the connector URL.
"""
from __future__ import annotations

import secrets
import sys
from pathlib import Path

template = (Path(__file__).resolve().parent.parent / "deploy" / "cloud-init.yaml").read_text(encoding="utf-8")
password = sys.argv[1] if len(sys.argv) > 1 else secrets.token_urlsafe(9)
values = {
    "REPLACE_APP_PASSWORD": password,
    "REPLACE_APP_COOKIE": secrets.token_urlsafe(32),
    "REPLACE_MCP_PATH": "/mcp/" + secrets.token_urlsafe(24),
}
out = template
for k, v in values.items():
    out = out.replace(k, v)
print(out)
print("# --- keep these ---", file=sys.stderr)
for k, v in values.items():
    print(f"# {k.removeprefix('REPLACE_')}={v}", file=sys.stderr)
