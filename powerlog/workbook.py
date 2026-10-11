"""Append-only updates to the existing training workbook, without rewriting history.

The ZIP members and worksheet XML outside the appended rows stay byte-for-byte
unchanged, including Excel formatting, merged cells, notes and cached values.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import re
import tempfile
import uuid
from contextlib import contextmanager
from datetime import date, datetime, timezone
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape, unescape
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
RID = "{" + REL_NS + "}id"
SHEETS = {"S": "2025-S", "B": "2025-B", "D": "2025-D"}
# Cardio sessions live in their own sheet: A date, B activity, C distance km, D time, E calories kcal, F notes.
CARDIO_SHEET = "Cardio"
CARDIO_HEADERS = ("Date", "Activity", "Distance (km)", "Time", "Calories (kcal)", "Notes")


class WorkbookError(ValueError):
    """A safe, user-visible refusal to modify the workbook."""


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def normalize_records(records: list[dict]) -> list[dict]:
    if not isinstance(records, list) or not records or len(records) > 500:
        raise WorkbookError("请提供 1–500 条训练记录。")
    result = []
    for record in records:
        if not isinstance(record, dict):
            raise WorkbookError("每条记录必须是对象。")
        unknown = set(record) - {"date", "lift", "exercise", "weight_kg", "reps", "sets", "rpe", "notes", "max"}
        if unknown:
            raise WorkbookError("未知字段：" + ", ".join(sorted(unknown)))
        try:
            day = date.fromisoformat(record["date"])
        except (KeyError, ValueError, TypeError):
            raise WorkbookError("日期必须是完整的 YYYY-MM-DD。") from None
        if not 1900 <= day.year <= 2100:
            raise WorkbookError("请检查训练年份（支持 1900–2100）。")
        if record.get("lift") not in SHEETS:
            raise WorkbookError("lift 必须为 S（深蹲）、B（卧推）或 D（硬拉）。")
        item = {"date": day.isoformat(), "lift": record["lift"]}
        for key in ("exercise", "notes"):
            value = record.get(key, "")
            if not isinstance(value, str) or len(value) > 2000 or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", value):
                raise WorkbookError(f"{key} 必须是有效的文字，最长 2000 字。")
            item[key] = value.strip()
        if not item["exercise"]:
            raise WorkbookError("缺少动作名称。")
        for key in ("weight_kg", "reps", "sets"):
            value = record.get(key)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
                raise WorkbookError(f"{key} 必须是正数。")
            if key != "weight_kg" and (not float(value).is_integer() or value > 1000):
                raise WorkbookError(f"{key} 必须是 1–1000 的整数。")
            item[key] = float(value) if key == "weight_kg" else int(value)
        rpe = record.get("rpe")
        if rpe is not None and (isinstance(rpe, bool) or not isinstance(rpe, (int, float)) or not math.isfinite(rpe) or not 0 <= rpe <= 10):
            raise WorkbookError("RPE 必须是 0–10 的数字，或留空。")
        item["rpe"] = float(rpe) if rpe is not None else None
        maximum = record.get("max")
        if maximum is not None and maximum != "PR":
            if isinstance(maximum, bool) or not isinstance(maximum, (int, float)) or not math.isfinite(maximum) or maximum <= 0:
                raise WorkbookError("Max 只能是正数、PR 或空。")
        item["max"] = float(maximum) if isinstance(maximum, (int, float)) else maximum
        result.append(item)
    return result


def sheet_paths(archive: ZipFile) -> tuple[dict[str, str], bool]:
    import posixpath
    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    targets = {}
    for rel in rels:
        target = rel.attrib["Target"]
        targets[rel.attrib["Id"]] = target.lstrip("/") if target.startswith("/") else posixpath.normpath("xl/" + target)
    paths = {sheet.attrib["name"]: targets[sheet.attrib[RID]] for sheet in workbook.findall("m:sheets/m:sheet", NS)}
    properties = workbook.find("m:workbookPr", NS)
    is_1904 = properties is not None and properties.get("date1904") in ("1", "true")
    return paths, is_1904


def excel_date(value: str, is_1904: bool = False) -> int:
    day = date.fromisoformat(value)
    if is_1904:
        return (day - date(1904, 1, 1)).days
    serial = (day - date(1899, 12, 31)).days
    return serial + (1 if day >= date(1900, 3, 1) else 0)


def _cell(ref: str, value, style: int = 32) -> str:
    if value is None or value == "":
        return f'<c r="{ref}" s="{style}"/>'
    if isinstance(value, str):
        return f'<c r="{ref}" s="{style}" t="inlineStr"><is><t xml:space="preserve">{escape(value)}</t></is></c>'
    return f'<c r="{ref}" s="{style}" t="n"><v>{value}</v></c>'


def _date_style(styles: bytes) -> tuple[bytes, int]:
    """Reuse an ISO date style or append one, keeping all existing style IDs."""
    text = styles.decode("utf-8")
    root = ET.fromstring(styles)
    xfs = root.find("m:cellXfs", NS)
    if xfs is None or len(xfs) <= 33:
        raise WorkbookError("工作簿样式已改变，无法安全匹配原模板。")
    numfmts = root.find("m:numFmts", NS)
    fmt_id = None
    if numfmts is not None:
        fmt_id = next((f.get("numFmtId") for f in numfmts if f.get("formatCode") == "yyyy-mm-dd"), None)
    if fmt_id is not None:
        for index, xf in enumerate(xfs):
            if xf.get("numFmtId") == fmt_id:
                return styles, index
    else:
        fmt_id = str(max([163] + [int(f.get("numFmtId")) for f in numfmts] if numfmts is not None else [163]) + 1)
        entry = f'<numFmt numFmtId="{fmt_id}" formatCode="yyyy-mm-dd"/>'
        if numfmts is None:
            text, count = re.subn(r"(<styleSheet\b[^>]*>)", rf'\g<1><numFmts count="1">{entry}</numFmts>', text, count=1)
        else:
            pattern = r'<numFmts\b[^>]*(?:/>|>.*?</numFmts>)'
            block = re.search(pattern, text, re.S)
            if not block:
                raise WorkbookError("无法识别数字格式。")
            old = block.group(0)
            if old.endswith('/>'):
                new = f'<numFmts count="1">{entry}</numFmts>'
            else:
                new = re.sub(r'count="\d+"', f'count="{len(numfmts)+1}"', old, count=1).replace('</numFmts>', entry + '</numFmts>')
            text = text[:block.start()] + new + text[block.end():]
            count = 1
        if not count:
            raise WorkbookError("无法追加日期格式。")
    block = re.search(r'<cellXfs\b[^>]*>(.*?)</cellXfs>', text, re.S)
    if not block:
        raise WorkbookError("无法识别单元格样式。")
    # Take the regular date cell style; do not propagate PR highlights.
    xf = ET.fromstring(ET.tostring(xfs[33]))
    xf.set("numFmtId", fmt_id)
    xf.set("applyNumberFormat", "1")
    new_xf = ET.tostring(xf, encoding="unicode").replace('ns0:', '').replace(' xmlns:ns0="'+NS['m']+'"', '')
    new_block = re.sub(r'count="\d+"', f'count="{len(xfs)+1}"', block.group(0), count=1)
    new_block = new_block.replace("</cellXfs>", new_xf + "</cellXfs>")
    return (text[:block.start()] + new_block + text[block.end():]).encode("utf-8"), len(xfs)


def _ensure_number_format(styles: bytes, code: str) -> tuple[bytes, str]:
    """Return the numFmtId for ``code``, appending a custom number format when it is missing."""
    root = ET.fromstring(styles)
    numfmts = root.find("m:numFmts", NS)
    if numfmts is not None:
        existing = next((f.get("numFmtId") for f in numfmts if f.get("formatCode") == code), None)
        if existing is not None:
            return styles, existing
    fmt_id = str(max([163] + ([int(f.get("numFmtId")) for f in numfmts] if numfmts is not None else [])) + 1)
    entry = f'<numFmt numFmtId="{fmt_id}" formatCode="{escape(code, {chr(34): "&quot;"})}"/>'
    text = styles.decode("utf-8")
    if numfmts is None:
        text, count = re.subn(r"<styleSheet\b[^>]*>", lambda m: m.group(0) + f'<numFmts count="1">{entry}</numFmts>', text, count=1)
    else:
        block = re.search(r'<numFmts\b[^>]*(?:/>|>.*?</numFmts>)', text, re.S)
        count = 1 if block else 0
        if block:
            old = block.group(0)
            new = f'<numFmts count="1">{entry}</numFmts>' if old.endswith('/>') else re.sub(r'count="\d+"', f'count="{len(numfmts) + 1}"', old, count=1).replace('</numFmts>', entry + '</numFmts>')
            text = text[:block.start()] + new + text[block.end():]
    if not count:
        raise WorkbookError("无法追加数字格式。")
    return text.encode("utf-8"), fmt_id


def _iso_date_variants(styles: bytes, bases: set[int]) -> tuple[bytes, dict[int, int]]:
    """Map each cell style to a copy that shows yyyy-mm-dd, keeping its borders, fills and fonts."""
    return _number_format_variants(styles, bases, "yyyy-mm-dd")


def _number_format_variants(styles: bytes, bases: set[int], code: str) -> tuple[bytes, dict[int, int]]:
    """Map each cell style to a copy that uses number format ``code``, keeping its look otherwise."""
    styles, fmt_id = _ensure_number_format(styles, code)
    text = styles.decode("utf-8")
    root = ET.fromstring(styles)
    xfs = list(root.find("m:cellXfs", NS))
    existing = [ET.tostring(xf) for xf in xfs]
    mapping, added = {}, []
    for base in sorted(bases):
        if base >= len(xfs):
            raise WorkbookError("单元格样式编号无效。")
        if xfs[base].get("numFmtId") == fmt_id:
            mapping[base] = base
            continue
        clone = ET.fromstring(ET.tostring(xfs[base]))
        clone.set("numFmtId", fmt_id)
        clone.set("applyNumberFormat", "1")
        key = ET.tostring(clone)
        if key not in existing:
            existing.append(key)
            added.append(ET.tostring(clone, encoding="unicode").replace('ns0:', '').replace(' xmlns:ns0="' + NS['m'] + '"', ''))
        mapping[base] = existing.index(key)
    if added:
        block = re.search(r'<cellXfs\b[^>]*>(.*?)</cellXfs>', text, re.S)
        new_block = re.sub(r'count="\d+"', f'count="{len(existing)}"', block.group(0), count=1).replace("</cellXfs>", "".join(added) + "</cellXfs>")
        text = text[:block.start()] + new_block + text[block.end():]
    return text.encode("utf-8"), mapping


def _append_rows(text: str, name: str, rows: list[list], styles: list[int]) -> tuple[str, list[int]]:
    """Append rows of cell values after the last used row (including merged ranges)."""
    root = ET.fromstring(text)
    if root.find("m:sheetProtection", NS) is not None:
        raise WorkbookError(f"{name} 已保护，不能追加。")
    data = root.find("m:sheetData", NS)
    if data is None or "</sheetData>" not in text:
        raise WorkbookError("不支持此工作表 XML 格式。")
    last = max([2] + [int(row.get("r")) for row in data])
    for merged in root.findall("m:mergeCells/m:mergeCell", NS):
        last = max(last, int(re.search(r"\d+$", merged.get("ref")).group()))
    columns = "ABCDEFGH"[:len(styles)]
    xml_rows, numbers = [], []
    for offset, values in enumerate(rows, 1):
        row = last + offset
        if row > 1048576:
            raise WorkbookError("工作表已达到 Excel 行数上限。")
        cells = ''.join(_cell(f'{column}{row}', value, style) for column, value, style in zip(columns, values, styles))
        xml_rows.append(f'<row r="{row}" spans="1:{len(columns)}">{cells}</row>')
        numbers.append(row)
    text = text.replace("</sheetData>", ''.join(xml_rows) + "</sheetData>", 1)
    dim = root.find("m:dimension", NS)
    if dim is not None:
        old_ref = dim.get("ref", "A1:H1")
        first = old_ref.split(":")[0]
        last_col = re.match(r"[A-Z]+", old_ref.split(":")[-1]).group()
        if len(last_col) == 1 and last_col < columns[-1]:
            last_col = columns[-1]
        new_ref = f"{first}:{last_col}{last + len(rows)}"
        text = re.sub(r'(<dimension\b[^>]*ref=")[^"]+("[^>]*/>)', lambda m: m[1] + new_ref + m[2], text, count=1)
    return text, numbers


def build_update(path: Path, records: list[dict], destination: Path) -> list[dict]:
    """Build a candidate file; never overwrite the source here."""
    updates = []
    with ZipFile(path) as source:
        paths, is_1904 = sheet_paths(source)
        if not all(name in paths for name in SHEETS.values()):
            raise WorkbookError("找不到模板中的 2025-S、2025-B、2025-D 工作表。")
        styles, date_style = _date_style(source.read("xl/styles.xml"))
        changed = {"xl/styles.xml": styles}
        for lift, name in SHEETS.items():
            selected = [r for r in records if r["lift"] == lift]
            if not selected:
                continue
            values = [[excel_date(r["date"], is_1904), r["exercise"], r["weight_kg"], r["reps"], r["sets"], r["max"], r["notes"], r["rpe"]] for r in selected]
            text, rows = _append_rows(source.read(paths[name]).decode("utf-8"), name, values, [date_style] + [32] * 7)
            changed[paths[name]] = text.encode("utf-8")
            updates += [{"sheet": name, "range": f"A{row}:H{row}", "record": record} for row, record in zip(rows, selected)]
        _write_candidate(source, destination, changed)
    # Reopen and check every changed XML member before considering a commit.
    _check_candidate(destination, changed)
    return updates


def _duration_seconds(value: str) -> int | None:
    """Seconds in an ``h:mm:ss`` or ``mm:ss`` duration, or None when it is not one."""
    long = re.fullmatch(r"(\d{1,2}):([0-5]\d):([0-5]\d)", value)
    short = re.fullmatch(r"(\d{1,3}):([0-5]\d)", value)
    if long:
        return int(long[1]) * 3600 + int(long[2]) * 60 + int(long[3])
    if short:
        return int(short[1]) * 60 + int(short[2])
    return None


def normalize_cardio(sessions: list[dict]) -> list[dict]:
    if not isinstance(sessions, list) or not sessions or len(sessions) > 500:
        raise WorkbookError("请提供 1–500 条有氧记录。")
    result = []
    for session in sessions:
        if not isinstance(session, dict):
            raise WorkbookError("每条有氧记录必须是对象。")
        unknown = set(session) - {"date", "activity", "distance_km", "duration", "calories_kcal", "notes"}
        if unknown:
            raise WorkbookError("未知字段：" + ", ".join(sorted(unknown)))
        try:
            day = date.fromisoformat(session["date"])
        except (KeyError, ValueError, TypeError):
            raise WorkbookError("日期必须是完整的 YYYY-MM-DD。") from None
        if not 1900 <= day.year <= 2100:
            raise WorkbookError("请检查有氧记录的年份（支持 1900–2100）。")
        activity = session.get("activity")
        if not isinstance(activity, str) or not activity.strip() or len(activity) > 100 or re.search(r"[\x00-\x1f]", activity):
            raise WorkbookError("activity 必须是有效的英文项目名，例如 Run、Stair Climber。")
        distance = session.get("distance_km")
        if distance is not None and (isinstance(distance, bool) or not isinstance(distance, (int, float)) or not math.isfinite(distance) or not 0 < distance <= 1000):
            raise WorkbookError("distance_km 必须是 0–1000 之间的公里数。")
        duration = session.get("duration")
        if duration is not None:
            seconds = _duration_seconds(duration.strip()) if isinstance(duration, str) else None
            if not seconds or seconds >= 86400:
                raise WorkbookError("duration 必须是 h:mm:ss 或 mm:ss，且不超过 24 小时。")
            duration = f"{seconds // 3600}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"
        calories = session.get("calories_kcal")
        if calories is not None and (isinstance(calories, bool) or not isinstance(calories, (int, float)) or not math.isfinite(calories) or not 0 < calories <= 20000):
            raise WorkbookError("calories_kcal 必须是 0–20000 之间的大卡数。")
        if distance is None and duration is None and calories is None:
            raise WorkbookError("距离、用时、热量至少要有一项。")
        notes = session.get("notes", "")
        if not isinstance(notes, str) or len(notes) > 2000 or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", notes):
            raise WorkbookError("notes 必须是有效的文字，最长 2000 字。")
        result.append({"date": day.isoformat(), "activity": activity.strip(), "distance_km": None if distance is None else float(distance),
                       "duration": duration, "calories_kcal": None if calories is None else float(calories), "notes": notes.strip()})
    return result


def _cardio_sheet_xml() -> str:
    """An empty Cardio sheet with title and header rows styled like the lift sheets."""
    header = "".join(f'<c r="{column}2" s="{6 if column == "A" else 3}" t="inlineStr"><is><t>{escape(title)}</t></is></c>' for column, title in zip("ABCDEF", CARDIO_HEADERS))
    widths = (15.28515625, 16.7109375, 13.7109375, 10.7109375, 15.7109375, 26.85546875)
    cols = "".join(f'<col min="{n}" max="{n}" width="{w}" customWidth="1"/>' for n, w in enumerate(widths, 1))
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            f'<worksheet xmlns="{NS["m"]}" xmlns:r="{REL_NS}"><dimension ref="A1:F2"/>'
            f'<sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>{cols}</cols>'
            f'<sheetData><row r="1" spans="1:6"><c r="A1" s="33" t="inlineStr"><is><t>CARDIO</t></is></c></row>'
            f'<row r="2" spans="1:6" s="4" customFormat="1">{header}</row></sheetData>'
            '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>')


def _add_worksheet(source: ZipFile, changed: dict[str, bytes], name: str, sheet_xml: str) -> str:
    """Register a new worksheet in the workbook, its relationships and content types; return its part."""
    names = set(source.namelist())
    workbook = source.read("xl/workbook.xml").decode("utf-8")
    if f'xmlns:r="{REL_NS}"' not in workbook or "</sheets>" not in workbook:
        raise WorkbookError("工作簿结构不支持自动添加工作表。")
    rels = source.read("xl/_rels/workbook.xml.rels").decode("utf-8")
    types = source.read("[Content_Types].xml").decode("utf-8")
    sheet_ids = [int(sheet.get("sheetId")) for sheet in ET.fromstring(workbook.encode("utf-8")).findall("m:sheets/m:sheet", NS)]
    rel_numbers = [int(number) for number in re.findall(r'Id="rId(\d+)"', rels)]
    number = 1
    while f"xl/worksheets/sheet{number}.xml" in names:
        number += 1
    part, rel_id = f"xl/worksheets/sheet{number}.xml", f"rId{max(rel_numbers + [0]) + 1}"
    workbook = workbook.replace("</sheets>", f'<sheet name="{escape(name)}" sheetId="{max(sheet_ids + [0]) + 1}" r:id="{rel_id}"/></sheets>', 1)
    rels = rels.replace("</Relationships>", f'<Relationship Id="{rel_id}" Type="{REL_NS}/worksheet" Target="worksheets/sheet{number}.xml"/></Relationships>', 1)
    types = types.replace("</Types>", f'<Override PartName="/{part}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>', 1)
    changed.update({"xl/workbook.xml": workbook.encode("utf-8"), "xl/_rels/workbook.xml.rels": rels.encode("utf-8"),
                    "[Content_Types].xml": types.encode("utf-8"), part: sheet_xml.encode("utf-8")})
    if "docProps/app.xml" in names:
        app = source.read("docProps/app.xml").decode("utf-8")
        # Keep the document summary's sheet list in step when it lists worksheets only.
        if '<HeadingPairs><vt:vector size="2"' in app and "<vt:lpstr>Worksheets</vt:lpstr>" in app:
            app = re.sub(r"(<vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>)(\d+)", lambda m: m[1] + str(int(m[2]) + 1), app, count=1)
            app = re.sub(r'(<TitlesOfParts><vt:vector size=")(\d+)("[^>]*>.*?)(</vt:vector>)', lambda m: m[1] + str(int(m[2]) + 1) + m[3] + f"<vt:lpstr>{escape(name)}</vt:lpstr>" + m[4], app, count=1, flags=re.S)
            changed["docProps/app.xml"] = app.encode("utf-8")
    return part


def build_cardio_update(path: Path, sessions: list[dict], destination: Path) -> list[dict]:
    """Append sessions to the Cardio sheet, creating that sheet on first use."""
    with ZipFile(path) as source:
        paths, is_1904 = sheet_paths(source)
        changed = {}
        part = paths[CARDIO_SHEET] if CARDIO_SHEET in paths else _add_worksheet(source, changed, CARDIO_SHEET, _cardio_sheet_xml())
        styles, date_style = _date_style(source.read("xl/styles.xml"))
        styles, time_styles = _number_format_variants(styles, {32}, "[h]:mm:ss")
        changed["xl/styles.xml"] = styles
        text = (changed[part] if part in changed else source.read(part)).decode("utf-8")
        values = [[excel_date(r["date"], is_1904), r["activity"], r["distance_km"], _duration_seconds(r["duration"]) / 86400 if r["duration"] else None,
                   r["calories_kcal"], r["notes"]] for r in sessions]
        text, rows = _append_rows(text, CARDIO_SHEET, values, [date_style, 32, 32, time_styles[32], 32, 32])
        changed[part] = text.encode("utf-8")
        _write_candidate(source, destination, changed)
    _check_candidate(destination, changed)
    with ZipFile(destination) as check:
        if CARDIO_SHEET not in sheet_paths(check)[0]:
            raise WorkbookError("生成的文件中没有 Cardio 工作表。")
    return [{"sheet": CARDIO_SHEET, "range": f"A{row}:F{row}", "record": session} for row, session in zip(rows, sessions)]


def _text_of(cell: str, strings: list[str]) -> str:
    """Displayed text of one worksheet <c> element (shared, inline or plain value)."""
    if re.search(r'\st="s"', cell):
        index = re.search(r"<v>(\d+)</v>", cell)
        return strings[int(index.group(1))] if index and int(index.group(1)) < len(strings) else ""
    if re.search(r'\st="inlineStr"', cell):
        return unescape("".join(re.findall(r"<t\b[^>]*>(.*?)</t>", cell, re.S)))
    value = re.search(r"<v>(.*?)</v>", cell, re.S)
    return unescape(value.group(1)) if value else ""


def _shared_strings(archive: ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in archive.namelist():
        return []
    return ["".join(t.text or "" for t in item.iter(f"{{{NS['m']}}}t")) for item in ET.fromstring(archive.read("xl/sharedStrings.xml"))]


def _find_cell(text: str, ref: str):
    return re.search(rf'<c r="{ref}"(?=[\s/>])[^>]*?(?:/>|>.*?</c>)', text, re.S)


def _write_candidate(source: ZipFile, destination: Path, changed: dict[str, bytes]):
    """Copy every archive member, replacing changed ones; members new to the archive go last."""
    names = set(source.namelist())
    with ZipFile(destination, "w") as output:
        output.comment = source.comment
        for entry in source.infolist():
            output.writestr(entry, changed.get(entry.filename, source.read(entry.filename)))
        for name, data in changed.items():
            if name not in names:
                output.writestr(ZipInfo(name, date_time=datetime.now().timetuple()[:6]), data, compress_type=ZIP_DEFLATED)


def _check_candidate(destination: Path, members):
    with ZipFile(destination) as check:
        if check.testzip():
            raise WorkbookError("生成的文件未通过 ZIP 完整性校验。")
        for member in members:
            ET.fromstring(check.read(member))


def build_set_dates(path: Path, changes: list[dict], destination: Path) -> list[dict]:
    """Rewrite date cells (column A) as real dates shown as yyyy-mm-dd; each must still hold ``from``."""
    with ZipFile(path) as source:
        paths, is_1904 = sheet_paths(source)
        strings = _shared_strings(source)
        texts, bases = {}, {}
        for change in changes:
            name, ref = change["sheet"], f"A{change['row']}"
            if name not in paths:
                raise WorkbookError(f"找不到工作表：{name}")
            if name not in texts:
                texts[name] = source.read(paths[name]).decode("utf-8")
                if ET.fromstring(texts[name]).find("m:sheetProtection", NS) is not None:
                    raise WorkbookError(f"{name} 已保护，不能修改。")
            match = _find_cell(texts[name], ref)
            cell = match.group(0) if match else ""
            if "<f>" in cell or "<f " in cell:
                raise WorkbookError(f"{name}!{ref} 是公式，不能直接改日期。")
            current, expected = _text_of(cell, strings), change["from"]
            is_text = bool(re.search(r'\st="(?:s|inlineStr|str)"', cell))
            try:
                same = current == expected if is_text else not isinstance(expected, str) and float(current) == float(expected)
            except ValueError:
                same = False
            if not match or is_text != isinstance(expected, str) or not same:
                raise WorkbookError(f"{name}!{ref} 当前是“{current}”，不是预期的“{expected}”，未做任何修改。")
            style = re.search(r'\ss="(\d+)"', cell)
            bases[(name, ref)] = int(style.group(1)) if style else 0
        styles, variants = _iso_date_variants(source.read("xl/styles.xml"), set(bases.values()))
        updates = []
        for change in changes:
            name, ref = change["sheet"], f"A{change['row']}"
            match = _find_cell(texts[name], ref)
            cell = f'<c r="{ref}" s="{variants[bases[(name, ref)]]}"><v>{excel_date(change["to"], is_1904)}</v></c>'
            texts[name] = texts[name][:match.start()] + cell + texts[name][match.end():]
            updates.append({"sheet": name, "cell": ref, "from": change["from"], "to": change["to"]})
        changed = {"xl/styles.xml": styles, **{paths[name]: text.encode("utf-8") for name, text in texts.items()}}
        _write_candidate(source, destination, changed)
    _check_candidate(destination, changed)
    return updates


def build_rename(path: Path, sheet: str, rows: list[int], old: str, new: str, destination: Path) -> list[dict]:
    """Change exercise names (column B) in place; rows inside a merged B range use its first cell."""
    with ZipFile(path) as source:
        paths, _ = sheet_paths(source)
        if sheet not in paths:
            raise WorkbookError(f"找不到工作表：{sheet}")
        text = source.read(paths[sheet]).decode("utf-8")
        root = ET.fromstring(text)
        if root.find("m:sheetProtection", NS) is not None:
            raise WorkbookError(f"{sheet} 已保护，不能修改。")
        strings = _shared_strings(source)
        merged = {}
        for merge in root.findall("m:mergeCells/m:mergeCell", NS):
            match = re.fullmatch(r"B(\d+):B(\d+)", merge.get("ref", ""))
            if match:
                for row in range(int(match[1]), int(match[2]) + 1):
                    merged[row] = (int(match[1]), int(match[2]))
        updates = []
        for first in sorted({merged.get(row, (row, row))[0] for row in rows}):
            ref = f"B{first}"
            match = _find_cell(text, ref)
            current = _text_of(match.group(0), strings) if match else ""
            if not match or current != old:
                raise WorkbookError(f"{sheet}!{ref} 当前是“{current}”，不是“{old}”，未做任何修改。")
            if "<f>" in match.group(0) or "<f " in match.group(0):
                raise WorkbookError(f"{sheet}!{ref} 是公式，不能直接改名。")
            style = re.search(r'\ss="(\d+)"', match.group(0))
            style_attr = f' s="{style.group(1)}"' if style else ""
            if new in strings:
                cell = f'<c r="{ref}"{style_attr} t="s"><v>{strings.index(new)}</v></c>'
            else:
                cell = f'<c r="{ref}"{style_attr} t="inlineStr"><is><t xml:space="preserve">{escape(new)}</t></is></c>'
            text = text[:match.start()] + cell + text[match.end():]
            last = merged.get(first, (first, first))[1]
            updates.append({"sheet": sheet, "range": ref if last == first else f"{ref}:B{last}", "from": old, "to": new})
        _write_candidate(source, destination, {paths[sheet]: text.encode("utf-8")})
    _check_candidate(destination, [paths[sheet]])
    return updates


def _state_dir(path: Path) -> Path:
    return path.parent / '.powerlog' / path.name


def _save_json(path: Path, value: dict):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w', encoding='utf-8', newline='\n') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


@contextmanager
def _locked(path: Path):
    lock = path.with_name(path.name + '.powerlog.lock')
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        raise WorkbookError("另一次更新正在运行。如上次意外中止，先确认没有运行中的 PowerLog，再移除同名 .powerlog.lock 文件。") from None
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(str(os.getpid()))
        if path.with_name('~$' + path.name).exists():
            raise WorkbookError("工作簿正在 Excel 中打开，请关闭后再更新。")
        yield
    finally:
        lock.unlink(missing_ok=True)


def _history(state: Path, current_hash: str) -> list[dict]:
    entries = []
    for entry_path in sorted(state.glob('*.json')):
        entry = json.loads(entry_path.read_text(encoding='utf-8'))
        if entry['status'] == 'undo_pending':
            if entry['before_sha256'] == current_hash:
                entry['status'] = 'undone'
            elif entry['after_sha256'] == current_hash:
                entry['status'] = 'committed'
            else:
                raise WorkbookError("存在未完成的撤销且文件已被外部修改，请先检查 .powerlog 中的备份。")
            _save_json(entry_path, entry)
        if entry['status'] == 'pending':
            if entry['after_sha256'] == current_hash:
                entry['status'] = 'committed'
            elif entry['before_sha256'] == current_hash:
                entry['status'] = 'aborted'
            else:
                raise WorkbookError("存在未完成的更新且文件已被外部修改，请先检查 .powerlog 中的备份。")
            _save_json(entry_path, entry)
        entry['_path'] = entry_path
        entries.append(entry)
    return entries


def append_records(path: Path | str, records: list[dict], *, dry_run: bool = False, request_id: str | None = None, allow_duplicate: bool = False) -> dict:
    return _append(Path(path).resolve(), normalize_records(records), build_update, dry_run, request_id, allow_duplicate)


def append_cardio(path: Path | str, sessions: list[dict], *, dry_run: bool = False, request_id: str | None = None, allow_duplicate: bool = False) -> dict:
    """Append cardio sessions to the Cardio sheet (created on first use), with the same safety as lift records."""
    return _append(Path(path).resolve(), normalize_cardio(sessions), build_cardio_update, dry_run, request_id, allow_duplicate)


def _append(path: Path, records: list[dict], build, dry_run: bool, request_id: str | None, allow_duplicate: bool) -> dict:
    fingerprint = digest(json.dumps(records, ensure_ascii=False, sort_keys=True).encode('utf-8'))
    request_id = request_id or fingerprint
    if not path.is_file():
        raise WorkbookError(f"工作簿不存在：{path}")
    with _locked(path):
        before = path.read_bytes()
        before_hash = digest(before)
        state = _state_dir(path)
        entries = _history(state, before_hash)
        for entry in entries:
            if entry['status'] == 'committed' and entry['action'] == 'append':
                same_id = entry['request_id'] == request_id
                same_content = entry['fingerprint'] == fingerprint
                if same_id and not same_content:
                    raise WorkbookError("同一 request-id 对应不同数据，已拒绝覆盖。")
                if (same_id or same_content) and not allow_duplicate:
                    return {"status": "duplicate", "message": "这组数据已经写入，未重复追加。", "updates": entry['updates']}
        fd, temp_name = tempfile.mkstemp(prefix='.powerlog-', suffix='.xlsx', dir=path.parent)
        os.close(fd)
        candidate = Path(temp_name)
        try:
            updates = build(path, records, candidate)
            if dry_run:
                return {"status": "preview", "workbook": str(path), "updates": updates}
            backup = _commit(path, before, before_hash, state, candidate, {"action": "append", "request_id": request_id, "fingerprint": fingerprint, "updates": updates})
            return {"status": "saved", "workbook": str(path), "backup": str(backup), "updates": updates}
        finally:
            candidate.unlink(missing_ok=True)


def _commit(path: Path, before: bytes, before_hash: str, state: Path, candidate: Path, details: dict) -> Path:
    """Back up, journal and atomically replace the workbook with a verified candidate."""
    if digest(path.read_bytes()) != before_hash:
        raise WorkbookError("工作簿在更新过程中被修改，已取消本次写入，请重试。")
    state.mkdir(parents=True, exist_ok=True)
    event_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '-' + uuid.uuid4().hex[:8]
    backup = state / (event_id + '.xlsx')
    with backup.open('xb') as stream:
        stream.write(before)
        stream.flush()
        os.fsync(stream.fileno())
    event_path = state / (event_id + '.json')
    event = {"id": event_id, **details, "status": "pending", "before_sha256": before_hash, "after_sha256": digest(candidate.read_bytes()), "backup": backup.name}
    _save_json(event_path, event)
    if digest(path.read_bytes()) != before_hash or path.with_name('~$' + path.name).exists():
        event['status'] = 'aborted'
        _save_json(event_path, event)
        raise WorkbookError("工作簿在保存前已被修改或打开，已取消本次写入。")
    try:
        os.replace(candidate, path)
    except PermissionError:
        event['status'] = 'aborted'
        _save_json(event_path, event)
        raise WorkbookError("无法写入工作簿，请关闭 Excel 或其他占用此文件的程序后重试。") from None
    event['status'] = 'committed'
    _save_json(event_path, event)
    return backup


def rename_exercise(path: Path | str, sheet: str, rows: list[int], old: str, new: str, *, dry_run: bool = False) -> dict:
    """Correct exercise names in existing rows; only cells that currently read ``old`` change."""
    path = Path(path).resolve()
    if sheet not in SHEETS.values():
        raise WorkbookError("sheet 必须是 " + "、".join(SHEETS.values()) + "。")
    if not isinstance(new, str) or not new.strip() or len(new) > 2000 or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", new):
        raise WorkbookError("新动作名必须是有效的文字，最长 2000 字。")
    new = new.strip()
    if not rows or any(not isinstance(row, int) or row <= 2 for row in rows):
        raise WorkbookError("请提供表头以下的行号。")
    if not path.is_file():
        raise WorkbookError(f"工作簿不存在：{path}")
    return _apply_edit(path, lambda candidate: build_rename(path, sheet, rows, old, new, candidate), dry_run)


def set_dates(path: Path | str, changes: list[dict], *, dry_run: bool = False) -> dict:
    """Rewrite existing date cells as explicit yyyy-mm-dd dates, e.g. to settle legacy day/month order.

    Each change is ``{"sheet", "row", "from", "to"}``; ``from`` is the cell's current value
    (Excel serial number or text) and every cell must still hold it, or nothing changes.
    """
    path = Path(path).resolve()
    if not isinstance(changes, list) or not 1 <= len(changes) <= 5000:
        raise WorkbookError("请提供 1–5000 个日期更正。")
    normalized, seen = [], set()
    for change in changes:
        if not isinstance(change, dict) or set(change) != {"sheet", "row", "from", "to"}:
            raise WorkbookError("每个日期更正必须只有 sheet、row、from、to 四个字段。")
        sheet, row, old = change["sheet"], change["row"], change["from"]
        if sheet not in SHEETS.values() or isinstance(row, bool) or not isinstance(row, int) or row <= 2 or (sheet, row) in seen:
            raise WorkbookError(f"日期更正的位置无效：{sheet} 第 {row} 行。")
        if isinstance(old, bool) or not isinstance(old, (str, int, float)):
            raise WorkbookError(f"{sheet} 第 {row} 行缺少当前值。")
        try:
            day = date.fromisoformat(change["to"])
        except (TypeError, ValueError):
            raise WorkbookError(f"{sheet} 第 {row} 行的新日期必须是 YYYY-MM-DD。") from None
        if not 1900 <= day.year <= 2100:
            raise WorkbookError(f"{sheet} 第 {row} 行的新日期年份超出 1900–2100。")
        seen.add((sheet, row))
        normalized.append({"sheet": sheet, "row": row, "from": old, "to": day.isoformat()})
    if not path.is_file():
        raise WorkbookError(f"工作簿不存在：{path}")
    return _apply_edit(path, lambda candidate: build_set_dates(path, normalized, candidate), dry_run)


def _apply_edit(path: Path, build, dry_run: bool) -> dict:
    """Run one journaled, undoable correction of existing cells."""
    with _locked(path):
        before = path.read_bytes()
        before_hash = digest(before)
        state = _state_dir(path)
        _history(state, before_hash)
        fd, temp_name = tempfile.mkstemp(prefix='.powerlog-', suffix='.xlsx', dir=path.parent)
        os.close(fd)
        candidate = Path(temp_name)
        try:
            updates = build(candidate)
            if dry_run:
                return {"status": "preview", "workbook": str(path), "updates": updates}
            backup = _commit(path, before, before_hash, state, candidate, {"action": "edit", "updates": updates})
            return {"status": "saved", "workbook": str(path), "backup": str(backup), "updates": updates}
        finally:
            candidate.unlink(missing_ok=True)


def undo_last(path: Path | str) -> dict:
    path = Path(path).resolve()
    with _locked(path):
        current_hash = digest(path.read_bytes())
        entries = _history(_state_dir(path), current_hash)
        active = [e for e in entries if e['status'] == 'committed' and e['action'] in ('append', 'edit')]
        if not active:
            raise WorkbookError("没有可以撤销的 PowerLog 写入。")
        event = active[-1]
        if current_hash != event['after_sha256']:
            raise WorkbookError("文件在最近一次写入后已被修改。为保护后续更改，不能自动撤销；原始备份仍保留。")
        backup = _state_dir(path) / event['backup']
        data = backup.read_bytes()
        if digest(data) != event['before_sha256']:
            raise WorkbookError("备份校验失败，未修改工作簿。")
        fd, temp_name = tempfile.mkstemp(prefix='.powerlog-undo-', suffix='.xlsx', dir=path.parent)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            event_path = event.pop('_path')
            event['status'] = 'undo_pending'
            _save_json(event_path, event)
            if digest(path.read_bytes()) != current_hash:
                event['status'] = 'committed'
                _save_json(event_path, event)
                raise WorkbookError("工作簿在撤销过程中被修改，已取消撤销。")
            os.replace(temp_name, path)
            event['status'] = 'undone'
            _save_json(event_path, event)
        finally:
            Path(temp_name).unlink(missing_ok=True)
        return {"status": "undone", "workbook": str(path), "updates": event['updates']}
