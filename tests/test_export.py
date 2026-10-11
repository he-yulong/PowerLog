"""The mobile exporter must retain dates, merged metadata and newly appended data."""
import hashlib
from pathlib import Path
import shutil
import tempfile
import unittest

from powerlog.export import read_rows
from powerlog.workbook import append_records, excel_date

SOURCE = Path(__file__).resolve().parents[1] / "HylPowerliftingTraining.xlsx"


@unittest.skipUnless(SOURCE.is_file(), "Original workbook fixture is unavailable")
class MobileExportTests(unittest.TestCase):
    def test_read_only_export_retains_original_dates_and_merged_anchors(self):
        original = SOURCE.read_bytes()
        exported = read_rows(SOURCE)
        self.assertEqual(exported["sourceSha256"], hashlib.sha256(original).hexdigest())
        self.assertEqual(SOURCE.read_bytes(), original)
        sheets = {sheet["name"]: sheet["rows"] for sheet in exported["sheets"]}
        self.assertEqual(set(sheets), {"2025-S", "2025-B", "2025-D"})
        for sheet, row, date in [("2025-S", 294, "2026-10-03"), ("2025-B", 618, "2026-10-03"), ("2025-D", 270, "2026-03-10")]:
            item = next(item for item in sheets[sheet] if item["row"] == row)
            self.assertEqual(item["values"][0], excel_date(date))
            self.assertEqual(item["dateAnchor"], row)
        for rows in sheets.values():
            by_row = {row["row"]: row for row in rows}
            merged = [row for row in rows if row.get("dateAnchor", row["row"]) != row["row"]]
            self.assertTrue(merged)
            for row in merged:
                self.assertEqual(row["values"][0], by_row[row["dateAnchor"]]["values"][0])

    def test_new_iso_dates_and_notes_survive_export_from_temporary_copy(self):
        with tempfile.TemporaryDirectory(prefix="powerlog-export-") as temporary:
            path = Path(temporary) / SOURCE.name
            shutil.copy2(SOURCE, path)
            append_records(path, [{"date": "2025-02-03", "lift": "S", "exercise": "Pause Squat", "weight_kg": 140, "reps": 5, "sets": 3, "rpe": 8, "notes": "<导出测试> & 保留文字"}])
            rows = next(sheet["rows"] for sheet in read_rows(path)["sheets"] if sheet["name"] == "2025-S")
            row = rows[-1]
            self.assertEqual(row["numberFormat"], "yyyy-mm-dd")
            self.assertEqual(row["dateAnchor"], row["row"])
            self.assertEqual(row["values"], [excel_date("2025-02-03"), "Pause Squat", 140, 5, 3, "", "<导出测试> & 保留文字", 8])
