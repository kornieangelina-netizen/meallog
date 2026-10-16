import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


class PlanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["DB_PATH"] = os.path.join(self.tmp.name, "t.db")
        os.environ.pop("ANTHROPIC_API_KEY", None)
        import db
        importlib.reload(db)
        from scripts import daily_plan
        importlib.reload(daily_plan)
        self.db, self.plan = db, daily_plan
        db.init_db()

    def tearDown(self):
        self.tmp.cleanup()

    def test_greedy_plan_without_api_key(self):
        db = self.db
        with db.tx() as c:
            db.set_goals(c, kcal=2000, protein=150, fat=70, carbs=200)
            db.save_product(c, "Курица с рисом", kcal=420, protein=32, fat=9, carbs=45, fridge_add=3)
            db.save_product(c, "Творог", basis="100g", kcal=100, protein=18, fat=2, carbs=3, grams=200, fridge_add=600)
            db.save_product(c, "Гейнер", kcal=400, protein=30, fat=5, carbs=60, fridge_add=5)
        result = self.plan.generate_plan()
        total = sum(r["kcal"] for r in result["plan"])
        self.assertGreaterEqual(total, 2000 * (1 - self.plan.KCAL_TOLERANCE))
        self.assertLessEqual(total, 2000 * (1 + self.plan.KCAL_TOLERANCE))
        with db.tx() as c:
            fridge = {p["id"]: p for p in db.list_fridge(c)["items"]}
        for pid, p in fridge.items():
            used = sum(r["portions"] if r["basis"] == "portion" else r["grams"]
                       for r in result["plan"] if r["product_id"] == pid)
            self.assertLessEqual(used, p["fridge_qty"] + 1e-6)


if __name__ == "__main__":
    unittest.main()
