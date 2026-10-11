"""Local command line entry point. No web service or account required."""
import argparse
from datetime import date
import json
from pathlib import Path
import sys

from .parser import ParseError, parse_training
from .workbook import WorkbookError, append_records, rename_exercise, undo_last


def _rows(value: str) -> list[int]:
    rows = []
    for part in value.split(','):
        first, _, last = part.strip().partition('-')
        rows.extend(range(int(first), int(last or first) + 1))
    return rows


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description='PowerLog：聊天训练记录写入本地 Excel')
    parser.add_argument('--workbook', type=Path, default=Path(__file__).resolve().parent.parent / 'HylPowerliftingTraining.xlsx')
    commands = parser.add_subparsers(dest='command', required=True)
    append = commands.add_parser('add', help='追加训练记录')
    source = append.add_mutually_exclusive_group(required=True)
    source.add_argument('--text', help='中文或英文训练记录')
    source.add_argument('--json', type=Path, help='结构化 JSON 数组文件；- 表示标准输入')
    append.add_argument('--today', type=date.fromisoformat, help='相对日期基准 YYYY-MM-DD，默认澳大利亚悉尼今天')
    append.add_argument('--dry-run', action='store_true', help='仅预览目标单元格，不修改工作簿')
    append.add_argument('--request-id', help='调用方请求 ID，避免重复写入')
    append.add_argument('--allow-duplicate', action='store_true', help='明确确认这是另一批相同训练时使用')
    rename = commands.add_parser('rename-exercise', help='更正已有行的动作名（B列），只改当前值等于 --from 的单元格')
    rename.add_argument('--sheet', required=True, help='工作表，如 2025-B')
    rename.add_argument('--rows', required=True, type=_rows, help='行号，如 55-59 或 55,58；合并单元格按首行修改')
    rename.add_argument('--from', dest='old', required=True, help='当前动作名，必须完全一致')
    rename.add_argument('--to', dest='new', required=True, help='新动作名')
    rename.add_argument('--dry-run', action='store_true', help='仅预览，不修改工作簿')
    commands.add_parser('undo', help='撤销最近一次写入或更正，外部修改后不会自动覆盖')
    args = parser.parse_args()
    try:
        if args.command == 'undo':
            result = undo_last(args.workbook)
        elif args.command == 'rename-exercise':
            result = rename_exercise(args.workbook, args.sheet, args.rows, args.old, args.new, dry_run=args.dry_run)
        else:
            if args.text is not None:
                records = parse_training(args.text, base_date=args.today)
            else:
                payload = sys.stdin.read() if str(args.json) == '-' else args.json.read_text(encoding='utf-8-sig')
                records = json.loads(payload)
            result = append_records(args.workbook, records, dry_run=args.dry_run, request_id=args.request_id, allow_duplicate=args.allow_duplicate)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (WorkbookError, ParseError, OSError, ValueError) as error:
        print(json.dumps({'status': 'error', 'message': str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
