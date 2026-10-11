"""Read workbook rows for the static mobile snapshot; never modify the source.

Date inference and statistics remain in web/xlsx-reader.js, shared with the UI.
"""
from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path
import re
import sys
from xml.etree import ElementTree as ET
from zipfile import ZipFile

from .workbook import NS, RUN_SHEET, SHEETS, sheet_paths


def read_rows(path: Path) -> dict:
    data = path.read_bytes()
    with ZipFile(io.BytesIO(data)) as archive:
        paths, date1904 = sheet_paths(archive)
        strings = []
        if "xl/sharedStrings.xml" in archive.namelist():
            strings = ["".join(t.text or "" for t in node.findall(".//m:t", NS)) for node in ET.fromstring(archive.read("xl/sharedStrings.xml"))]
        styles = ET.fromstring(archive.read("xl/styles.xml"))
        formats = {f.get("numFmtId"): f.get("formatCode", "") for f in styles.findall("m:numFmts/m:numFmt", NS)}
        cell_formats = [formats.get(x.get("numFmtId"), "") for x in styles.findall("m:cellXfs/m:xf", NS)]
        sheets = []
        for name in SHEETS.values():
            if name not in paths:
                raise ValueError(f"缺少工作表：{name}，停止生成手机数据。")
            sheets.append({"name": name, "rows": _sheet_rows(archive.read(paths[name]), strings, cell_formats)})
        # The Running sheet is optional: it appears with the first recorded run.
        runs = {"name": RUN_SHEET, "rows": _sheet_rows(archive.read(paths[RUN_SHEET]), strings, cell_formats)} if RUN_SHEET in paths else None
    return {"sheets": sheets, "runs": runs, "date1904": date1904, "sourceSha256": hashlib.sha256(data).hexdigest()}


def _sheet_rows(sheet_xml: bytes, strings: list[str], cell_formats: list[str]) -> list[dict]:
    """Rows of columns A–H with merged A/B/G/H ranges filled and each date's number format."""
    xml = ET.fromstring(sheet_xml)
    cells, metadata, row_numbers = {}, {}, set()
    for cell in xml.findall("m:sheetData/m:row/m:c", NS):
        ref = cell.get("r", "")
        match = re.fullmatch(r"([A-H])([1-9]\d*)", ref)
        if not match:
            continue
        row = int(match[2])
        if row > 100000:
            raise ValueError("工作表行数超出读取限制。")
        row_numbers.add(row)
        value = cell.findtext("m:v", "", NS)
        kind = cell.get("t")
        if kind == "s":
            value = strings[int(value)]
        elif kind == "inlineStr":
            value = "".join(t.text or "" for t in cell.findall(".//m:t", NS))
        elif kind in (None, "n") and value != "":
            try:
                value = float(value)
            except ValueError:
                pass
        cells[ref] = value
        if match[1] == "A" and value != "":
            style = int(cell.get("s", "0"))
            metadata[row] = {"dateAnchor": row, "numberFormat": cell_formats[style] if style < len(cell_formats) else ""}
    for merged in xml.findall("m:mergeCells/m:mergeCell", NS):
        match = re.fullmatch(r"([ABGH])([1-9]\d*):\1([1-9]\d*)", merged.get("ref", ""))
        if not match:
            continue
        col, first, last = match[1], int(match[2]), int(match[3])
        if last > 100000 or last < first:
            raise ValueError("工作簿合并区域无效。")
        for row in range(first + 1, last + 1):
            ref = f"{col}{row}"
            if cells.get(ref, "") == "":
                cells[ref] = cells.get(f"{col}{first}", "")
                if col == "A":
                    metadata[row] = metadata.get(first, {"dateAnchor": first, "numberFormat": ""})
    return [{"row": row, **metadata.get(row, {}), "values": [cells.get(f"{col}{row}", "") for col in "ABCDEFGH"]} for row in sorted(row_numbers)]

if __name__ == "__main__":
    print(json.dumps(read_rows(Path(sys.argv[1])), ensure_ascii=True, allow_nan=False))
