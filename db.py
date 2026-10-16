"""SQLite storage for MealLog.

One file, four tables. Diary (meals) stores absolute values per eaten portion.
Catalogue (products) stores templates per portion or per 100 g, plus the fridge
counter. Recommendations are the daily plan. Goals and weight_log are tiny.
"""
from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

DB_PATH = os.environ.get("DB_PATH", os.path.join(os.path.dirname(__file__), "data", "meals.db"))
TZ = ZoneInfo(os.environ.get("TZ_NAME", "Europe/Moscow"))

SLOTS = ["breakfast", "snack1", "lunch", "snack2", "dinner"]
SLOT_TITLES = {
    "breakfast": "Завтрак",
    "snack1": "Перекус 1",
    "lunch": "Обед",
    "snack2": "Перекус 2",
    "dinner": "Ужин",
}
MACROS = ("kcal", "protein", "fat", "carbs")


def now_local() -> datetime:
    return datetime.now(TZ)


def today() -> str:
    return now_local().date().isoformat()


def norm_key(name: str) -> str:
    """Case-insensitive key that works for Cyrillic (SQLite NOCASE does not)."""
    return " ".join(name.casefold().split())


# --------------------------------------------------------------------------- #
# connection / schema
# --------------------------------------------------------------------------- #

SCHEMA = """
CREATE TABLE IF NOT EXISTS meals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    logged_at TEXT NOT NULL,
    meal_date TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    grams REAL,
    kcal REAL NOT NULL DEFAULT 0,
    protein REAL NOT NULL DEFAULT 0,
    fat REAL NOT NULL DEFAULT 0,
    carbs REAL NOT NULL DEFAULT 0,
    product_id INTEGER,
    portions REAL,
    fridge_delta REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_meals_date ON meals(meal_date);

CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    name_key TEXT NOT NULL,
    basis TEXT NOT NULL DEFAULT 'portion',
    kcal REAL NOT NULL DEFAULT 0,
    protein REAL NOT NULL DEFAULT 0,
    fat REAL NOT NULL DEFAULT 0,
    carbs REAL NOT NULL DEFAULT 0,
    grams REAL,
    category TEXT DEFAULT '',
    aliases TEXT DEFAULT '',
    fridge_qty REAL NOT NULL DEFAULT 0,
    urgent INTEGER NOT NULL DEFAULT 0,
    lactose INTEGER NOT NULL DEFAULT 0,
    sugar INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_products_key ON products(name_key);

CREATE TABLE IF NOT EXISTS recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rec_date TEXT NOT NULL,
    slot TEXT NOT NULL,
    product_id INTEGER NOT NULL,
    portions REAL NOT NULL DEFAULT 1,
    logged_meal_id INTEGER,
    fridge_delta REAL NOT NULL DEFAULT 0,
    note TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_recs_date ON recommendations(rec_date);

CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    kcal REAL NOT NULL DEFAULT 2000,
    protein REAL NOT NULL DEFAULT 150,
    fat REAL NOT NULL DEFAULT 70,
    carbs REAL NOT NULL DEFAULT 200
);
INSERT OR IGNORE INTO goals (id) VALUES (1);

CREATE TABLE IF NOT EXISTS weight_log (
    date TEXT PRIMARY KEY,
    kg REAL NOT NULL
);
"""

# Columns added after the first release go here: (table, column, DDL type+default).
MIGRATIONS: list[tuple[str, str, str]] = [
    ("meals", "fridge_delta", "REAL NOT NULL DEFAULT 0"),
    ("products", "urgent", "INTEGER NOT NULL DEFAULT 0"),
    ("products", "lactose", "INTEGER NOT NULL DEFAULT 0"),
    ("products", "sugar", "INTEGER NOT NULL DEFAULT 0"),
    ("recommendations", "note", "TEXT DEFAULT ''"),
]


def connect() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextmanager
def tx():
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    with tx() as conn:
        conn.executescript(SCHEMA)
        for table, column, ddl in MIGRATIONS:
            cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
            if column not in cols:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")


def _row(r: sqlite3.Row | None) -> dict | None:
    return dict(r) if r is not None else None


def _rows(rs) -> list[dict]:
    return [dict(r) for r in rs]


def _r1(x: float | None) -> float | None:
    return None if x is None else round(float(x), 1)


# --------------------------------------------------------------------------- #
# products / fridge
# --------------------------------------------------------------------------- #

def get_product(conn, product_id: int) -> dict | None:
    return _row(conn.execute("SELECT * FROM products WHERE id=?", (product_id,)).fetchone())


def find_product_by_name(conn, name: str) -> dict | None:
    return _row(conn.execute("SELECT * FROM products WHERE name_key=?", (norm_key(name),)).fetchone())


def search_products(conn, query: str, limit: int = 15) -> list[dict]:
    """Substring search over name and aliases, casefolded in Python (Cyrillic-safe)."""
    q = norm_key(query)
    words = q.split()
    out = []
    for r in conn.execute("SELECT * FROM products ORDER BY fridge_qty DESC, name"):
        hay = norm_key(r["name"] + " " + (r["aliases"] or ""))
        if not words or all(w in hay for w in words):
            out.append(dict(r))
            if len(out) >= limit:
                break
    return out


def save_product(
    conn,
    name: str,
    basis: str = "portion",
    kcal: float = 0,
    protein: float = 0,
    fat: float = 0,
    carbs: float = 0,
    grams: float | None = None,
    category: str = "",
    aliases: str = "",
    fridge_add: float = 0,
    lactose: bool | None = None,
    sugar: bool | None = None,
) -> dict:
    """Create or update a catalogue entry (matched by case-insensitive name)."""
    if basis not in ("portion", "100g"):
        raise ValueError("basis must be 'portion' or '100g'")
    name = " ".join(name.split())
    existing = find_product_by_name(conn, name)
    ts = now_local().isoformat(timespec="seconds")
    if existing:
        conn.execute(
            """UPDATE products SET basis=?, kcal=?, protein=?, fat=?, carbs=?, grams=?,
               category=COALESCE(NULLIF(?, ''), category), aliases=COALESCE(NULLIF(?, ''), aliases),
               fridge_qty=MAX(0, fridge_qty + ?),
               lactose=COALESCE(?, lactose), sugar=COALESCE(?, sugar), updated_at=?
               WHERE id=?""",
            (basis, kcal, protein, fat, carbs, grams, category, aliases, fridge_add,
             None if lactose is None else int(lactose), None if sugar is None else int(sugar),
             ts, existing["id"]),
        )
        return get_product(conn, existing["id"])
    cur = conn.execute(
        """INSERT INTO products (name, name_key, basis, kcal, protein, fat, carbs, grams, category,
           aliases, fridge_qty, lactose, sugar, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (name, norm_key(name), basis, kcal, protein, fat, carbs, grams, category, aliases,
         max(0.0, fridge_add), int(bool(lactose)), int(bool(sugar)), ts),
    )
    return get_product(conn, cur.lastrowid)


def delete_product(conn, product_id: int) -> bool:
    conn.execute("DELETE FROM recommendations WHERE product_id=? AND logged_meal_id IS NULL", (product_id,))
    return conn.execute("DELETE FROM products WHERE id=?", (product_id,)).rowcount > 0


def adjust_fridge(conn, product_id: int, delta: float) -> dict | None:
    conn.execute("UPDATE products SET fridge_qty=MAX(0, fridge_qty + ?) WHERE id=?", (delta, product_id))
    return get_product(conn, product_id)


def set_fridge(conn, product_id: int, qty: float) -> dict | None:
    conn.execute("UPDATE products SET fridge_qty=MAX(0, ?) WHERE id=?", (qty, product_id))
    return get_product(conn, product_id)


def set_product_flags(conn, product_id: int, urgent=None, lactose=None, sugar=None) -> dict | None:
    sets, vals = [], []
    for col, v in (("urgent", urgent), ("lactose", lactose), ("sugar", sugar)):
        if v is not None:
            sets.append(f"{col}=?")
            vals.append(int(bool(v)))
    if sets:
        vals.append(product_id)
        conn.execute(f"UPDATE products SET {', '.join(sets)} WHERE id=?", vals)
    return get_product(conn, product_id)


def list_products(conn) -> list[dict]:
    return _rows(conn.execute("SELECT * FROM products ORDER BY category, name"))


def list_fridge(conn) -> dict:
    items = _rows(conn.execute("SELECT * FROM products WHERE fridge_qty > 0 ORDER BY urgent DESC, category, name"))
    totals = {m: 0.0 for m in MACROS}
    for p in items:
        vals = macros_for(p, portions=p["fridge_qty"] if p["basis"] == "portion" else None,
                          grams=p["fridge_qty"] if p["basis"] == "100g" else None)
        for m in MACROS:
            totals[m] += vals[m]
    return {"items": items, "totals": {m: _r1(v) for m, v in totals.items()}}


def macros_for(product: dict, portions: float | None = None, grams: float | None = None) -> dict:
    """Absolute macros for a quantity of a catalogue product.

    portion-based: portions * per-portion values (grams -> portions via product.grams if known)
    100g-based:    grams/100 * per-100g values (portions -> grams via product.grams)
    """
    basis = product["basis"]
    pg = product.get("grams")
    if basis == "portion":
        if portions is None:
            if grams is None:
                portions = 1.0
            elif pg:
                portions = grams / pg
            else:
                raise ValueError("product has no portion weight; pass portions")
        factor = portions
        total_grams = portions * pg if pg else grams
    else:
        if grams is None:
            if portions is None:
                portions = 1.0
            if not pg:
                raise ValueError("product has no portion weight; pass grams")
            grams = portions * pg
        factor = grams / 100.0
        total_grams = grams
        portions = portions if portions is not None else (grams / pg if pg else None)
    out = {m: round(float(product[m]) * factor, 1) for m in MACROS}
    out["grams"] = _r1(total_grams)
    out["portions"] = _r1(portions)
    return out


# --------------------------------------------------------------------------- #
# meals (diary)
# --------------------------------------------------------------------------- #

def _parse_when(when: str | None) -> datetime:
    if not when:
        return now_local()
    dt = datetime.fromisoformat(when)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=TZ)
    return dt.astimezone(TZ)


def log_meal(
    conn,
    name: str,
    kcal: float,
    protein: float,
    fat: float,
    carbs: float,
    grams: float | None = None,
    description: str = "",
    when: str | None = None,
    product_id: int | None = None,
    portions: float | None = None,
    fridge_delta: float = 0,
) -> dict:
    dt = _parse_when(when)
    cur = conn.execute(
        """INSERT INTO meals (logged_at, meal_date, name, description, grams, kcal, protein, fat, carbs,
           product_id, portions, fridge_delta) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (dt.isoformat(timespec="seconds"), dt.date().isoformat(), name.strip(), description or "",
         grams, kcal, protein, fat, carbs, product_id, portions, fridge_delta),
    )
    return get_meal(conn, cur.lastrowid)


def log_product(conn, product_id: int, portions: float | None = None, grams: float | None = None,
                when: str | None = None, note: str = "") -> dict:
    """Log a catalogue product: recalc macros, write diary, deduct from fridge."""
    p = get_product(conn, product_id)
    if not p:
        raise ValueError(f"product {product_id} not found")
    vals = macros_for(p, portions=portions, grams=grams)
    deduct = vals["portions"] if p["basis"] == "portion" else vals["grams"]
    deduct = min(float(deduct or 0), float(p["fridge_qty"]))
    if deduct:
        adjust_fridge(conn, product_id, -deduct)
    # grams are shown separately, so only note the portion count when it is not a single portion
    desc = note or (f"{vals['portions']:g} порц." if p["basis"] == "portion" and vals["portions"] != 1 else "")
    return log_meal(conn, p["name"], vals["kcal"], vals["protein"], vals["fat"], vals["carbs"],
                    grams=vals["grams"], description=desc, when=when, product_id=product_id,
                    portions=vals["portions"], fridge_delta=deduct)


def get_meal(conn, meal_id: int) -> dict | None:
    return _row(conn.execute("SELECT * FROM meals WHERE id=?", (meal_id,)).fetchone())


def list_meals(conn, day: str | None = None) -> list[dict]:
    day = day or today()
    return _rows(conn.execute("SELECT * FROM meals WHERE meal_date=? ORDER BY logged_at", (day,)))


def delete_meal(conn, meal_id: int) -> bool:
    """Delete a diary entry, return its fridge deduction and untick its plan item."""
    m = get_meal(conn, meal_id)
    if not m:
        return False
    if m["product_id"] and m["fridge_delta"]:
        adjust_fridge(conn, m["product_id"], m["fridge_delta"])
    conn.execute("UPDATE recommendations SET logged_meal_id=NULL, fridge_delta=0 WHERE logged_meal_id=?", (meal_id,))
    conn.execute("DELETE FROM meals WHERE id=?", (meal_id,))
    return True


def day_summary(conn, day: str | None = None) -> dict:
    day = day or today()
    meals = list_meals(conn, day)
    totals = {m: round(sum(float(x[m]) for x in meals), 1) for m in MACROS}
    goals = get_goals(conn)
    left = {m: round(goals[m] - totals[m], 1) for m in MACROS}
    pct = {m: (round(100 * totals[m] / goals[m]) if goals[m] else 0) for m in MACROS}
    # "pace": share of the day's budget that should be consumed by now (07:00..22:00 window)
    pace = None
    if day == today():
        t = now_local()
        h = t.hour + t.minute / 60
        pace = round(min(1.0, max(0.0, (h - 7) / 15)), 2)
    return {"date": day, "meals": meals, "totals": totals, "goals": goals, "left": left,
            "percent": pct, "pace": pace, "count": len(meals)}


# --------------------------------------------------------------------------- #
# goals / weight
# --------------------------------------------------------------------------- #

def get_goals(conn) -> dict:
    g = _row(conn.execute("SELECT kcal, protein, fat, carbs FROM goals WHERE id=1").fetchone())
    return g or {"kcal": 2000, "protein": 150, "fat": 70, "carbs": 200}


def set_goals(conn, kcal=None, protein=None, fat=None, carbs=None) -> dict:
    g = get_goals(conn)
    new = {k: (v if v is not None else g[k]) for k, v in
           (("kcal", kcal), ("protein", protein), ("fat", fat), ("carbs", carbs))}
    conn.execute("UPDATE goals SET kcal=?, protein=?, fat=?, carbs=? WHERE id=1",
                 (new["kcal"], new["protein"], new["fat"], new["carbs"]))
    return new


def log_weight(conn, kg: float, day: str | None = None) -> dict:
    day = day or today()
    conn.execute("INSERT INTO weight_log (date, kg) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET kg=excluded.kg",
                 (day, kg))
    return {"date": day, "kg": kg}


def list_weight(conn, days: int = 90) -> list[dict]:
    since = (now_local().date() - timedelta(days=days)).isoformat()
    return _rows(conn.execute("SELECT * FROM weight_log WHERE date >= ? ORDER BY date", (since,)))


def weight_today(conn) -> dict | None:
    return _row(conn.execute("SELECT * FROM weight_log WHERE date=?", (today(),)).fetchone())


# --------------------------------------------------------------------------- #
# recommendations (daily plan)
# --------------------------------------------------------------------------- #

def list_recommendations(conn, day: str | None = None) -> list[dict]:
    day = day or today()
    rows = _rows(conn.execute(
        """SELECT r.*, p.name, p.basis, p.kcal AS p_kcal, p.protein AS p_protein, p.fat AS p_fat,
                  p.carbs AS p_carbs, p.grams AS p_grams, p.fridge_qty, p.lactose, p.sugar
           FROM recommendations r JOIN products p ON p.id = r.product_id
           WHERE r.rec_date=?""", (day,)))
    order = {s: i for i, s in enumerate(SLOTS)}
    rows.sort(key=lambda r: (order.get(r["slot"], 99), r["id"]))
    for r in rows:
        p = {"basis": r["basis"], "grams": r["p_grams"], "kcal": r["p_kcal"], "protein": r["p_protein"],
             "fat": r["p_fat"], "carbs": r["p_carbs"]}
        vals = macros_for(p, portions=r["portions"])
        r.update({m: vals[m] for m in MACROS})
        r["grams"] = vals["grams"]
        r["done"] = r["logged_meal_id"] is not None
        r["slot_title"] = SLOT_TITLES.get(r["slot"], r["slot"])
    return rows


def add_recommendation(conn, product_id: int, slot: str, portions: float = 1, day: str | None = None,
                       note: str = "") -> dict:
    if slot not in SLOTS:
        raise ValueError(f"slot must be one of {SLOTS}")
    if not get_product(conn, product_id):
        raise ValueError(f"product {product_id} not found")
    day = day or today()
    cur = conn.execute(
        "INSERT INTO recommendations (rec_date, slot, product_id, portions, note) VALUES (?,?,?,?,?)",
        (day, slot, product_id, portions, note))
    return next(r for r in list_recommendations(conn, day) if r["id"] == cur.lastrowid)


def clear_recommendations(conn, day: str | None = None, keep_done: bool = True) -> int:
    day = day or today()
    if keep_done:
        return conn.execute("DELETE FROM recommendations WHERE rec_date=? AND logged_meal_id IS NULL", (day,)).rowcount
    return conn.execute("DELETE FROM recommendations WHERE rec_date=?", (day,)).rowcount


def toggle_recommendation(conn, rec_id: int) -> dict | None:
    """Tick = log the recommended amount and deduct it; untick = undo exactly that."""
    r = _row(conn.execute("SELECT * FROM recommendations WHERE id=?", (rec_id,)).fetchone())
    if not r:
        return None
    if r["logged_meal_id"] is None:
        when = None
        if r["rec_date"] != today():
            when = f"{r['rec_date']}T12:00:00"
        meal = log_product(conn, r["product_id"], portions=r["portions"], when=when,
                           note=f"План: {SLOT_TITLES.get(r['slot'], r['slot'])}")
        conn.execute("UPDATE recommendations SET logged_meal_id=?, fridge_delta=? WHERE id=?",
                     (meal["id"], meal["fridge_delta"], rec_id))
    else:
        delete_meal(conn, r["logged_meal_id"])  # also resets logged_meal_id / fridge_delta
    return next(x for x in list_recommendations(conn, r["rec_date"]) if x["id"] == rec_id)


# --------------------------------------------------------------------------- #
# analytics
# --------------------------------------------------------------------------- #

def analytics(conn, days: int = 30) -> dict:
    end = now_local().date()
    start = end - timedelta(days=days - 1)
    rows = _rows(conn.execute(
        """SELECT meal_date, SUM(kcal) kcal, SUM(protein) protein, SUM(fat) fat, SUM(carbs) carbs, COUNT(*) n
           FROM meals WHERE meal_date BETWEEN ? AND ? GROUP BY meal_date ORDER BY meal_date""",
        (start.isoformat(), end.isoformat())))
    by_date = {r["meal_date"]: r for r in rows}
    series = []
    d = start
    while d <= end:
        k = d.isoformat()
        r = by_date.get(k)
        series.append({"date": k, **({m: _r1(r[m]) for m in MACROS} if r else {m: 0 for m in MACROS}),
                       "n": r["n"] if r else 0})
        d += timedelta(days=1)

    logged_days = [s for s in series if s["n"]]
    avg = {m: (round(sum(s[m] for s in logged_days) / len(logged_days), 1) if logged_days else 0) for m in MACROS}

    # streak: consecutive days with at least one entry, ending today or yesterday
    streak = 0
    d = end
    all_dates = {r[0] for r in conn.execute("SELECT DISTINCT meal_date FROM meals")}
    if end.isoformat() not in all_dates:
        d = end - timedelta(days=1)
    while d.isoformat() in all_dates:
        streak += 1
        d -= timedelta(days=1)

    hours = [0.0] * 24
    for r in conn.execute("SELECT logged_at, kcal FROM meals WHERE meal_date BETWEEN ? AND ?",
                          (start.isoformat(), end.isoformat())):
        try:
            hours[datetime.fromisoformat(r["logged_at"]).hour] += float(r["kcal"])
        except ValueError:
            pass
    top = _rows(conn.execute(
        """SELECT name, COUNT(*) n, SUM(kcal) kcal FROM meals WHERE meal_date BETWEEN ? AND ?
           GROUP BY name ORDER BY n DESC, kcal DESC LIMIT 10""", (start.isoformat(), end.isoformat())))
    return {"days": days, "series": series, "avg": avg, "streak": streak,
            "hours": [round(h) for h in hours], "top": top,
            "weight": list_weight(conn, days), "goals": get_goals(conn)}
