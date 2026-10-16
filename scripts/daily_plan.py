"""Daily meal plan: Claude API builds a plan from the fridge under the macro goals.

Run by a systemd timer at 07:00, or from the PWA "regenerate" button (with an optional wish).
The model returns JSON (structured output); the script validates it against hard limits and
asks for corrections up to MAX_ROUNDS times, then fills the remaining gap itself.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db  # noqa: E402

MODEL = os.environ.get("PLAN_MODEL", "claude-opus-5-5")
MAX_ROUNDS = 6
KCAL_TOLERANCE = 0.12  # +-12% of the kcal goal
PROTEIN_MIN = 0.85     # at least 85% of the protein goal when the fridge allows it

PLAN_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "slot": {"type": "string", "enum": db.SLOTS},
                    "product_id": {"type": "integer"},
                    "portions": {"type": "number"},
                },
                "required": ["slot", "product_id", "portions"],
                "additionalProperties": False,
            },
        },
        "comment": {"type": "string"},
    },
    "required": ["items", "comment"],
    "additionalProperties": False,
}

SYSTEM = """Ты составляешь план питания на один день из того, что есть в холодильнике пользователя.
Верни JSON по схеме: items (slot, product_id, portions) и comment (одна-две строки по-русски).
Жёсткие правила:
- Используй только product_id из списка холодильника, не больше остатка (fridge_qty).
- portions для basis='portion' — целое число штук; для basis='100g' — число порций по весу grams
  (если grams нет, одна порция = 100 г).
- Калории дня в пределах ±12% от цели, белок не меньше 85% цели, если холодильник позволяет.
- Завтрак, обед и ужин обязательны, перекусы по необходимости. Одна и та же позиция не чаще двух раз в день.
- Срочные позиции (urgent) ставь в первую очередь.
- Учитывай пожелание пользователя, если оно есть."""


def _fridge_for_prompt(conn) -> list[dict]:
    items = db.list_fridge(conn)["items"]
    return [{"product_id": p["id"], "name": p["name"], "basis": p["basis"], "grams": p["grams"],
             "kcal": p["kcal"], "protein": p["protein"], "fat": p["fat"], "carbs": p["carbs"],
             "fridge_qty": p["fridge_qty"], "urgent": bool(p["urgent"]), "category": p["category"]}
            for p in items]


def validate(items: list[dict], fridge: dict[int, dict], goals: dict) -> tuple[list[str], dict]:
    """Return (problems, totals). Empty problems means the plan is acceptable."""
    problems: list[str] = []
    totals = {m: 0.0 for m in db.MACROS}
    used: dict[int, float] = {}
    count: dict[int, int] = {}
    slots_filled = set()
    for it in items:
        pid = it["product_id"]
        p = fridge.get(pid)
        if not p:
            problems.append(f"product_id {pid} нет в холодильнике")
            continue
        portions = float(it["portions"])
        if portions <= 0:
            problems.append(f"{p['name']}: portions должно быть > 0")
            continue
        if p["basis"] == "portion" and abs(portions - round(portions)) > 1e-6:
            problems.append(f"{p['name']}: штучная позиция, portions должно быть целым")
        vals = db.macros_for(p, portions=portions)
        qty_used = portions if p["basis"] == "portion" else (vals["grams"] or 0)
        used[pid] = used.get(pid, 0) + qty_used
        count[pid] = count.get(pid, 0) + 1
        slots_filled.add(it["slot"])
        for m in db.MACROS:
            totals[m] += vals[m]
    for pid, q in used.items():
        if q > fridge[pid]["fridge_qty"] + 1e-6:
            problems.append(f"{fridge[pid]['name']}: запланировано {q}, в холодильнике {fridge[pid]['fridge_qty']}")
    for pid, n in count.items():
        if n > 2:
            problems.append(f"{fridge[pid]['name']}: встречается {n} раз, максимум 2")
    for s in ("breakfast", "lunch", "dinner"):
        if s not in slots_filled:
            problems.append(f"слот {s} пустой")
    kcal_goal = goals["kcal"]
    if abs(totals["kcal"] - kcal_goal) > KCAL_TOLERANCE * kcal_goal:
        problems.append(f"калории {totals['kcal']:.0f}, цель {kcal_goal:.0f} ±{KCAL_TOLERANCE*100:.0f}%")
    fridge_protein = sum(db.macros_for(p, portions=p["fridge_qty"] if p["basis"] == "portion" else None,
                                       grams=p["fridge_qty"] if p["basis"] == "100g" else None)["protein"]
                         for p in fridge.values())
    if totals["protein"] < PROTEIN_MIN * goals["protein"] and fridge_protein >= PROTEIN_MIN * goals["protein"]:
        problems.append(f"белок {totals['protein']:.0f}, нужно не меньше {PROTEIN_MIN*goals['protein']:.0f}")
    return problems, {m: round(v, 1) for m, v in totals.items()}


def greedy_fill(items: list[dict], fridge: dict[int, dict], goals: dict) -> list[dict]:
    """Deterministic fallback: top up kcal with the most protein-dense remaining food."""
    items = [it for it in items if it["product_id"] in fridge]
    _, totals = validate(items, fridge, goals)
    remaining = {pid: p["fridge_qty"] for pid, p in fridge.items()}
    for it in items:
        p = fridge[it["product_id"]]
        q = it["portions"] if p["basis"] == "portion" else db.macros_for(p, portions=it["portions"])["grams"]
        remaining[it["product_id"]] -= q or 0
    order = sorted(fridge.values(), key=lambda p: -(p["protein"] / max(p["kcal"], 1)))
    slots = [s for s in ("breakfast", "lunch", "dinner", "snack1", "snack2")
             if s not in {it["slot"] for it in items}] or ["snack2"]
    si = 0
    while totals["kcal"] < goals["kcal"] * (1 - KCAL_TOLERANCE):
        progressed = False
        for p in order:
            step = 1 if p["basis"] == "portion" else min(remaining[p["id"]], p["grams"] or 100)
            if remaining[p["id"]] < step or step <= 0:
                continue
            portions = 1 if p["basis"] == "portion" else step / (p["grams"] or 100)
            vals = db.macros_for(p, portions=portions)
            if totals["kcal"] + vals["kcal"] > goals["kcal"] * (1 + KCAL_TOLERANCE):
                continue
            items.append({"slot": slots[si % len(slots)], "product_id": p["id"], "portions": portions})
            si += 1
            remaining[p["id"]] -= step
            for m in db.MACROS:
                totals[m] += vals[m]
            progressed = True
            break
        if not progressed:
            break
    return items


def ask_claude(fridge_list: list[dict], goals: dict, wish: str, rounds: int) -> tuple[list[dict], str]:
    import anthropic

    client = anthropic.Anthropic()
    user = {"goals": goals, "fridge": fridge_list, "wish": wish or ""}
    messages = [{"role": "user", "content": "Данные:\n" + json.dumps(user, ensure_ascii=False)}]
    fridge = {p["product_id"]: {**p, "id": p["product_id"]} for p in fridge_list}
    items: list[dict] = []
    comment = ""
    for _ in range(rounds):
        resp = client.messages.create(
            model=MODEL, max_tokens=4000, system=SYSTEM, messages=messages,
            output_config={"format": {"type": "json_schema", "schema": PLAN_SCHEMA}},
        )
        if resp.stop_reason == "refusal":
            raise RuntimeError("модель отказалась составлять план")
        text = next((b.text for b in resp.content if b.type == "text"), "{}")
        data = json.loads(text)
        items, comment = data.get("items", []), data.get("comment", "")
        problems, totals = validate(items, fridge, goals)
        if not problems:
            return items, comment
        messages.append({"role": "assistant", "content": text})
        messages.append({"role": "user", "content": "Исправь план. Проблемы:\n- " + "\n- ".join(problems)
                         + f"\nТекущие итоги: {json.dumps(totals, ensure_ascii=False)}"})
    return items, comment


def generate_plan(day: str | None = None, wish: str = "", rounds: int = MAX_ROUNDS) -> dict:
    day = day or db.today()
    with db.tx() as conn:
        fridge_list = _fridge_for_prompt(conn)
        goals = db.get_goals(conn)
    if not fridge_list:
        raise RuntimeError("холодильник пуст, план не из чего собирать")
    fridge = {p["product_id"]: {**p, "id": p["product_id"]} for p in fridge_list}
    if os.environ.get("ANTHROPIC_API_KEY"):
        items, comment = ask_claude(fridge_list, goals, wish, rounds)
    else:
        items, comment = [], "ANTHROPIC_API_KEY не задан, план собран без модели"
    problems, _ = validate(items, fridge, goals)
    if problems:
        items = greedy_fill(items, fridge, goals)
        comment = (comment + " " if comment else "") + "(план добит автоматически)"
    with db.tx() as conn:
        db.clear_recommendations(conn, day, keep_done=True)
        for it in items:
            db.add_recommendation(conn, int(it["product_id"]), it["slot"], portions=float(it["portions"]), day=day)
        plan = db.list_recommendations(conn, day)
    return {"date": day, "plan": plan, "comment": comment}


if __name__ == "__main__":
    wish = " ".join(sys.argv[1:])
    result = generate_plan(wish=wish)
    print(result["comment"])
    for r in result["plan"]:
        print(f"{r['slot_title']:10} {r['name']} x{r['portions']} = {r['kcal']} ккал")
