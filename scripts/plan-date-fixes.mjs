// Plan explicit yyyy-mm-dd dates for every legacy date cell, using the dashboard's
// chronological inference. Read-only: prints a JSON array for
// `python -m powerlog set-dates --json <file>`. Refuses if any legacy date is still ambiguous.
import { exportRows } from './snapshot.mjs';

const python = process.argv[2] || 'python';
const { raw, reader } = await exportRows(python);
const plan = [], unresolved = [];
for (const sheet of raw.sheets) {
  const anchors = new Map();
  for (const row of sheet.rows) {
    if (row.row <= 2 || row.values[0] === '' || row.values[0] == null) continue;
    const anchor = row.dateAnchor ?? row.row;
    if (!anchors.has(anchor)) anchors.set(anchor, { row: anchor, value: row.values[0], numberFormat: row.numberFormat });
  }
  const entries = [...anchors.values()].sort((a, b) => a.row - b.row);
  const { dates } = reader.inferDateSequence(entries, { date1904: raw.date1904 });
  for (const entry of entries) {
    if (typeof entry.value === 'number' && reader.isoNumberFormat(entry.numberFormat)) continue; // Already explicit.
    const result = dates.get(entry.row);
    if (result?.date) plan.push({ sheet: sheet.name, row: entry.row, from: entry.value, to: result.date });
    else unresolved.push(`${sheet.name}!A${entry.row}（${entry.value}）：${result?.reason || '无法确定'}`);
  }
}
if (unresolved.length) {
  console.error(`以下日期无法唯一确定，请先人工确认：\n${unresolved.join('\n')}`);
  process.exit(1);
}
console.log(JSON.stringify(plan));
