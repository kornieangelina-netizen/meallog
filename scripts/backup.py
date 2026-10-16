"""Consistent SQLite backup via the online backup API (never cp a live WAL database)."""
from __future__ import annotations

import os
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db  # noqa: E402

KEEP = int(os.environ.get("BACKUP_KEEP", "30"))


def main() -> None:
    backup_dir = Path(os.environ.get("BACKUP_DIR", Path(db.DB_PATH).parent.parent / "backup"))
    backup_dir.mkdir(parents=True, exist_ok=True)
    target = backup_dir / f"meals-{datetime.now().strftime('%Y%m%d-%H%M%S')}.db"
    src = sqlite3.connect(db.DB_PATH)
    dst = sqlite3.connect(target)
    with dst:
        src.backup(dst)
    dst.close()
    src.close()
    print(f"backup written: {target}")
    old = sorted(backup_dir.glob("meals-*.db"))[:-KEEP]
    for f in old:
        f.unlink()
        print(f"removed old backup: {f}")


if __name__ == "__main__":
    main()
