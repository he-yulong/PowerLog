"""Safety tests only operate on temporary copies of the user's workbook."""

import copy
import json
from pathlib import Path
import re
import shutil
import tempfile
import unittest
from unittest.mock import patch
from xml.etree import ElementTree as ET
from zipfile import ZipFile

from powerlog import workbook
from powerlog.export import read_rows
from powerlog.parser import parse_training


SOURCE = Path(__file__).resolve().parents[1] / "HylPowerliftingTraining.xlsx"


@unittest.skipUnless(SOURCE.is_file(), "Original workbook fixture is unavailable")
class WorkbookSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="powerlog-test-")
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / SOURCE.name
        shutil.copy2(SOURCE, self.path)
        self.original = self.path.read_bytes()
        self.records = parse_training("2026-10-04 深蹲 140kg 5次×3组 RPE8 备注:测试 <标签> & 文本")

    def state(self):
        return self.path.parent / ".powerlog" / self.path.name

    def events(self):
        return [json.loads(path.read_text(encoding="utf-8")) for path in sorted(self.state().glob("*.json"))]

    def members(self):
        with ZipFile(self.path) as archive:
            return {name: archive.read(name) for name in archive.namelist()}

    def test_append_backup_and_untouched_archive_members(self):
        old_members = self.members()
        result = workbook.append_records(self.path, self.records)
        self.assertEqual(result["status"], "saved")
        self.assertEqual(Path(result["backup"]).read_bytes(), self.original)
        new_members = self.members()
        self.assertEqual(old_members.keys(), new_members.keys())
        modified = {key for key in old_members if old_members[key] != new_members[key]}
        self.assertEqual(modified, {"xl/styles.xml", "xl/worksheets/sheet1.xml"})
        old_sheet = old_members["xl/worksheets/sheet1.xml"].decode("utf-8")
        new_sheet = new_members["xl/worksheets/sheet1.xml"].decode("utf-8")
        new_row = int(re.search(r"\d+", result["updates"][0]["range"]).group())
        new_sheet = re.sub(rf'<row r="{new_row}"[^>]*>.*?</row>', "", new_sheet, count=1)
        strip_dimension = lambda value: re.sub(r'<dimension\b[^>]*/>', "", value, count=1)
        self.assertEqual(strip_dimension(old_sheet), strip_dimension(new_sheet))
        old_style = ET.fromstring(old_members["xl/styles.xml"])
        new_style = ET.fromstring(new_members["xl/styles.xml"])
        for tag in ("fonts", "fills", "borders", "cellStyleXfs", "cellStyles", "dxfs", "tableStyles"):
            self.assertEqual(ET.tostring(old_style.find("m:" + tag, workbook.NS)), ET.tostring(new_style.find("m:" + tag, workbook.NS)))
        old_xfs = old_style.find("m:cellXfs", workbook.NS)
        new_xfs = new_style.find("m:cellXfs", workbook.NS)
        self.assertEqual([ET.tostring(x) for x in old_xfs], [ET.tostring(x) for x in list(new_xfs)[:len(old_xfs)]])

    def test_appended_cell_values_and_note_escaping(self):
        result = workbook.append_records(self.path, self.records)
        row_number = re.search(r"\d+", result["updates"][0]["range"]).group()
        with ZipFile(self.path) as archive:
            root = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
        row = root.find(f'm:sheetData/m:row[@r="{row_number}"]', workbook.NS)
        self.assertIsNotNone(row)
        values = {}
        for cell in row:
            child = cell.find("m:v", workbook.NS) if cell.get("t") == "n" else cell.find("m:is/m:t", workbook.NS)
            values[cell.get("r")[0]] = None if child is None else child.text
        self.assertEqual(values, {"A": str(workbook.excel_date("2026-10-04")), "B": "Comp Squat", "C": "140.0", "D": "5", "E": "3", "F": None, "G": "测试 <标签> & 文本", "H": "8.0"})

    def test_all_lifts_and_repeated_appends(self):
        records = parse_training("2026-10-04 深蹲 140x5x3；卧推 90x3x4；硬拉 180x3x3")
        first = workbook.append_records(self.path, records)
        second = workbook.append_records(self.path, records, allow_duplicate=True)
        self.assertEqual([u["sheet"] for u in first["updates"]], ["2025-S", "2025-B", "2025-D"])
        for before, after in zip(first["updates"], second["updates"]):
            before_row = int(re.search(r"\d+", before["range"]).group())
            after_row = int(re.search(r"\d+", after["range"]).group())
            self.assertEqual(after_row, before_row + 1)

    def test_dry_run_does_not_mutate_or_create_history(self):
        result = workbook.append_records(self.path, self.records, dry_run=True)
        self.assertEqual(result["status"], "preview")
        self.assertEqual(self.path.read_bytes(), self.original)
        self.assertFalse(self.state().exists())
        self.assertEqual(list(self.path.parent.glob(".powerlog-*.xlsx")), [])
        self.assertFalse(self.path.with_name(self.path.name + ".powerlog.lock").exists())

    def test_duplicate_does_not_rewrite_workbook(self):
        first = workbook.append_records(self.path, self.records)
        saved = self.path.read_bytes()
        second = workbook.append_records(self.path, self.records)
        self.assertEqual(second["status"], "duplicate")
        self.assertEqual(first["updates"], second["updates"])
        self.assertEqual(self.path.read_bytes(), saved)
        self.assertEqual(len(self.events()), 1)

    def test_same_content_different_request_id_is_duplicate(self):
        workbook.append_records(self.path, self.records, request_id="first")
        self.assertEqual(workbook.append_records(self.path, self.records, request_id="second")["status"], "duplicate")

    def test_request_id_cannot_change_payload(self):
        workbook.append_records(self.path, self.records, request_id="same-id")
        changed = copy.deepcopy(self.records)
        changed[0]["weight_kg"] = 145
        saved = self.path.read_bytes()
        with self.assertRaises(workbook.WorkbookError):
            workbook.append_records(self.path, changed, request_id="same-id")
        self.assertEqual(self.path.read_bytes(), saved)

    def test_undo_restores_exact_original_and_allows_resubmission(self):
        workbook.append_records(self.path, self.records)
        result = workbook.undo_last(self.path)
        self.assertEqual(result["status"], "undone")
        self.assertEqual(self.path.read_bytes(), self.original)
        self.assertEqual(workbook.append_records(self.path, self.records)["status"], "saved")

    def test_undo_can_step_back_multiple_transactions(self):
        workbook.append_records(self.path, self.records)
        changed = copy.deepcopy(self.records)
        changed[0]["weight_kg"] = 145
        workbook.append_records(self.path, changed)
        workbook.undo_last(self.path)
        workbook.undo_last(self.path)
        self.assertEqual(self.path.read_bytes(), self.original)

    def test_undo_refuses_external_modification(self):
        workbook.append_records(self.path, self.records)
        externally_modified = self.path.read_bytes() + b"external modification"
        self.path.write_bytes(externally_modified)
        with self.assertRaises(workbook.WorkbookError):
            workbook.undo_last(self.path)
        self.assertEqual(self.path.read_bytes(), externally_modified)

    def test_undo_refuses_corrupt_backup(self):
        saved_result = workbook.append_records(self.path, self.records)
        saved = self.path.read_bytes()
        Path(saved_result["backup"]).write_bytes(b"corrupt backup")
        with self.assertRaises(workbook.WorkbookError):
            workbook.undo_last(self.path)
        self.assertEqual(self.path.read_bytes(), saved)

    def test_invalid_records_never_touch_original(self):
        bad_records = [[], [{"date": "2026-10-04"}], [{**self.records[0], "weight_kg": float("inf")}],
                       [{**self.records[0], "weight_kg": True}], [{**self.records[0], "sets": 0}],
                       [{**self.records[0], "reps": 1.5}], [{**self.records[0], "date": "2026-02-30"}],
                       [{**self.records[0], "rpe": 11}], [{**self.records[0], "lift": "X"}],
                       [{**self.records[0], "notes": "bad\x00text"}], [{**self.records[0], "typo": 2}]]
        for records in bad_records:
            with self.subTest(records=records), self.assertRaises(workbook.WorkbookError):
                workbook.append_records(self.path, records)
            self.assertEqual(self.path.read_bytes(), self.original)
        self.assertFalse(self.state().exists())

    def test_excel_open_lock_refuses_write(self):
        excel_lock = self.path.with_name("~$" + self.path.name)
        excel_lock.write_bytes(b"Excel lock")
        with self.assertRaises(workbook.WorkbookError):
            workbook.append_records(self.path, self.records)
        self.assertEqual(self.path.read_bytes(), self.original)

    def test_pending_append_after_replace_is_recovered(self):
        real_save = workbook._save_json

        def fail_final_journal(path, event):
            if event["action"] == "append" and event["status"] == "committed":
                raise OSError("simulated failure after workbook replacement")
            return real_save(path, event)

        with patch.object(workbook, "_save_json", side_effect=fail_final_journal):
            with self.assertRaises(OSError):
                workbook.append_records(self.path, self.records)
        self.assertEqual(self.events()[0]["status"], "pending")
        self.assertEqual(workbook.append_records(self.path, self.records)["status"], "duplicate")
        self.assertEqual(self.events()[0]["status"], "committed")

    def test_replace_failure_leaves_source_and_retry_recovers(self):
        real_replace = workbook.os.replace

        def fail_workbook_replace(source, destination):
            if Path(destination) == self.path:
                raise PermissionError("simulated Excel sharing violation")
            return real_replace(source, destination)

        with patch.object(workbook.os, "replace", side_effect=fail_workbook_replace):
            with self.assertRaises(workbook.WorkbookError):
                workbook.append_records(self.path, self.records)
        self.assertEqual(self.path.read_bytes(), self.original)
        self.assertEqual(self.events()[0]["status"], "aborted")
        self.assertEqual(workbook.append_records(self.path, self.records)["status"], "saved")

    def test_equivalent_numeric_rpe_is_duplicate(self):
        first = copy.deepcopy(self.records)
        first[0]["rpe"] = 8
        workbook.append_records(self.path, first)
        self.assertEqual(workbook.append_records(self.path, self.records)["status"], "duplicate")

    def test_equivalent_numeric_max_is_duplicate(self):
        first = copy.deepcopy(self.records)
        first[0]["max"] = 200
        workbook.append_records(self.path, first)
        second = copy.deepcopy(first)
        second[0]["max"] = 200.0
        self.assertEqual(workbook.append_records(self.path, second)["status"], "duplicate")

    def test_undo_replace_failure_can_be_retried(self):
        workbook.append_records(self.path, self.records)
        saved = self.path.read_bytes()
        real_replace = workbook.os.replace

        def fail_workbook_replace(source, destination):
            if Path(destination) == self.path:
                raise PermissionError("simulated sharing violation during undo")
            return real_replace(source, destination)

        with patch.object(workbook.os, "replace", side_effect=fail_workbook_replace):
            with self.assertRaises((OSError, workbook.WorkbookError)):
                workbook.undo_last(self.path)
        self.assertEqual(self.path.read_bytes(), saved)
        self.assertEqual(workbook.undo_last(self.path)["status"], "undone")
        self.assertEqual(self.path.read_bytes(), self.original)

    def test_failed_undo_journal_recovers_without_false_duplicate(self):
        workbook.append_records(self.path, self.records)
        real_save = workbook._save_json

        def fail_final_undo_journal(path, event):
            if event.get("status") == "undone":
                raise OSError("simulated interruption after undo replacement")
            return real_save(path, event)

        with patch.object(workbook, "_save_json", side_effect=fail_final_undo_journal):
            with self.assertRaises(OSError):
                workbook.undo_last(self.path)
        self.assertEqual(self.path.read_bytes(), self.original)
        self.assertEqual(workbook.append_records(self.path, self.records)["status"], "saved")

    def test_append_rechecks_external_edits_after_journal_write(self):
        real_save = workbook._save_json
        changed_externally = self.original + b"new external content during commit preparation"

        def concurrent_edit(path, event):
            result = real_save(path, event)
            if event.get("status") == "pending":
                self.path.write_bytes(changed_externally)
            return result

        with patch.object(workbook, "_save_json", side_effect=concurrent_edit):
            with self.assertRaises(workbook.WorkbookError):
                workbook.append_records(self.path, self.records)
        self.assertEqual(self.path.read_bytes(), changed_externally)

    def bench_names(self):
        return {row["row"]: row["values"][1] for row in next(sheet["rows"] for sheet in read_rows(self.path)["sheets"] if sheet["name"] == "2025-B")}

    def test_rename_exercise_changes_only_named_cells_and_can_be_undone(self):
        # B55:B57 and B58:B59 are merged exercise cells holding one name.
        current = self.bench_names()[55]
        old_members = self.members()
        for new_name, shared in (("Larsen Press", True), ("Test <Rename> & Lift", False)):
            with self.subTest(new_name=new_name):
                result = workbook.rename_exercise(self.path, "2025-B", list(range(55, 60)), current, new_name)
                self.assertEqual(result["status"], "saved")
                self.assertEqual([update["range"] for update in result["updates"]], ["B55:B57", "B58:B59"])
                new_members = self.members()
                self.assertEqual({key for key in old_members if old_members[key] != new_members[key]}, {"xl/worksheets/sheet2.xml"})
                self.assertEqual(b' t="s"' in re.search(rb'<c r="B55"[^>]*>', new_members["xl/worksheets/sheet2.xml"]).group(0), shared)
                self.assertEqual([self.bench_names()[row] for row in range(55, 60)], [new_name] * 5)
                self.assertEqual(workbook.undo_last(self.path)["status"], "undone")
                self.assertEqual(self.path.read_bytes(), self.original)

    def test_rename_refuses_cells_with_a_different_name(self):
        with self.assertRaises(workbook.WorkbookError):
            workbook.rename_exercise(self.path, "2025-B", [55], self.bench_names()[55] + " (not this)", "Comp Bench")
        self.assertEqual(self.path.read_bytes(), self.original)
        self.assertFalse(self.state().exists())

    def test_undo_rechecks_external_edits_before_replace(self):
        workbook.append_records(self.path, self.records)
        real_mkstemp = workbook.tempfile.mkstemp
        changed_externally = self.path.read_bytes() + b"new external content during undo preparation"

        def concurrent_edit(*args, **kwargs):
            self.path.write_bytes(changed_externally)
            return real_mkstemp(*args, **kwargs)

        with patch.object(workbook.tempfile, "mkstemp", side_effect=concurrent_edit):
            with self.assertRaises(workbook.WorkbookError):
                workbook.undo_last(self.path)
        self.assertEqual(self.path.read_bytes(), changed_externally)


if __name__ == "__main__":
    unittest.main()
