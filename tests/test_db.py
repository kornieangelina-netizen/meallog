import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


class DbTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["DB_PATH"] = os.path.join(self.tmp.name, "t.db")
        import db
        importlib.reload(db)
        self.db = db
        db.init_db()

    def tearDown(self):
        self.tmp.cleanup()

    def test_product_log_and_fridge(self):
        db = self.db
        with db.tx() as c:
            p = db.save_product(c, "Пудинг Hyper", basis="portion", kcal=200, protein=20, fat=5, carbs=20,
                                grams=150, fridge_add=3)
            self.assertEqual(p["fridge_qty"], 3)
            m = db.log_product(c, p["id"], portions=2)
            self.assertEqual(m["kcal"], 400)
            self.assertEqual(db.get_product(c, p["id"])["fridge_qty"], 1)
            s = db.day_summary(c)
            self.assertEqual(s["totals"]["protein"], 40)
            self.assertTrue(db.delete_meal(c, m["id"]))
            self.assertEqual(db.get_product(c, p["id"])["fridge_qty"], 3)

    def test_100g_basis(self):
        db = self.db
        with db.tx() as c:
            p = db.save_product(c, "Творог", basis="100g", kcal=100, protein=18, fat=2, carbs=3, fridge_add=500)
            m = db.log_product(c, p["id"], grams=200)
            self.assertEqual(m["kcal"], 200)
            self.assertEqual(m["protein"], 36)
            self.assertEqual(db.get_product(c, p["id"])["fridge_qty"], 300)

    def test_search_is_cyrillic_case_insensitive(self):
        db = self.db
        with db.tx() as c:
            db.save_product(c, "Гейнер Шоколад", aliases="гейнер, протеин")
            self.assertEqual(len(db.search_products(c, "ГЕЙНЕР")), 1)
            self.assertEqual(len(db.search_products(c, "протеин")), 1)
            self.assertEqual(len(db.search_products(c, "рыба")), 0)

    def test_save_product_updates_without_duplicates(self):
        db = self.db
        with db.tx() as c:
            a = db.save_product(c, "Яйцо", kcal=70, fridge_add=10)
            b = db.save_product(c, "яйцо", kcal=75, fridge_add=2)
            self.assertEqual(a["id"], b["id"])
            self.assertEqual(b["kcal"], 75)
            self.assertEqual(b["fridge_qty"], 12)

    def test_recommendation_toggle_roundtrip(self):
        db = self.db
        with db.tx() as c:
            p = db.save_product(c, "Курица с рисом", kcal=420, protein=32, fat=9, carbs=45, fridge_add=2)
            r = db.add_recommendation(c, p["id"], "lunch", portions=1)
            r = db.toggle_recommendation(c, r["id"])
            self.assertTrue(r["done"])
            self.assertEqual(db.get_product(c, p["id"])["fridge_qty"], 1)
            self.assertEqual(db.day_summary(c)["totals"]["kcal"], 420)
            r = db.toggle_recommendation(c, r["id"])
            self.assertFalse(r["done"])
            self.assertEqual(db.get_product(c, p["id"])["fridge_qty"], 2)
            self.assertEqual(db.day_summary(c)["totals"]["kcal"], 0)

    def test_goals_weight_analytics(self):
        db = self.db
        with db.tx() as c:
            db.set_goals(c, kcal=2200, protein=160)
            self.assertEqual(db.get_goals(c)["kcal"], 2200)
            db.log_weight(c, 80.5)
            db.log_meal(c, "Обед", 500, 30, 10, 60)
            a = db.analytics(c, 7)
            self.assertEqual(a["streak"], 1)
            self.assertEqual(a["weight"][-1]["kg"], 80.5)
            self.assertEqual(len(a["series"]), 7)


if __name__ == "__main__":
    unittest.main()
