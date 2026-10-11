import math
import unittest
from datetime import date, datetime
from unittest.mock import patch

from powerlog.parser import ParseError, parse_training


class TrainingParserTests(unittest.TestCase):
    TODAY = date(2026, 10, 4)

    def parse(self, text):
        return parse_training(text, base_date=self.TODAY)

    def test_complete_chinese_session(self):
        self.assertEqual(self.parse("今天 深蹲 140kg 5次×3组 RPE8；卧推 90kg 3次×4组"), [
            {"date": "2026-10-04", "lift": "S", "exercise": "Comp Squat", "weight_kg": 140.0, "reps": 5, "sets": 3, "rpe": 8.0, "notes": ""},
            {"date": "2026-10-04", "lift": "B", "exercise": "Comp Bench", "weight_kg": 90.0, "reps": 3, "sets": 4, "rpe": None, "notes": ""},
        ])

    def test_default_date_comes_from_base_date(self):
        self.assertEqual(self.parse("深蹲 140x5x3")[0]["date"], "2026-10-04")

    def test_default_date_comes_from_sydney_helper(self):
        with patch("powerlog.parser._sydney_today", return_value=date(2027, 1, 1)):
            self.assertEqual(parse_training("昨天 深蹲 140x5x3")[0]["date"], "2026-12-31")

    def test_relative_dates_use_reference_not_previous_record(self):
        records = self.parse("昨天 深蹲 140x5x3；前天 卧推 90x5x3；今天 硬拉 180x3x3")
        self.assertEqual([r["date"] for r in records], ["2026-10-03", "2026-10-02", "2026-10-04"])

    def test_explicit_date_crosses_years(self):
        self.assertEqual(self.parse("2025-12-31 深蹲 140x5x3")[0]["date"], "2025-12-31")
        self.assertEqual(parse_training("前天 深蹲 140x5x3", date(2026, 1, 1))[0]["date"], "2025-12-30")

    def test_date_exercise_headings_and_carry_forward(self):
        records = self.parse("2026-10-01\n暂停深蹲\n140kg 5次 3组\n145kg 3次×2组")
        self.assertEqual(len(records), 2)
        self.assertEqual([r["exercise"] for r in records], ["Pause Squat", "Pause Squat"])
        self.assertEqual(records[1]["weight_kg"], 145)
        self.assertEqual(records[1]["date"], "2026-10-01")

    def test_compact_order_is_weight_reps_sets(self):
        record = self.parse("S 140x5x3")[0]
        self.assertEqual((record["weight_kg"], record["reps"], record["sets"]), (140, 5, 3))

    def test_explicit_labels_allow_reverse_set_rep_order(self):
        record = self.parse("深蹲 140kg 3组×5次")[0]
        self.assertEqual((record["reps"], record["sets"]), (5, 3))

    def test_units_aliases_variants_and_case(self):
        records = self.parse("squat 140公斤 5次3组, B 90千克 5x3, sumo deadlift 405lbs x 1 x 1")
        self.assertEqual([r["lift"] for r in records], ["S", "B", "D"])
        self.assertEqual(records[2]["exercise"], "Sumo Deadlift")
        self.assertAlmostEqual(records[2]["weight_kg"], 183.70490985)
        record = self.parse("窄握卧推 90x5x3")[0]
        self.assertEqual((record["lift"], record["exercise"]), ("B", "Close-grip Bench"))

    def test_workbook_exercise_names_are_recognised_and_written_in_english(self):
        cases = {
            "Comp Squat 160x5x3": ("S", "Comp Squat"),
            "high-bar squat 140x5x3": ("S", "High-bar Squat"),
            "Pin Squat (low) 150x3x2": ("S", "Pin Squat (low)"),
            "Pin Squat 150x3x2": ("S", "Pin Squat"),
            "Comp Bench 120x5x3": ("B", "Comp Bench"),
            "larsen bench 100x5x3": ("B", "Larsen Bench"),
            "Spoto Press 100x3x3": ("B", "Spoto Press"),
            "Comp Deadlift 200x2x3": ("D", "Comp Deadlift"),
            "RDL 150x6x3": ("D", "RDL"),
            "Sumo RDL 120x8x3": ("D", "Sumo RDL"),
            "罗马尼亚硬拉 150x6x3": ("D", "RDL"),
            "暂停卧推 110x3x3": ("B", "Pause Bench"),
            "硬拉 200x2x3": ("D", "Comp Deadlift"),
        }
        for text, expected in cases.items():
            with self.subTest(text=text):
                record = self.parse(text)[0]
                self.assertEqual((record["lift"], record["exercise"]), expected)

    def test_fullwidth_and_notes(self):
        record = self.parse("今天：深蹲 １４０ｋｇ ５次×３组 ＲＰＥ８．５ 备注：最后一组较慢。")[0]
        self.assertEqual(record["rpe"], 8.5)
        self.assertEqual(record["notes"], "最后一组较慢。")

    def test_invalid_record_prevents_partial_return(self):
        for text in ("深蹲 140x5x3；卧推 90kg", "深蹲 140x5x3；卧推", "深蹲 140x5x3；昨天"):
            with self.subTest(text=text), self.assertRaises(ParseError):
                self.parse(text)

    def test_reject_missing_or_ambiguous_data(self):
        inputs = ["", "今天练得很好", "今天", "深蹲", "140x5x3", "深蹲 140x5", "深蹲 140 5 3",
                  "深蹲 1405次3组", "蹲 140x5x3", "推 90x5x3", "深蹲 140x3组x5次",
                  "10月4日 深蹲 140x5x3", "10/4 深蹲 140x5x3", "2026-02-30 深蹲 140x5x3",
                  "上周 深蹲 140x5x3", "深蹲 140x5x3 然后休息", "深蹲 140x5x3 RPE8 RPE9",
                  "深蹲 140kg 5次 3组 或4组", "Squatting 140x5x3", "S140x5x3"]
        for text in inputs:
            with self.subTest(text=text), self.assertRaises(ParseError):
                self.parse(text)

    def test_reject_edit_requests(self):
        for text in ("删除今天 深蹲 140x5x3", "深蹲改成145x5x3", "更正 深蹲 140x5x3", "undo S 140x5x3"):
            with self.subTest(text=text), self.assertRaises(ParseError):
                self.parse(text)

    def test_reject_non_positive_non_integer_or_non_finite_values(self):
        invalid = ["0x5x3", "-140x5x3", "140x0x3", "140x5x0", "140x5.5x3", "140x5x2.5",
                   "NaNx5x3", "infx5x3", "1e309x5x3", "9" * 400 + "x5x3", "140x5x3 RPE11",
                   "140x5x3 RPE-1", "140x5x3 RPENaN", "140x5x3 RPE8.5.1"]
        for workload in invalid:
            with self.subTest(workload=workload), self.assertRaises(ParseError):
                self.parse("深蹲 " + workload)

    def test_fractional_weight_and_rpe_boundaries(self):
        for rpe in (0, 0.5, 8.5, 10):
            record = self.parse(f"卧推 62.5x5x3 RPE{rpe}")[0]
            self.assertEqual(record["weight_kg"], 62.5)
            self.assertEqual(record["rpe"], rpe)
            self.assertTrue(math.isfinite(record["weight_kg"]))

    def test_base_date_type(self):
        for bad_date in ("2026-10-04", datetime(2026, 10, 4)):
            with self.assertRaises(ParseError):
                parse_training("深蹲 140x5x3", bad_date)


if __name__ == "__main__":
    unittest.main()
