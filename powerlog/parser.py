"""Strict, deterministic parsing for conversational training entries.

The compact form is always weight x repetitions x sets. Missing dates use the
Sydney calendar date (or ``base_date``). Dates and exercise names carry forward
within one message. Unknown text is an error, never silently discarded.
"""

from __future__ import annotations

import math
import re
import unicodedata
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


class ParseError(ValueError):
    """A message cannot be converted into unambiguous training records."""


_NUMBER = r"(?:\d+(?:\.\d+)?|\.\d+)"
_UNIT = r"(?:kg|公斤|千克|lbs?|磅)"
_TIMES = r"[xX×*]"
_DATE = re.compile(r"^(?P<value>\d{4}-\d{2}-\d{2}|今天|昨天|前天)(?!\d)")
_RPE = re.compile(rf"(?<![a-z])rpe\s*[:=]?\s*(?P<value>{_NUMBER})(?![\d.])", re.I)
_NOTES = re.compile(r"(?:备注|notes?)\s*[:：]\s*", re.I)
_EDIT = re.compile(r"更正|改为|改成|改一下|修改|删除|删掉|撤销|取消|作废|纠正|correct|delete|remove|undo|replace|update", re.I)

# Exact names avoid mapping an unknown/ambiguous movement to a competition lift.
# The workbook records exercises with the English names already used in its
# history; Chinese or alternative spellings are chat aliases only.
_EXERCISES: dict[str, tuple[str, str]] = {}
for _code, _name, _aliases in (
    ("S", "Comp Squat", ("comp squat", "深蹲", "squat", "s")),
    ("S", "High-bar Squat", ("high-bar squat", "high bar squat", "高杠深蹲")),
    ("S", "Low-bar Squat", ("low-bar squat", "low bar squat", "低杠深蹲")),
    ("S", "Pause Squat", ("pause squat", "paused squat", "暂停深蹲")),
    ("S", "High-bar Pause Squat", ("high-bar pause squat", "high bar pause squat", "高杠暂停深蹲")),
    ("S", "Pin Squat", ("pin squat", "架上深蹲")),
    ("S", "Pin Squat (low)", ("pin squat (low)",)),
    ("S", "Pin Squat (high)", ("pin squat (high)",)),
    ("S", "Front Squat", ("front squat", "前蹲")),
    ("S", "Box Squat", ("box squat", "箱式深蹲")),
    ("S", "Split Squat", ("split squat", "分腿蹲")),
    ("B", "Comp Bench", ("comp bench", "卧推", "bench press", "bench", "b")),
    ("B", "Pause Bench", ("pause bench", "paused bench press", "paused bench", "暂停卧推")),
    ("B", "Larsen Bench", ("larsen bench", "拉森卧推")),
    ("B", "Larsen Press", ("larsen press",)),
    ("B", "Spoto Press", ("spoto press", "悬停卧推")),
    ("B", "Close-grip Bench", ("close-grip bench press", "close-grip bench", "close grip bench press", "close grip bench", "窄握卧推")),
    ("B", "Wide-grip Bench", ("wide-grip bench", "wide grip bench", "宽握卧推")),
    ("B", "Touch-and-go Bench", ("touch-and-go bench", "touch and go bench", "触胸卧推")),
    ("B", "Incline Bench", ("incline bench press", "incline bench", "上斜卧推")),
    ("B", "Dumbbell Bench", ("dumbbell bench", "哑铃卧推")),
    ("B", "Dumbbell Press", ("dumbbell press",)),
    ("B", "Overhead Press", ("overhead press", "推举")),
    ("B", "Shoulder Press", ("shoulder press", "肩推")),
    ("D", "Comp Deadlift", ("comp deadlift", "硬拉", "deadlift", "d")),
    ("D", "Conv Deadlift", ("conv deadlift", "conventional deadlift", "传统硬拉")),
    ("D", "Sumo Deadlift", ("sumo deadlift", "相扑硬拉")),
    ("D", "RDL", ("rdl", "romanian deadlift", "罗马尼亚硬拉")),
    ("D", "Sumo RDL", ("sumo rdl",)),
    ("D", "Stiff-leg Deadlift", ("stiff-leg deadlift", "stiff leg deadlift", "直腿硬拉")),
    ("D", "Pause Deadlift", ("pause deadlift", "paused deadlift", "暂停硬拉")),
    ("D", "Pause Conv Deadlift", ("pause conv deadlift",)),
    ("D", "Tempo Deadlift", ("tempo deadlift", "节奏硬拉")),
    ("D", "Deficit Deadlift", ("deficit deadlift", "垫高硬拉")),
):
    for _alias in _aliases:
        _EXERCISES[_alias] = (_code, _name)
_EXERCISE_NAMES = sorted(_EXERCISES, key=len, reverse=True)

# An explicit unit or whitespace must separate weight from reps in the second
# and third patterns. Otherwise "1405次3组" could be split at an arbitrary digit.
_WEIGHT_WITH_SEPARATOR = rf"(?P<weight>{_NUMBER})(?:\s*(?P<unit>{_UNIT})\s*|\s+)"
_WORK_PATTERNS = (
    re.compile(rf"(?P<weight>{_NUMBER})\s*(?P<unit>{_UNIT})?\s*{_TIMES}\s*(?P<reps>\d+)\s*(?:次|reps?)?\s*{_TIMES}\s*(?P<sets>\d+)\s*(?:组|sets?)?", re.I),
    re.compile(rf"{_WEIGHT_WITH_SEPARATOR}(?P<reps>\d+)\s*次\s*(?:{_TIMES}\s*)?(?P<sets>\d+)\s*组", re.I),
    re.compile(rf"{_WEIGHT_WITH_SEPARATOR}(?P<sets>\d+)\s*组\s*(?:{_TIMES}\s*)?(?P<reps>\d+)\s*次", re.I),
    re.compile(rf"{_WEIGHT_WITH_SEPARATOR}(?P<reps>\d+)\s*(?:次|reps?)?\s*{_TIMES}\s*(?P<sets>\d+)\s*(?:组|sets?)?", re.I),
)


def _sydney_today() -> date:
    """Resolve Sydney's date even on Windows without an IANA tzdata package."""
    now = datetime.now(timezone.utc)
    try:
        return now.astimezone(ZoneInfo("Australia/Sydney")).date()
    except ZoneInfoNotFoundError:
        # Sydney's current rule: DST ends on April's first Sunday and starts
        # on October's first Sunday, both at 16:00 UTC on the preceding day.
        def transition(month: int) -> datetime:
            first = date(now.year, month, 1)
            sunday = first + timedelta(days=(6 - first.weekday()) % 7)
            return datetime.combine(sunday, datetime.min.time(), timezone.utc) - timedelta(hours=8)

        daylight = now < transition(4) or now >= transition(10)
        return (now + timedelta(hours=11 if daylight else 10)).date()


def _exercise_at_start(text: str) -> tuple[tuple[str, str] | None, str]:
    lower = text.lower()
    for name in _EXERCISE_NAMES:
        if not lower.startswith(name):
            continue
        rest = text[len(name):]
        # English names and single-letter aliases must be complete tokens.
        if name.isascii() and rest and rest[0].isalpha():
            continue
        if name in ("s", "b", "d") and rest and not (rest[0].isspace() or rest[0] == ":"):
            continue
        return _EXERCISES[name], rest.lstrip(" :")
    return None, text


def _positive_integer(value: str, label: str) -> int:
    try:
        result = int(value)
    except ValueError as exc:
        raise ParseError(f"{label}必须是正整数。") from exc
    if result <= 0:
        raise ParseError(f"{label}必须是正整数。")
    return result


def parse_training(text: str, base_date: date | None = None) -> list[dict]:
    """Parse complete records; reject the entire message if any part is invalid.

    Examples: ``今天 深蹲 140kg 5次×3组 RPE8；卧推 90kg 3次×4组``
    or ``2026-10-04 S 140x5x3, 145x3x2``. Unlabelled three-part values mean
    weight, reps, sets, in that order. Kilograms are the default. Explicit pounds
    convert using 1 lb = 0.45359237 kg. Notes require ``备注:`` or ``notes:``.
    """
    if not isinstance(text, str) or not text.strip():
        raise ParseError("请输入训练日期、动作、重量、次数和组数。")
    if base_date is not None and (not isinstance(base_date, date) or isinstance(base_date, datetime)):
        raise ParseError("base_date 必须是 date 类型。")
    normalized = unicodedata.normalize("NFKC", text).strip()
    if _EDIT.search(normalized):
        raise ParseError("更正或删除指令不能作为新训练记录，请明确要修改的原记录。")
    reference = base_date if base_date is not None else _sydney_today()
    current_date = reference
    current_exercise: tuple[str, str] | None = None
    records: list[dict] = []
    pending_header = False
    for line_number, part in enumerate(re.split(r"[,;；，\r\n]+", normalized), start=1):
        part = part.strip()
        if not part:
            continue
        match_date = _DATE.match(part)
        if match_date:
            value = match_date.group("value")
            try:
                current_date = (
                    reference - timedelta(days={"今天": 0, "昨天": 1, "前天": 2}[value])
                    if value in ("今天", "昨天", "前天") else date.fromisoformat(value)
                )
            except (ValueError, OverflowError) as exc:
                raise ParseError(f"第 {line_number} 条的日期无效。") from exc
            part = part[match_date.end():].lstrip(" :")
            if not part:
                pending_header = True
                continue
        exercise, part = _exercise_at_start(part)
        if exercise:
            current_exercise = exercise
            # A heading may establish the exercise for following rows.
            if not part:
                pending_header = True
                continue
        if current_exercise is None:
            raise ParseError(f"第 {line_number} 条缺少明确动作，请使用深蹲、卧推、硬拉或明确变式名称。")
        notes_match = _NOTES.search(part)
        notes = ""
        if notes_match:
            notes = part[notes_match.end():].strip()
            part = part[:notes_match.start()].strip()
        rpe_matches = list(_RPE.finditer(part))
        if len(rpe_matches) > 1:
            raise ParseError(f"第 {line_number} 条有多个 RPE，请拆成不同记录。")
        rpe = None
        if rpe_matches:
            rpe_match = rpe_matches[0]
            rpe = float(rpe_match.group("value"))
            if not math.isfinite(rpe) or not 0 <= rpe <= 10:
                raise ParseError(f"第 {line_number} 条的 RPE 必须在 0 到 10 之间。")
            part = (part[:rpe_match.start()] + " " + part[rpe_match.end():]).strip()
        workload = next((match for pattern in _WORK_PATTERNS if (match := pattern.fullmatch(part))), None)
        if workload is None:
            raise ParseError(f"第 {line_number} 条格式不明确，请使用“深蹲 140kg 5次×3组”或“深蹲 140x5x3”（重量×次数×组数）。")
        try:
            weight = Decimal(workload.group("weight"))
            if (workload.group("unit") or "kg").lower() in ("lb", "lbs", "磅"):
                weight *= Decimal("0.45359237")
            weight_kg = float(weight)
        except (InvalidOperation, OverflowError, ValueError) as exc:
            raise ParseError(f"第 {line_number} 条的重量无效。") from exc
        if not math.isfinite(weight_kg) or weight_kg <= 0:
            raise ParseError(f"第 {line_number} 条的重量必须是大于 0 的有限数字。")
        records.append({
            "date": current_date.isoformat(),
            "lift": current_exercise[0],
            "exercise": current_exercise[1],
            "weight_kg": weight_kg,
            "reps": _positive_integer(workload.group("reps"), "次数"),
            "sets": _positive_integer(workload.group("sets"), "组数"),
            "rpe": rpe,
            "notes": notes,
        })
        pending_header = False
    if not records:
        raise ParseError("没有找到完整训练记录，请补充重量、次数和组数。")
    if pending_header:
        raise ParseError("末尾的日期或动作没有对应训练数据，请补充重量、次数和组数。")
    return records

