"""SQLite storage for MealLog.

One file, four tables. Diary (meals) stores absolute values per eaten portion.
Catalogue (products) stores templates per portion or per 100 g, plus the fridge
counter. Recommendations are the daily plan. Goals and weight_log are tiny.
"""
from __future__ import annotations

import os
import re
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
# Diary entries are grouped into meals of the day. Any number of snacks is fine: "snack" is generic.
MEAL_SLOTS = ["breakfast", "lunch", "dinner", "snack"]
MEAL_SLOT_TITLES = {"breakfast": "Завтрак", "lunch": "Обед", "dinner": "Ужин", "snack": "Перекус"}
_NAME_TO_SLOT = {"завтрак": "breakfast", "обед": "lunch", "ужин": "dinner", "перекус": "snack",
                 "перекус 1": "snack", "перекус 2": "snack", "перекус/другое": "snack"}


def slot_for_hour(hour: int) -> str:
    if hour < 11:
        return "breakfast"
    if hour < 15:
        return "lunch"
    if 17 <= hour < 22:
        return "dinner"
    return "snack"


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

CREATE TABLE IF NOT EXISTS measurements (
    date TEXT PRIMARY KEY,
    chest REAL,
    waist REAL,
    hips REAL
);

CREATE TABLE IF NOT EXISTS recipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    product_id INTEGER,
    raw_grams REAL NOT NULL DEFAULT 0,
    cooked_grams REAL NOT NULL DEFAULT 0,
    portion_grams REAL,
    note TEXT DEFAULT '',
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS recipe_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipe_id INTEGER NOT NULL,
    product_id INTEGER,
    name TEXT NOT NULL,
    grams REAL NOT NULL DEFAULT 0,
    kcal REAL NOT NULL DEFAULT 0,
    protein REAL NOT NULL DEFAULT 0,
    fat REAL NOT NULL DEFAULT 0,
    carbs REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_recipe_items ON recipe_items(recipe_id);

CREATE TABLE IF NOT EXISTS push_subs (
    endpoint TEXT PRIMARY KEY,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT
);

CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""

# Columns added after the first release go here: (table, column, DDL type+default).
MIGRATIONS: list[tuple[str, str, str]] = [
    ("meals", "fridge_delta", "REAL NOT NULL DEFAULT 0"),
    ("products", "urgent", "INTEGER NOT NULL DEFAULT 0"),
    ("products", "lactose", "INTEGER NOT NULL DEFAULT 0"),
    ("products", "sugar", "INTEGER NOT NULL DEFAULT 0"),
    ("recommendations", "note", "TEXT DEFAULT ''"),
    ("meals", "slot", "TEXT"),
    ("products", "recipe_id", "INTEGER"),
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
        # backfill meal slots: by the entry name when it is a meal title (imported history), else by hour
        for r in conn.execute("SELECT id, name, logged_at FROM meals WHERE slot IS NULL").fetchall():
            slot = _NAME_TO_SLOT.get(norm_key(r["name"]))
            if not slot:
                try:
                    slot = slot_for_hour(datetime.fromisoformat(r["logged_at"]).hour)
                except ValueError:
                    slot = "snack"
            conn.execute("UPDATE meals SET slot=? WHERE id=?", (slot, r["id"]))


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
    """All products with last_eaten: the latest diary date this product was logged on (None if never)."""
    return _rows(conn.execute(
        "SELECT p.*, (SELECT MAX(m.meal_date) FROM meals m WHERE m.product_id = p.id) AS last_eaten "
        "FROM products p ORDER BY p.category, p.name"))


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
            grams = portions * (pg or 100)  # no portion weight: one portion = 100 g
        factor = grams / 100.0
        total_grams = grams
        portions = portions if portions is not None else grams / (pg or 100)
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
    slot: str | None = None,
) -> dict:
    dt = _parse_when(when)
    if slot not in MEAL_SLOTS:
        slot = _NAME_TO_SLOT.get(norm_key(name)) or slot_for_hour(dt.hour)
    cur = conn.execute(
        """INSERT INTO meals (logged_at, meal_date, name, description, grams, kcal, protein, fat, carbs,
           product_id, portions, fridge_delta, slot) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (dt.isoformat(timespec="seconds"), dt.date().isoformat(), name.strip(), description or "",
         grams, kcal, protein, fat, carbs, product_id, portions, fridge_delta, slot),
    )
    return get_meal(conn, cur.lastrowid)


IMPORT_TAG = "Из FatSecret"
_IMPORT_TIMES = {"breakfast": 9, "lunch": 13, "snack": 16, "dinner": 19}


def import_rows(conn, rows: list[dict], clear_imported: bool = False) -> dict:
    """Bulk-load diary rows exported from another app, ONE entry per food (name, amount, macros).

    Row keys: date, meal (Завтрак/Обед/Ужин/Перекус...), food, amount ('130 г', '1 кружка (240 мл)'),
    kcal, protein, fat, carbs. Entries are tagged in `description` so a re-import can replace them.
    clear_imported=True first deletes every previously imported entry (grouped or per-food)."""
    deleted = 0
    if clear_imported:
        deleted = conn.execute("DELETE FROM meals WHERE description LIKE ? OR description LIKE ?",
                               (IMPORT_TAG + ":%", "%· " + IMPORT_TAG)).rowcount
    seq: dict[tuple[str, str], int] = {}
    n = 0
    for r in rows:
        slot = _NAME_TO_SLOT.get(norm_key(str(r.get("meal", "")))) or "snack"
        k = (r["date"], slot)
        seq[k] = seq.get(k, 0) + 1
        minute = min(59, seq[k] - 1)
        amount = str(r.get("amount") or "").strip()
        m = re.fullmatch(r"([\d.,]+)\s*(г|мл)", amount)
        grams = float(m.group(1).replace(",", ".")) if m else None
        desc = f"{amount} · {IMPORT_TAG}" if amount else IMPORT_TAG
        log_meal(conn, str(r["food"]).strip(), float(r.get("kcal") or 0), float(r.get("protein") or 0),
                 float(r.get("fat") or 0), float(r.get("carbs") or 0), grams=grams, description=desc,
                 when=f"{r['date']}T{_IMPORT_TIMES[slot]:02d}:{minute:02d}", slot=slot)
        n += 1
    return {"imported": n, "deleted": deleted}


EXPORT_TABLES = ["meals", "products", "recipes", "recipe_items", "goals", "weight_log", "measurements", "kv"]


def export_data(conn, since: str | None = None) -> dict:
    """Every user table as plain rows, for a copy kept outside the server. since='YYYY-MM-DD' limits
    meals to that date and later (other tables are small and always exported whole)."""
    out = {"exported_at": now_local().isoformat(timespec="seconds"), "since": since}
    for t in EXPORT_TABLES:
        if t == "meals" and since:
            out[t] = _rows(conn.execute("SELECT * FROM meals WHERE meal_date >= ? ORDER BY logged_at", (since,)))
        else:
            out[t] = _rows(conn.execute(f"SELECT * FROM {t}"))
    return out


def update_meal(conn, meal_id: int, **fields) -> dict | None:
    """Edit a diary entry. Accepts name, description, grams, kcal, protein, fat, carbs, when, slot.

    Macros are stored as given (absolute for the eaten amount); the caller rescales them if it wants
    "same food, different weight". The fridge is not touched: a correction is not a second meal.
    """
    m = get_meal(conn, meal_id)
    if not m:
        return None
    sets, vals = [], []
    for k in ("name", "description", "grams", "kcal", "protein", "fat", "carbs"):
        if k in fields and fields[k] is not None:
            sets.append(f"{k}=?")
            vals.append(fields[k].strip() if isinstance(fields[k], str) else fields[k])
    if fields.get("slot") in MEAL_SLOTS:
        sets.append("slot=?")
        vals.append(fields["slot"])
    if fields.get("when"):
        dt = _parse_when(fields["when"])
        sets += ["logged_at=?", "meal_date=?"]
        vals += [dt.isoformat(timespec="seconds"), dt.date().isoformat()]
    if sets:
        conn.execute(f"UPDATE meals SET {', '.join(sets)} WHERE id=?", (*vals, meal_id))
    return get_meal(conn, meal_id)


def log_product(conn, product_id: int, portions: float | None = None, grams: float | None = None,
                when: str | None = None, note: str = "", slot: str | None = None) -> dict:
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
                    portions=vals["portions"], fridge_delta=deduct, slot=slot)


def get_meal(conn, meal_id: int) -> dict | None:
    return _row(conn.execute("SELECT * FROM meals WHERE id=?", (meal_id,)).fetchone())


def list_meals(conn, day: str | None = None) -> list[dict]:
    day = day or today()
    return _rows(conn.execute("SELECT * FROM meals WHERE meal_date=? ORDER BY logged_at", (day,)))


def recent_meals(conn, days: int = 21, limit: int = 40) -> list[dict]:
    """Distinct dishes eaten lately (by name + description), newest first, for the "repeat" picker."""
    since = (now_local().date() - timedelta(days=days)).isoformat()
    rows = _rows(conn.execute(
        """SELECT name, description, product_id, MAX(grams) grams, MAX(kcal) kcal, MAX(protein) protein, MAX(fat) fat,
                  MAX(carbs) carbs, MAX(logged_at) last, COUNT(*) n
           FROM meals WHERE meal_date >= ? GROUP BY name, COALESCE(description, '') ORDER BY last DESC LIMIT ?""",
        (since, limit)))
    return rows


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


def log_measurements(conn, chest: float | None = None, waist: float | None = None,
                     hips: float | None = None, day: str | None = None) -> dict:
    """Body measurements in cm (ОГ chest, ОТ waist, ОБ hips); omitted values keep what the date already has."""
    day = day or today()
    cur = _row(conn.execute("SELECT * FROM measurements WHERE date=?", (day,)).fetchone()) or {}
    row = {"date": day, "chest": chest if chest is not None else cur.get("chest"),
           "waist": waist if waist is not None else cur.get("waist"),
           "hips": hips if hips is not None else cur.get("hips")}
    conn.execute("INSERT INTO measurements (date, chest, waist, hips) VALUES (?,?,?,?) ON CONFLICT(date) DO UPDATE SET "
                 "chest=excluded.chest, waist=excluded.waist, hips=excluded.hips",
                 (day, row["chest"], row["waist"], row["hips"]))
    return row


MEASURE_EVERY = 14  # days between body measurements


def measure_due(conn) -> str | None:
    """Date the next measurements are due (last measurement + 14 days), None when there are none yet."""
    last = conn.execute("SELECT MAX(date) FROM measurements").fetchone()[0]
    if not last:
        return None
    return (date.fromisoformat(last) + timedelta(days=MEASURE_EVERY)).isoformat()


def kv_get(conn, key: str) -> str | None:
    r = conn.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
    return r[0] if r else None


def kv_set(conn, key: str, value: str) -> None:
    conn.execute("INSERT INTO kv (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                 (key, value))


def list_measurements(conn, days: int | None = 365) -> list[dict]:
    if days is None:
        return _rows(conn.execute("SELECT * FROM measurements ORDER BY date"))
    since = (now_local().date() - timedelta(days=days)).isoformat()
    return _rows(conn.execute("SELECT * FROM measurements WHERE date >= ? ORDER BY date", (since,)))


# --------------------------------------------------------------------------- #
# recipes: a dish cooked from ingredients, stored as a per-100-g product of the COOKED dish
# --------------------------------------------------------------------------- #

def _recipe_item_macros(conn, item: dict) -> dict:
    """Absolute macros of one ingredient line. A line with product_id and grams is computed from the
    catalogue; a manual line carries its own absolute kcal/protein/fat/carbs for its grams."""
    grams = float(item.get("grams") or 0)
    pid = item.get("product_id")
    if pid and not all(item.get(m) is not None for m in MACROS):
        p = get_product(conn, int(pid))
        if not p:
            raise ValueError(f"product {pid} not found")
        vals = macros_for(p, grams=grams) if grams else macros_for(p, portions=float(item.get("portions") or 1))
        return {"product_id": p["id"], "name": item.get("name") or p["name"], "grams": vals["grams"] or grams,
                **{m: vals[m] for m in MACROS}}
    return {"product_id": pid, "name": (item.get("name") or "").strip() or "Ингредиент", "grams": grams,
            **{m: round(float(item.get(m) or 0), 1) for m in MACROS}}


def save_recipe(conn, name: str, items: list[dict], cooked_grams: float | None = None,
                recipe_id: int | None = None, portion_grams: float | None = None, note: str = "",
                to_fridge: bool = False, deduct: bool = False) -> dict:
    """Create or update a recipe and its catalogue product (basis '100g' of the cooked dish).

    items: [{product_id?, name?, grams, kcal?, protein?, fat?, carbs?}] — absolute values per line.
    cooked_grams: weight after cooking (default: sum of raw grams). The product's per-100-g values are
    totals / cooked_grams, so logging N g of the dish is exact. to_fridge adds cooked_grams of the dish
    to the fridge; deduct removes the catalogue ingredients from the fridge (cooking consumes them).
    """
    lines = [_recipe_item_macros(conn, it) for it in items if it]
    raw = round(sum(l["grams"] for l in lines), 1)
    cooked = float(cooked_grams or raw or 0)
    if cooked <= 0:
        raise ValueError("нужен вес готового блюда")
    totals = {m: round(sum(l[m] for l in lines), 1) for m in MACROS}
    per100 = {m: round(totals[m] * 100 / cooked, 1) for m in MACROS}
    name = name.strip()
    now = now_local().isoformat(timespec="seconds")
    old = get_recipe(conn, recipe_id) if recipe_id else None
    if old:
        conn.execute("UPDATE recipes SET name=?, raw_grams=?, cooked_grams=?, portion_grams=?, note=?, updated_at=? WHERE id=?",
                     (name, raw, cooked, portion_grams, note, now, recipe_id))
        conn.execute("DELETE FROM recipe_items WHERE recipe_id=?", (recipe_id,))
        if old["product_id"] and old["name"] != name:
            conn.execute("UPDATE products SET name=?, name_key=? WHERE id=?", (name, norm_key(name), old["product_id"]))
    else:
        cur = conn.execute("INSERT INTO recipes (name, raw_grams, cooked_grams, portion_grams, note, updated_at) VALUES (?,?,?,?,?,?)",
                           (name, raw, cooked, portion_grams, note, now))
        recipe_id = cur.lastrowid
    for l in lines:
        conn.execute("INSERT INTO recipe_items (recipe_id, product_id, name, grams, kcal, protein, fat, carbs) VALUES (?,?,?,?,?,?,?,?)",
                     (recipe_id, l["product_id"], l["name"], l["grams"], l["kcal"], l["protein"], l["fat"], l["carbs"]))
    p = save_product(conn, name, basis="100g", kcal=per100["kcal"], protein=per100["protein"], fat=per100["fat"],
                     carbs=per100["carbs"], grams=portion_grams, category="рецепт",
                     fridge_add=cooked if to_fridge else 0)
    conn.execute("UPDATE products SET recipe_id=? WHERE id=?", (recipe_id, p["id"]))
    conn.execute("UPDATE recipes SET product_id=? WHERE id=?", (p["id"], recipe_id))
    if deduct:
        for l in lines:
            if not l["product_id"]:
                continue
            ing = get_product(conn, l["product_id"])
            if not ing or ing["id"] == p["id"]:
                continue
            qty = l["grams"] if ing["basis"] == "100g" else (l["grams"] / ing["grams"] if ing["grams"] else 0)
            if qty:
                adjust_fridge(conn, ing["id"], -min(qty, float(ing["fridge_qty"])))
    return get_recipe(conn, recipe_id)


def get_recipe(conn, recipe_id: int) -> dict | None:
    r = _row(conn.execute("SELECT * FROM recipes WHERE id=?", (recipe_id,)).fetchone())
    if not r:
        return None
    r["items"] = _rows(conn.execute("SELECT * FROM recipe_items WHERE recipe_id=? ORDER BY id", (recipe_id,)))
    r["totals"] = {m: round(sum(i[m] for i in r["items"]), 1) for m in MACROS}
    r["per100"] = {m: (round(r["totals"][m] * 100 / r["cooked_grams"], 1) if r["cooked_grams"] else 0) for m in MACROS}
    p = get_product(conn, r["product_id"]) if r["product_id"] else None
    r["fridge_qty"] = p["fridge_qty"] if p else 0
    return r


def list_recipes(conn) -> list[dict]:
    out = []
    for r in conn.execute("SELECT id FROM recipes ORDER BY updated_at DESC, id DESC"):
        out.append(get_recipe(conn, r["id"]))
    return out


def delete_recipe(conn, recipe_id: int) -> bool:
    r = get_recipe(conn, recipe_id)
    if not r:
        return False
    conn.execute("DELETE FROM recipe_items WHERE recipe_id=?", (recipe_id,))
    conn.execute("DELETE FROM recipes WHERE id=?", (recipe_id,))
    if r["product_id"]:
        conn.execute("UPDATE products SET recipe_id=NULL WHERE id=?", (r["product_id"],))
    return True


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

def first_meal_date(conn) -> str | None:
    r = conn.execute("SELECT MIN(meal_date) FROM meals").fetchone()
    return r[0] if r and r[0] else None


def day_totals(conn, start: str, end: str) -> list[dict]:
    """Per-day sums for a date range (calendar dots, month picker). Days without entries are omitted."""
    return _rows(conn.execute(
        """SELECT meal_date date, SUM(kcal) kcal, SUM(protein) protein, SUM(fat) fat, SUM(carbs) carbs, COUNT(*) n
           FROM meals WHERE meal_date BETWEEN ? AND ? GROUP BY meal_date ORDER BY meal_date""", (start, end)))


def analytics(conn, days: int | None = 30, start: str | None = None, end: str | None = None) -> dict:
    """Analytics for a window: either the last `days` days or an explicit start..end (inclusive).

    Returns a dense daily series, averages over logged days, per-weekday and per-hour averages for
    every nutrient, streak, top foods, weight and goals. Nothing is pre-selected by nutrient: the
    PWA filters client-side so switching a chip does not hit the server.
    """
    end_d = date.fromisoformat(end) if end else now_local().date()
    if start:
        start_d = date.fromisoformat(start)
    else:
        start_d = end_d - timedelta(days=(days or 30) - 1)
    if start_d > end_d:
        start_d, end_d = end_d, start_d
    s, e = start_d.isoformat(), end_d.isoformat()
    by_date = {r["date"]: r for r in day_totals(conn, s, e)}
    series = []
    d = start_d
    while d <= end_d:
        k = d.isoformat()
        r = by_date.get(k)
        series.append({"date": k, **({m: _r1(r[m]) for m in MACROS} if r else {m: 0 for m in MACROS}),
                       "n": r["n"] if r else 0})
        d += timedelta(days=1)

    logged = [x for x in series if x["n"]]
    avg = {m: (round(sum(x[m] for x in logged) / len(logged), 1) if logged else 0) for m in MACROS}

    # per weekday (0 = Monday): average over logged days of that weekday
    wd_sum = [{m: 0.0 for m in MACROS} for _ in range(7)]
    wd_n = [0] * 7
    for x in logged:
        i = date.fromisoformat(x["date"]).weekday()
        wd_n[i] += 1
        for m in MACROS:
            wd_sum[i][m] += x[m]
    weekday = [{m: (round(wd_sum[i][m] / wd_n[i], 1) if wd_n[i] else 0) for m in MACROS} | {"n": wd_n[i]}
               for i in range(7)]

    # per hour: average per logged day, so the profile does not scale with window length
    hours = [{m: 0.0 for m in MACROS} for _ in range(24)]
    for r in conn.execute("SELECT logged_at, kcal, protein, fat, carbs FROM meals WHERE meal_date BETWEEN ? AND ?",
                          (s, e)):
        try:
            h = datetime.fromisoformat(r["logged_at"]).hour
        except ValueError:
            continue
        for m in MACROS:
            hours[h][m] += float(r[m] or 0)
    nd = max(1, len(logged))
    hours = [{m: round(x[m] / nd, 1) for m in MACROS} for x in hours]

    # streak: consecutive days with at least one entry, ending today or yesterday
    streak = 0
    all_dates = {r[0] for r in conn.execute("SELECT DISTINCT meal_date FROM meals")}
    d = now_local().date()
    if d.isoformat() not in all_dates:
        d -= timedelta(days=1)
    while d.isoformat() in all_dates:
        streak += 1
        d -= timedelta(days=1)

    top = _rows(conn.execute(
        """SELECT name, COUNT(*) n, ROUND(SUM(kcal)) kcal, ROUND(SUM(protein)) protein, ROUND(SUM(fat)) fat,
                  ROUND(SUM(carbs)) carbs
           FROM meals WHERE meal_date BETWEEN ? AND ? AND name NOT IN ('Завтрак', 'Обед', 'Ужин', 'Перекус',
                 'Перекус 1', 'Перекус 2', 'Перекус/Другое')
           GROUP BY name ORDER BY n DESC, kcal DESC LIMIT 10""", (s, e)))
    weight = _rows(conn.execute("SELECT * FROM weight_log WHERE date BETWEEN ? AND ? ORDER BY date", (s, e)))
    measurements = _rows(conn.execute("SELECT * FROM measurements WHERE date BETWEEN ? AND ? ORDER BY date", (s, e)))
    return {"start": s, "end": e, "days": len(series), "series": series, "avg": avg, "logged_days": len(logged),
            "weekday": weekday, "hours": hours, "streak": streak, "top": top, "weight": weight,
            "measurements": measurements, "goals": get_goals(conn), "first_date": first_meal_date(conn)}
