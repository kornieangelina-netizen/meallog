"""MealLog server: MCP connector for Claude + REST/static for the PWA.

One process, one SQLite file.
  /mcp/<secret>   Streamable HTTP MCP endpoint (Claude custom connector)
  /api/*          REST for the PWA, protected by a cookie session
  /login          password form
  /               PWA static files
"""
from __future__ import annotations

import hmac
import logging
import os
from pathlib import Path

import uvicorn
from mcp.server.mcpserver import MCPServer
from mcp.server.transport_security import TransportSecuritySettings
from starlette.requests import Request
from starlette.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response

import db
import push

log = logging.getLogger("meallog")

HOST = os.environ.get("MCP_HOST", "127.0.0.1")
PORT = int(os.environ.get("MCP_PORT", "8010"))
MCP_PATH = os.environ.get("MCP_PATH", "/mcp")
APP_PASSWORD = os.environ.get("APP_PASSWORD", "")
APP_COOKIE = os.environ.get("APP_COOKIE", "")
COOKIE_NAME = "meallog_session"
COOKIE_MAX_AGE = 365 * 24 * 3600
WEBAPP_DIR = Path(__file__).parent / "webapp"
PUBLIC_FILES = {
    "app.js", "styles.css", "service-worker.js", "manifest.webmanifest",
    "icon-192.png", "icon-512.png", "icon.svg",
}

USER_RULES = (Path(__file__).parent / "rules.md").read_text(encoding="utf-8") \
    if (Path(__file__).parent / "rules.md").exists() else ""

INSTRUCTIONS = f"""Ты ведёшь личный дневник питания пользователя (КБЖУ: калории, белки, жиры, углеводы).
Правила работы с инструментами:
1. Фото еды, этикетки или текст про еду БЕЗ подписи означает «уже съел». Сначала вызови find_products,
   чтобы взять известные КБЖУ из справочника, и только если позиции нет, оцени КБЖУ сам и вызови log_meal.
   Если позиция найдена, вызови log_product с количеством порций или граммов.
2. Подпись «в холодильник», «купил», «привезли» означает «ещё не съел»: только save_product с fridge_add,
   в дневник ничего не писать. Укажи shelf: home (приготовила сама), delivery (готовая еда из доставки),
   ready (можно съесть сразу), cook (продукты для готовки).
3. Никогда не выдумывай КБЖУ для позиций, которые есть в справочнике. Для новых блюд оценивай честно
   и указывай примерный вес.
4. Значения в log_meal всегда на съеденную порцию целиком, не на 100 г.
5. После записи ответь одной строкой: что записано, ккал и Б/Ж/У, и сколько осталось до цели за день.
6. Если пользователь ел не сейчас, передай when в формате ISO (например 2026-10-16T09:30).
7. Приём пищи (slot): breakfast | lunch | dinner | snack. Если пользователь сказал «на завтрак», «на ужин»,
   передай slot; иначе он определится по времени. Перекусов в день может быть сколько угодно.
8. Рецепт («приготовила ...», «сварила ... из ...») сохраняй через save_recipe: ингредиенты с граммами и
   вес готового блюда. Это создаёт позицию справочника «на 100 г готового», из неё потом логируют граммы.
{USER_RULES}"""

mcp = MCPServer("MealLog", instructions=INSTRUCTIONS)


# --------------------------------------------------------------------------- #
# MCP tools (docstrings are what Claude reads)
# --------------------------------------------------------------------------- #

def _public_product(p: dict) -> dict:
    keys = ("id", "name", "basis", "kcal", "protein", "fat", "carbs", "grams", "category",
            "aliases", "fridge_qty", "urgent", "lactose", "sugar")
    return {**{k: p.get(k) for k in keys}, "shelf": db.shelf_of(p)}


def _public_meal(m: dict) -> dict:
    keys = ("id", "logged_at", "meal_date", "slot", "name", "description", "grams", "kcal", "protein", "fat", "carbs")
    return {k: m.get(k) for k in keys}


@mcp.tool()
def find_products(query: str) -> dict:
    """Поиск по справочнику продуктов и блюд (по названию и синонимам).

    ВЫЗЫВАЙ ПЕРВЫМ, когда пользователь что-то съел: если позиция есть, бери её КБЖУ, а не выдумывай.
    Возвращает список с id, basis ('portion' = значения на порцию, '100g' = на 100 г), КБЖУ,
    весом порции (grams) и остатком в холодильнике (fridge_qty).
    """
    with db.tx() as conn:
        items = [_public_product(p) for p in db.search_products(conn, query)]
    return {"count": len(items), "products": items}


@mcp.tool()
def log_product(product_id: int, portions: float | None = None, grams: float | None = None,
                when: str | None = None, slot: str | None = None) -> dict:
    """Записать приём пищи из справочника и списать его из холодильника.

    Передай либо portions (число порций), либо grams (граммы). КБЖУ пересчитаются по basis продукта.
    when: ISO дата-время, если ели не сейчас (например '2026-10-16T13:00').
    slot: breakfast | lunch | dinner | snack (необязательно, иначе по времени). Возвращает запись и итоги дня.
    """
    with db.tx() as conn:
        meal = db.log_product(conn, product_id, portions=portions, grams=grams, when=when, slot=slot)
        summary = db.day_summary(conn, meal["meal_date"])
    return {"meal": _public_meal(meal), "day_totals": summary["totals"], "left_to_goal": summary["left"]}


@mcp.tool()
def log_meal(name: str, kcal: float, protein: float, fat: float, carbs: float,
             grams: float | None = None, description: str = "", when: str | None = None,
             slot: str | None = None) -> dict:
    """Записать приём пищи «с нуля», когда позиции нет в справочнике (КБЖУ оценены по фото или тексту).

    Все значения НА СЪЕДЕННУЮ ПОРЦИЮ ЦЕЛИКОМ, не на 100 г. grams: примерный вес порции.
    description: состав блюда подробно (что именно и сколько). when: ISO дата-время, если ели не сейчас.
    slot: breakfast | lunch | dinner | snack (необязательно, иначе по времени). Возвращает запись и итоги дня.
    """
    with db.tx() as conn:
        meal = db.log_meal(conn, name, kcal, protein, fat, carbs, grams=grams, description=description, when=when,
                           slot=slot)
        summary = db.day_summary(conn, meal["meal_date"])
    return {"meal": _public_meal(meal), "day_totals": summary["totals"], "left_to_goal": summary["left"]}


@mcp.tool()
def save_product(name: str, kcal: float, protein: float, fat: float, carbs: float,
                 basis: str = "portion", grams: float | None = None, category: str = "",
                 aliases: str = "", fridge_add: float = 0,
                 lactose: bool | None = None, sugar: bool | None = None, shelf: str | None = None) -> dict:
    """Создать или обновить позицию справочника (по названию, без дублей). В дневник НЕ пишет.

    basis: 'portion' (КБЖУ на одну порцию/штуку, grams = вес порции) или '100g' (КБЖУ на 100 г).
    fridge_add: сколько добавить в холодильник (штук для 'portion', граммов для '100g').
    category: например 'доставка', 'спортпит', 'молочное', 'мясо'. aliases: синонимы через запятую.
    lactose/sugar: флаги состава (лактоза, добавленный сахар). Для таблицы доставки вызывай по одной позиции.
    shelf: полка холодильника. 'home' — приготовила сама, 'delivery' — готовая еда из доставки,
    'ready' — можно съесть сразу (молоко, снеки, спортпит), 'cook' — продукты для готовки (сырое мясо, крупы,
    овощи, мука, яйца). Сырые продукты из заказа продуктов клади в 'cook'.
    """
    with db.tx() as conn:
        p = db.save_product(conn, name, basis=basis, kcal=kcal, protein=protein, fat=fat, carbs=carbs,
                            grams=grams, category=category, aliases=aliases, fridge_add=fridge_add,
                            lactose=lactose, sugar=sugar, shelf=shelf)
    return {"product": _public_product(p)}


@mcp.tool()
def list_fridge() -> dict:
    """Что есть в наличии (холодильник): позиции с остатками и суммарным КБЖУ всего, что лежит."""
    with db.tx() as conn:
        f = db.list_fridge(conn)
    return {"items": [_public_product(p) for p in f["items"]], "totals": f["totals"]}


@mcp.tool()
def day_summary(day: str | None = None) -> dict:
    """Итоги дня: съедено, цели, остаток до цели, проценты. day: 'YYYY-MM-DD', по умолчанию сегодня."""
    with db.tx() as conn:
        s = db.day_summary(conn, day)
    return {"date": s["date"], "totals": s["totals"], "goals": s["goals"], "left": s["left"],
            "percent": s["percent"], "meals": [_public_meal(m) for m in s["meals"]]}


@mcp.tool()
def list_meals(day: str | None = None) -> dict:
    """Список записей дневника за день с их id (для удаления). day: 'YYYY-MM-DD', по умолчанию сегодня."""
    with db.tx() as conn:
        meals = db.list_meals(conn, day)
    return {"count": len(meals), "meals": [_public_meal(m) for m in meals]}


@mcp.tool()
def update_meal(meal_id: int, name: str | None = None, grams: float | None = None, kcal: float | None = None,
                protein: float | None = None, fat: float | None = None, carbs: float | None = None,
                description: str | None = None, when: str | None = None, slot: str | None = None) -> dict:
    """Исправить запись дневника по id: название, вес, КБЖУ (абсолютные на порцию), состав, время, приём (slot).

    Передавай только то, что меняется. Холодильник не трогается.
    """
    with db.tx() as conn:
        m = db.update_meal(conn, meal_id, name=name, grams=grams, kcal=kcal, protein=protein, fat=fat, carbs=carbs,
                           description=description, when=when, slot=slot)
    return {"meal": _public_meal(m) if m else None}


@mcp.tool()
def save_recipe(name: str, items: list[dict], cooked_grams: float, portion_grams: float | None = None,
                to_fridge: bool = False, deduct: bool = False, recipe_id: int | None = None,
                kind: str = "dish") -> dict:
    """Сохранить рецепт (блюдо из ингредиентов) и создать позицию справочника «на 100 г ГОТОВОГО блюда».

    items: список ингредиентов. Каждый: либо {"product_id": id, "grams": г} (из справочника),
    либо {"name": ..., "grams": г, "kcal": .., "protein": .., "fat": .., "carbs": ..} с КБЖУ НА ЭТИ ГРАММЫ.
    У ингредиента может быть "note" (например «сырой вес»).
    cooked_grams: вес готового блюда после готовки (обязательно). portion_grams: обычная порция, г.
    to_fridge: положить готовое блюдо в холодильник (cooked_grams г). deduct: списать ингредиенты из холодильника.
    kind: "dish" — готовое блюдо, "base" — заготовка для блюд (блины, запечённая курица, отварная крупа).
    Потом съеденное логируется через log_product(product_id, grams=...).
    """
    with db.tx() as conn:
        r = db.save_recipe(conn, name, items, cooked_grams=cooked_grams, recipe_id=recipe_id,
                           portion_grams=portion_grams, to_fridge=to_fridge, deduct=deduct, kind=kind)
    return {"recipe": r}


@mcp.tool()
def list_recipes() -> dict:
    """Сохранённые рецепты с ингредиентами, итогами и КБЖУ на 100 г готового блюда."""
    with db.tx() as conn:
        rs = db.list_recipes(conn)
    return {"count": len(rs), "recipes": rs}


@mcp.tool()
def log_measurements(chest: float | None = None, waist: float | None = None, hips: float | None = None,
                     day: str | None = None) -> dict:
    """Записать объёмы в см: chest = ОГ (грудь), waist = ОТ (талия), hips = ОБ (бёдра). day: 'YYYY-MM-DD'."""
    with db.tx() as conn:
        m = db.log_measurements(conn, chest=chest, waist=waist, hips=hips, day=day)
    return {"measurements": m}


@mcp.tool()
def import_meals(rows: list[dict] | None = None, csv_text: str | None = None, clear_imported: bool = False) -> dict:
    """Массовый импорт истории дневника, по одной записи на блюдо. rows: [{date, meal, food, amount, kcal,
    protein, fat, carbs}] или csv_text: CSV с заголовком date,meal,food,amount,kcal,fat,carbs,protein.
    clear_imported=True сначала удаляет все ранее импортированные записи. Возвращает число записей и
    сумму ккал по месяцам для сверки."""
    import csv
    import io

    data = list(rows or [])
    if csv_text:
        data += list(csv.DictReader(io.StringIO(csv_text.strip())))
    with db.tx() as conn:
        r = db.import_rows(conn, data, clear_imported=clear_imported)
    by_month: dict[str, dict] = {}
    for x in data:
        m = by_month.setdefault(str(x["date"])[:7], {"rows": 0, "kcal": 0.0})
        m["rows"] += 1
        m["kcal"] += float(x.get("kcal") or 0)
    r["months"] = {k: {"rows": v["rows"], "kcal": round(v["kcal"])} for k, v in sorted(by_month.items())}
    return r


@mcp.tool()
def export_data(since: str | None = None) -> dict:
    """Резервная копия всех данных (дневник, справочник, рецепты, цели, вес, замеры) одним JSON.
    since: 'YYYY-MM-DD', тогда дневник только с этой даты; без since — всё целиком."""
    with db.tx() as conn:
        return db.export_data(conn, since)


@mcp.tool()
def delete_meal(meal_id: int) -> dict:
    """Удалить ошибочную запись дневника по id (вернёт списанное в холодильник и снимет галочку в плане)."""
    with db.tx() as conn:
        ok = db.delete_meal(conn, meal_id)
    return {"deleted": ok, "meal_id": meal_id}


@mcp.tool()
def add_recommendation(product_id: int, slot: str, portions: float = 1, day: str | None = None,
                       note: str = "") -> dict:
    """Добавить позицию в план на день. slot: breakfast | snack1 | lunch | snack2 | dinner."""
    with db.tx() as conn:
        r = db.add_recommendation(conn, product_id, slot, portions=portions, day=day, note=note)
    return {"recommendation": r}


@mcp.tool()
def clear_recommendations(day: str | None = None) -> dict:
    """Очистить план на день (отмеченные галочкой позиции остаются)."""
    with db.tx() as conn:
        n = db.clear_recommendations(conn, day)
    return {"removed": n}


@mcp.tool()
def list_recommendations(day: str | None = None) -> dict:
    """План питания на день по слотам с отметками, что уже съедено."""
    with db.tx() as conn:
        recs = db.list_recommendations(conn, day)
    return {"count": len(recs), "plan": [
        {k: r.get(k) for k in ("id", "slot", "slot_title", "name", "portions", "kcal", "protein", "fat",
                               "carbs", "done", "note")} for r in recs]}


@mcp.tool()
def set_product_flags(product_id: int, urgent: bool | None = None, lactose: bool | None = None,
                      sugar: bool | None = None) -> dict:
    """Флаги позиции справочника: urgent (срочно съесть), lactose (лактоза), sugar (добавленный сахар)."""
    with db.tx() as conn:
        p = db.set_product_flags(conn, product_id, urgent=urgent, lactose=lactose, sugar=sugar)
    return {"product": _public_product(p) if p else None}


@mcp.tool()
def set_fridge(product_id: int, qty: float) -> dict:
    """Выставить остаток позиции в холодильнике (штук для 'portion', граммов для '100g')."""
    with db.tx() as conn:
        p = db.set_fridge(conn, product_id, qty)
    return {"product": _public_product(p) if p else None}


@mcp.tool()
def get_goals() -> dict:
    """Текущие цели по КБЖУ на день и последний записанный вес."""
    with db.tx() as conn:
        g = db.get_goals(conn)
        w = db.list_weight(conn, 30)
    return {"goals": g, "last_weight": w[-1] if w else None}


@mcp.tool()
def set_goals(kcal: float | None = None, protein: float | None = None, fat: float | None = None,
              carbs: float | None = None) -> dict:
    """Изменить цели по КБЖУ на день (передавай только то, что меняется)."""
    with db.tx() as conn:
        g = db.set_goals(conn, kcal=kcal, protein=protein, fat=fat, carbs=carbs)
    return {"goals": g}


@mcp.tool()
def log_weight(kg: float, day: str | None = None) -> dict:
    """Записать вес в килограммах. day: 'YYYY-MM-DD', по умолчанию сегодня."""
    with db.tx() as conn:
        w = db.log_weight(conn, kg, day)
    return {"weight": w}


# --------------------------------------------------------------------------- #
# REST for the PWA
# --------------------------------------------------------------------------- #

def _authed(request: Request) -> bool:
    if not APP_COOKIE:
        return True  # dev mode without a cookie secret
    got = request.cookies.get(COOKIE_NAME, "")
    return bool(got) and hmac.compare_digest(got, APP_COOKIE)


def _deny() -> JSONResponse:
    return JSONResponse({"error": "unauthorized"}, status_code=401)


LOGIN_HTML = """<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>MealLog</title><link rel="stylesheet" href="/styles.css"></head>
<body class="login"><form method="post" action="/login" class="login-box">
<h1>MealLog</h1><p>Введите пароль</p>
<input type="password" name="password" autofocus autocomplete="current-password" placeholder="Пароль">
<button type="submit">Войти</button>{error}</form></body></html>"""


@mcp.custom_route("/login", methods=["GET", "POST"])
async def login(request: Request) -> Response:
    if request.method == "GET":
        if _authed(request) and APP_COOKIE:
            return RedirectResponse("/", status_code=303)
        return HTMLResponse(LOGIN_HTML.format(error=""))
    form = await request.form()
    pw = str(form.get("password", ""))
    if APP_PASSWORD and hmac.compare_digest(pw, APP_PASSWORD):
        resp = RedirectResponse("/", status_code=303)
        resp.set_cookie(COOKIE_NAME, APP_COOKIE, max_age=COOKIE_MAX_AGE, httponly=True,
                        secure=request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https",
                        samesite="lax", path="/")
        return resp
    return HTMLResponse(LOGIN_HTML.format(error='<p class="error">Неверный пароль</p>'), status_code=401)


@mcp.custom_route("/", methods=["GET"])
async def index(request: Request) -> Response:
    if not _authed(request):
        return RedirectResponse("/login", status_code=303)
    return FileResponse(WEBAPP_DIR / "index.html", headers={"Cache-Control": "no-cache"})


@mcp.custom_route("/{filename}", methods=["GET"])
async def static_file(request: Request) -> Response:
    name = request.path_params["filename"]
    if name not in PUBLIC_FILES:
        return Response("not found", status_code=404)
    headers = {"Cache-Control": "no-cache"} if name == "service-worker.js" else {"Cache-Control": "max-age=3600"}
    return FileResponse(WEBAPP_DIR / name, headers=headers)


def api(path: str, methods: list[str]):
    """Register an authed JSON endpoint; handler gets (request, conn, body) and returns a JSON-able value."""
    def deco(fn):
        async def handler(request: Request) -> Response:
            if not _authed(request):
                return _deny()
            body = {}
            if request.method in ("POST", "PUT", "PATCH"):
                try:
                    body = await request.json()
                except Exception:
                    body = {}
            try:
                with db.tx() as conn:
                    result = fn(request, conn, body)
                return JSONResponse(result)
            except ValueError as e:
                return JSONResponse({"error": str(e)}, status_code=400)
        mcp.custom_route(path, methods=methods, name=fn.__name__)(handler)
        return fn
    return deco


def _num(v, default=None):
    if v is None or v == "":
        return default
    return float(v)


@api("/api/day", ["GET"])
def api_day(request, conn, body):
    return db.day_summary(conn, request.query_params.get("date"))


@api("/api/meals/recent", ["GET"])
def api_recent_meals(request, conn, body):
    return {"meals": db.recent_meals(conn)}


@api("/api/meals", ["POST"])
def api_add_meal(request, conn, body):
    if body.get("product_id"):
        m = db.log_product(conn, int(body["product_id"]), portions=_num(body.get("portions")),
                           grams=_num(body.get("grams")), when=body.get("when"), slot=body.get("slot"))
    else:
        m = db.log_meal(conn, body["name"], _num(body.get("kcal"), 0), _num(body.get("protein"), 0),
                        _num(body.get("fat"), 0), _num(body.get("carbs"), 0), grams=_num(body.get("grams")),
                        description=body.get("description", ""), when=body.get("when"), slot=body.get("slot"))
    return {"meal": m, "day": db.day_summary(conn, m["meal_date"])}


@api("/api/meals/{meal_id:int}", ["DELETE"])
def api_delete_meal(request, conn, body):
    return {"deleted": db.delete_meal(conn, request.path_params["meal_id"])}


@api("/api/meals/{meal_id:int}", ["PUT"])
def api_update_meal(request, conn, body):
    m = db.update_meal(conn, request.path_params["meal_id"], name=body.get("name"), description=body.get("description"),
                       grams=_num(body.get("grams")), kcal=_num(body.get("kcal")), protein=_num(body.get("protein")),
                       fat=_num(body.get("fat")), carbs=_num(body.get("carbs")), when=body.get("when"),
                       slot=body.get("slot"))
    if m is None:
        raise ValueError("meal not found")
    return {"meal": m, "day": db.day_summary(conn, m["meal_date"])}


@api("/api/recipes", ["GET"])
def api_recipes(request, conn, body):
    return {"recipes": db.list_recipes(conn)}


@api("/api/recipes", ["POST"])
def api_save_recipe(request, conn, body):
    r = db.save_recipe(conn, body["name"], body.get("items") or [], cooked_grams=_num(body.get("cooked_grams")),
                       recipe_id=body.get("id"), portion_grams=_num(body.get("portion_grams")),
                       note=body.get("note", ""), to_fridge=bool(body.get("to_fridge")), deduct=bool(body.get("deduct")),
                       kind=body.get("kind"))
    return {"recipe": r}


@api("/api/recipes/{rid:int}", ["DELETE"])
def api_delete_recipe(request, conn, body):
    return {"deleted": db.delete_recipe(conn, request.path_params["rid"])}


@api("/api/measurements", ["POST"])
def api_measurements(request, conn, body):
    return {"measurements": db.log_measurements(conn, chest=_num(body.get("chest")), waist=_num(body.get("waist")),
                                                hips=_num(body.get("hips")), day=body.get("date"))}


@api("/api/push/key", ["GET"])
def api_push_key(request, conn, body):
    return {"key": push.public_key(), "count": conn.execute("SELECT COUNT(*) FROM push_subs").fetchone()[0]}


@api("/api/push/subscribe", ["POST"])
def api_push_subscribe(request, conn, body):
    push.save_subscription(conn, body)
    return {"ok": True}


@api("/api/push/test", ["POST"])
def api_push_test(request, conn, body):
    n = push.send_all(conn, {"title": "Напоминания включены", "body": "Про замеры напомню здесь, когда пройдут две недели.",
                             "tag": "test", "url": "/"})
    return {"sent": n}


@api("/api/products", ["GET"])
def api_products(request, conn, body):
    q = request.query_params.get("q", "")
    items = db.search_products(conn, q, limit=500) if q else db.list_products(conn)
    frequent = [dict(r) for r in conn.execute(
        """SELECT product_id, COUNT(*) n FROM meals WHERE product_id IS NOT NULL
           AND meal_date >= date('now', '-30 days') GROUP BY product_id ORDER BY n DESC LIMIT 5""")]
    return {"products": items, "frequent": [f["product_id"] for f in frequent]}


@api("/api/products", ["POST"])
def api_save_product(request, conn, body):
    p = db.save_product(conn, body["name"], basis=body.get("basis", "portion"), kcal=_num(body.get("kcal"), 0),
                        protein=_num(body.get("protein"), 0), fat=_num(body.get("fat"), 0),
                        carbs=_num(body.get("carbs"), 0), grams=_num(body.get("grams")),
                        category=body.get("category", ""), aliases=body.get("aliases", ""),
                        fridge_add=_num(body.get("fridge_add"), 0), lactose=body.get("lactose"),
                        sugar=body.get("sugar"), shelf=body.get("shelf"))
    return {"product": p}


@api("/api/products/{pid:int}", ["DELETE"])
def api_delete_product(request, conn, body):
    return {"deleted": db.delete_product(conn, request.path_params["pid"])}


@api("/api/products/{pid:int}/fridge", ["POST"])
def api_fridge(request, conn, body):
    pid = request.path_params["pid"]
    if "qty" in body:
        return {"product": db.set_fridge(conn, pid, _num(body["qty"], 0))}
    return {"product": db.adjust_fridge(conn, pid, _num(body.get("delta"), 0))}


@api("/api/products/{pid:int}/flags", ["POST"])
def api_flags(request, conn, body):
    return {"product": db.set_product_flags(conn, request.path_params["pid"], urgent=body.get("urgent"),
                                            lactose=body.get("lactose"), sugar=body.get("sugar"))}


@api("/api/recs", ["GET"])
def api_recs(request, conn, body):
    day = request.query_params.get("date") or db.today()
    return {"date": day, "plan": db.list_recommendations(conn, day), "today": db.today()}


@api("/api/recs/{rid:int}/toggle", ["POST"])
def api_toggle_rec(request, conn, body):
    r = db.toggle_recommendation(conn, request.path_params["rid"])
    if r is None:
        raise ValueError("recommendation not found")
    return {"recommendation": r, "day": db.day_summary(conn, r["rec_date"])}


@mcp.custom_route("/api/recs/regenerate", methods=["POST"])
async def api_regenerate(request: Request) -> Response:
    if not _authed(request):
        return _deny()
    try:
        body = await request.json()
    except Exception:
        body = {}
    import asyncio

    from scripts.daily_plan import generate_plan
    day = body.get("date") or db.today()
    try:
        result = await asyncio.to_thread(generate_plan, day, body.get("wish", ""))
    except RuntimeError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    except Exception as e:  # never hand the PWA a bare 500: it shows this text
        log.exception("plan generation failed")
        return JSONResponse({"error": f"не удалось собрать план: {e}"}, status_code=500)
    with db.tx() as conn:
        return JSONResponse({"plan": db.list_recommendations(conn, day), "comment": result.get("comment", "")})


@api("/api/goals", ["GET"])
def api_goals(request, conn, body):
    return {"goals": db.get_goals(conn), "weight_today": db.weight_today(conn), "weight": db.list_weight(conn, 90),
            "measurements": db.list_measurements(conn, None), "measure_due": db.measure_due(conn),
            "today": db.today(), "now_hour": db.now_local().hour}


@api("/api/goals", ["PUT"])
def api_set_goals(request, conn, body):
    return {"goals": db.set_goals(conn, kcal=_num(body.get("kcal")), protein=_num(body.get("protein")),
                                  fat=_num(body.get("fat")), carbs=_num(body.get("carbs")))}


@api("/api/weight", ["POST"])
def api_weight(request, conn, body):
    return {"weight": db.log_weight(conn, _num(body["kg"]), body.get("date"))}


@api("/api/analytics", ["GET"])
def api_analytics(request, conn, body):
    """?days=N (7..400) or ?days=all, or ?start=YYYY-MM-DD&end=YYYY-MM-DD."""
    q = request.query_params
    if q.get("start") or q.get("end"):
        return db.analytics(conn, start=q.get("start"), end=q.get("end"))
    raw = q.get("days", "30")
    if raw == "all":
        return db.analytics(conn, start=db.first_meal_date(conn) or db.today())
    return db.analytics(conn, max(7, min(400, int(raw))))


@api("/api/days", ["GET"])
def api_days(request, conn, body):
    """Per-day totals for the calendar: ?start=YYYY-MM-DD&end=YYYY-MM-DD (max ~1 year)."""
    q = request.query_params
    start, end = q.get("start") or db.today(), q.get("end") or db.today()
    return {"days": db.day_totals(conn, start, end), "goals": db.get_goals(conn), "today": db.today()}


# --------------------------------------------------------------------------- #
# app
# --------------------------------------------------------------------------- #

def build_app():
    db.init_db()
    # Caddy rewrites Host to the upstream (127.0.0.1:8010), so default rebinding protection passes.
    security = TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=[f"{HOST}:{PORT}", "127.0.0.1:*", "localhost:*"],
        allowed_origins=[],
    )
    return mcp.streamable_http_app(streamable_http_path=MCP_PATH, json_response=True, stateless_http=True,
                                   transport_security=security, host=HOST)


app = build_app()

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    import threading
    threading.Thread(target=push.reminder_loop, daemon=True, name="reminders").start()
    uvicorn.run(app, host=HOST, port=PORT, proxy_headers=True, forwarded_allow_ips="127.0.0.1")
