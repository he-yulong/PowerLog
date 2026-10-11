import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../web/xlsx-reader.js', import.meta.url), 'utf8');
vm.runInThisContext(source);
const { parseDate, inferDateSequence, recordsFromRows, runsFromRows, unzip } = globalThis.PowerLogXlsx;

test('dates: ISO, both Excel epochs, leap-day bug, ambiguous strings and anomalous years', () => {
  assert.equal(parseDate(45660).date, '2025-01-03');
  assert.equal(parseDate(0, true, '2026-10-05').date, null); // Old dates are deliberately flagged.
  assert.equal(parseDate(44198, true).date, '2025-01-03');
  assert.equal(parseDate(60).date, null);
  assert.equal(parseDate('2026-10-04').date, '2026-10-04');
  assert.equal(parseDate('2026-02-30').date, null);
  assert.equal(parseDate('04/10/2026', false, '2026-10-05').date, '2026-10-04');
  assert.equal(parseDate('31/2/2026').date, null);
  assert.equal(parseDate('2036-10-04', false, '2026-10-05').date, null);
  assert.equal(parseDate('3036-10-04', false, '2026-10-05').date, null);
  assert.equal(parseDate('2026-12-09', false, '2026-10-05').date, null);
  assert.equal(parseDate('2026-10-06', false, '2026-10-05').date, null);
  assert.equal(parseDate('2026-10-05', false, '2026-10-05').date, '2026-10-05');
  assert.equal(parseDate('', false, '2026-10-05').reason, '缺少日期');
});

const serial = date => (Date.parse(date + 'T00:00:00Z') - Date.UTC(1899, 11, 30)) / 86400000;
const entry = (row, value, numberFormat = '') => ({ row, value, numberFormat });
test('chronology uniquely fixes month/day reversal and leaves ISO backfills authoritative', () => {
  const inferred = inferDateSequence([
    entry(3, '31/8/2026'),
    entry(4, serial('2026-03-09')),
    entry(5, '5/9/2026'),
    entry(6, serial('2025-02-03'), 'yyyy-mm-dd'),
    entry(7, '2025-01-01')
  ], { referenceDate: '2026-10-05' });
  assert.equal(inferred.completePath, true);
  assert.equal(inferred.dates.get(3).date, '2026-08-31');
  assert.equal(inferred.dates.get(4).date, '2026-09-03');
  assert.equal(inferred.dates.get(4).dateOriginal, '2026-03-09');
  assert.equal(inferred.dates.get(4).dateInferred, true);
  assert.equal(inferred.dates.get(6).date, '2025-02-03');
  assert.equal(inferred.dates.get(6).dateInferred, false);
  assert.equal(inferred.dates.get(7).date, '2025-01-01');
  assert.equal(inferred.dateCorrections.length, 1);
});

test('a bad year is repaired only with matching reasonable years on both sides', () => {
  const result = inferDateSequence([
    entry(3, serial('2026-07-15')),
    entry(4, serial('2036-07-17')),
    entry(5, serial('2026-07-21'))
  ], { referenceDate: '2026-10-05' });
  assert.equal(result.dates.get(4).date, '2026-07-17');
  assert.equal(result.dateCorrections.length, 1);
  assert.match(result.dateCorrections[0].reason, /年份/);
  const edge = inferDateSequence([entry(3, serial('2036-07-17')), entry(4, serial('2026-07-21'))], { referenceDate: '2026-10-05' });
  assert.equal(edge.completePath, false);
  assert.equal(edge.dateCorrections.length, 0);
  assert.equal(edge.dates.get(3).date, null);
});

test('ambiguous or inconsistent legacy sequences never pretend to identify a unique date', () => {
  const ambiguous = inferDateSequence([entry(3, serial('2026-03-09'))], { referenceDate: '2026-10-05' });
  assert.equal(ambiguous.completePath, true);
  assert.equal(ambiguous.dates.get(3).date, null);
  assert.match(ambiguous.dates.get(3).reason, /多种解释/);
  const reversed = inferDateSequence([entry(3, '20/8/2026'), entry(4, '18/8/2026')], { referenceDate: '2026-10-05' });
  assert.equal(reversed.completePath, false);
  assert.equal(reversed.dateCorrections.length, 0);
  assert.equal(reversed.dates.get(3).date, null);
});

test('merged date metadata yields one correction while every working row keeps the inferred date', () => {
  const rows = [
    { row: 3, dateAnchor: 3, values: ['31/8/2026', '深蹲', 160, 5, 3, '', '', 8] },
    { row: 4, dateAnchor: 4, values: [serial('2026-03-09'), '深蹲', 170, 3, 1, '', '', 8] },
    { row: 5, dateAnchor: 4, values: [serial('2026-03-09'), '深蹲', 170, 3, 1, '', '', 8] },
    { row: 6, dateAnchor: 6, values: ['5/9/2026', '深蹲', 160, 5, 3, '', '', 8] }
  ];
  const result = recordsFromRows(rows, '2025-S');
  assert.equal(result.dateCorrections.length, 1);
  assert.equal(result.dateCorrections[0].sheet, '2025-S');
  assert.equal(result.dateCorrections[0].row, 4);
  assert.equal(result.records[1].date, '2026-09-03');
  assert.equal(result.records[2].date, '2026-09-03');
  assert.equal(result.records[2].dateOriginal, '2026-03-09');
  assert.equal(result.records[2].dateInferred, true);
});

test('only complete valid working sets contribute to volume; manual Max remains original data', () => {
  const { records, warnings } = recordsFromRows([
    { row: 2, values: ['日期', '动作', '重量', '次数', '组数', 'Max', '备注', 'RPE'] },
    { row: 3, values: ['2026-10-04', '深蹲', 160, 5, 3, 'PR', '测试', 8] },
    { row: 4, values: ['', '', 165, 2, 1, 999, '', ''] },
    { row: 5, values: ['2026-10-04', '深蹲', -10, 3, 2, '', '', ''] },
    { row: 6, values: ['2026-10-04', '深蹲', 100, '', 2, '', '', ''] },
    { row: 7, values: ['2026-10-04', '深蹲', 100, 2.5, 2, '', '', ''] },
    { row: 8, values: ['', '', '', '', '', '', '', ''] }
  ], '2025-S');
  assert.equal(records.length, 5);
  assert.equal(records[0].volume, 2400);
  assert.equal(records[0].e1rm, 160 * (1 + 5 / 30));
  assert.equal(records[0].manualMax, 'PR');
  assert.equal(records[1].date, null);
  assert.equal(records[1].exercise, '未填写动作');
  assert.notEqual(records[1].e1rm, 999);
  assert.equal(records[2].volume, null);
  assert.equal(records[3].volume, null);
  assert.equal(records[4].volume, null);
  assert.equal(warnings.length, 4);
});

test('partial-range variants are flagged so best weight and 1RM can skip them', () => {
  const { records } = recordsFromRows([
    { row: 3, values: ['2025-07-03', 'Pin Squat (high)', 220, 1, 1, '', '', ''] },
    { row: 4, values: ['2025-07-05', 'Pin Squat (low)', 130, 3, 1, '', '', ''] },
    { row: 5, values: ['2025-07-05', 'Comp Squat', 200, 1, 1, '', '', ''] }
  ], '2025-S');
  assert.deepEqual(records.map(record => record.partialRange), [true, false, false]);
  assert.equal(records[0].volume, 220);
});

test('runs: distance, Excel or text times, pace and data issues', () => {
  const { runs, warnings } = runsFromRows([
    { row: 1, values: ['RUNNING', '', '', '', '', '', '', ''] },
    { row: 2, values: ['Date', 'Distance (km)', 'Time', 'Notes', '', '', '', ''] },
    { row: 3, values: [serial('2026-09-11'), 12, '', '', '', '', '', ''] },
    { row: 4, values: [serial('2026-09-12'), 10, (50 * 60) / 86400, 'tempo', '', '', '', ''] },
    { row: 5, values: ['2026-09-13', 21.1, '1:45:30', '', '', '', '', ''] },
    { row: 6, values: ['2026-09-14', '', '30:00', '', '', '', '', ''] },
    { row: 7, values: ['2026-09-15', 5, 'soon', '', '', '', '', ''] }
  ], false);
  assert.equal(runs.length, 5);
  assert.deepEqual([runs[0].date, runs[0].distance, runs[0].seconds, runs[0].pace], ['2026-09-11', 12, null, null]);
  assert.deepEqual([runs[1].seconds, runs[1].pace, runs[1].note], [3000, 300, 'tempo']);
  assert.equal(runs[2].seconds, 6330);
  assert.equal(runs[3].valid, false);
  assert.match(runs[4].issues.join(), /用时格式无效/);
  assert.equal(warnings.length, 2);
});

test('single-rep work uses actual weight and overflowing metrics are excluded', () => {
  const { records } = recordsFromRows([
    { row: 3, values: ['2025-01-03', '深蹲', 200, 1, 1, '', '', ''] },
    { row: 4, values: ['2025-01-03', '深蹲', 1e308, 10, 10, '', '', ''] },
    { row: 5, values: ['2036-01-03', '深蹲', 100, 5, 3, '', '', ''] }
  ], '2025-S');
  assert.equal(records[0].e1rm, 200);
  assert.equal(records[1].valid, false);
  assert.equal(records[1].volume, null);
  assert.equal(records[1].e1rm, null);
  assert.equal(records[2].date, null);
  assert.equal(records[2].dateRaw, '2036-01-03');
});

function crc32(bytes) {
  let crc = -1;
  for (const value of bytes) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ -1) >>> 0;
}
function zipSingle(name, content, compressed = false) {
  const filename = Buffer.from(name), data = Buffer.from(content), packed = compressed ? deflateRawSync(data) : data;
  const local = Buffer.alloc(30), directory = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(compressed ? 8 : 0, 8); local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
  directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(compressed ? 8 : 0, 10); directory.writeUInt32LE(crc32(data), 16); directory.writeUInt32LE(packed.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(filename.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(directory.length + filename.length, 12); end.writeUInt32LE(local.length + filename.length + packed.length, 16);
  const result = Buffer.concat([local, filename, packed, directory, filename, end]);
  return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength);
}
test('ZIP: stored and deflated entries decode with integrity validation', async () => {
  for (const compressed of [false, true]) {
    const zip = await unzip(zipSingle('test.xml', '<test>中文</test>', compressed));
    assert.equal(await zip.read('test.xml'), '<test>中文</test>');
    await assert.rejects(() => zip.read('missing.xml'), /缺少必要内容/);
  }
});
test('ZIP: truncation and corrupted payload are rejected', async () => {
  await assert.rejects(() => unzip(new ArrayBuffer(8)), /不是完整/);
  const bytes = zipSingle('test.xml', 'hello');
  new Uint8Array(bytes)[38] ^= 1;
  const zip = await unzip(bytes);
  await assert.rejects(() => zip.read('test.xml'), /校验失败/);
});
test('ZIP: existing workbook contains the expected worksheet parts', async () => {
  const bytes = await readFile(new URL('../HylPowerliftingTraining.xlsx', import.meta.url));
  const zip = await unzip(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.match(await zip.read('xl/workbook.xml'), /2025-S/);
  assert.match(await zip.read('xl/worksheets/sheet1.xml'), /mergeCells/);
});

test('real workbook: every date resolves to one date and the verified history dates hold', async () => {
  const bytes = await readFile(new URL('../HylPowerliftingTraining.xlsx', import.meta.url));
  const zip = await unzip(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  // This test extracts only date anchors (with their number formats) from the workbook.
  // Production worksheet parsing uses DOMParser and also carries merged-cell metadata.
  const sharedXml = await zip.read('xl/sharedStrings.xml');
  const strings = [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(match => [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(part => part[1]).join(''));
  const stylesXml = await zip.read('xl/styles.xml');
  const customFormats = new Map([...stylesXml.matchAll(/<numFmt\b([^>]*)\/>/g)].map(match => [/numFmtId="(\d+)"/.exec(match[1])[1], /formatCode="([^"]*)"/.exec(match[1])[1]]));
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)[1];
  const formats = [...cellXfs.matchAll(/<xf\b([^>]*?)\/?>/g)].map(match => customFormats.get(/numFmtId="(\d+)"/.exec(match[1])?.[1]) || '');
  // Dates confirmed by the user while auditing the original history (sheet1 = S, sheet2 = B, sheet3 = D).
  const verified = { 1: { 294: '2026-03-10' }, 2: { 618: '2026-03-10', 827: '2026-09-05' }, 3: { 270: '2026-03-10', 317: '2026-07-17' } };
  for (const [sheet, rows] of Object.entries(verified)) {
    const sheetXml = await zip.read(`xl/worksheets/sheet${sheet}.xml`);
    const anchors = [];
    for (const cell of sheetXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const address = /\br="A(\d+)"/.exec(cell[1]);
      if (!address || Number(address[1]) <= 2 || !cell[2]) continue;
      const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cell[2])?.[1];
      if (raw == null) continue;
      const value = /\bt="s"/.test(cell[1]) ? strings[Number(raw)] : Number(raw);
      anchors.push(entry(Number(address[1]), value, formats[Number(/\bs="(\d+)"/.exec(cell[1])?.[1] ?? 0)]));
    }
    assert.ok(anchors.length > 100);
    const result = inferDateSequence(anchors);
    assert.equal(result.completePath, true);
    assert.deepEqual([...result.dates.entries()].filter(([, date]) => !date.date).map(([row, date]) => `A${row}: ${date.reason}`), []);
    for (const [row, date] of Object.entries(rows)) assert.equal(result.dates.get(Number(row)).date, date);
    // Genuine October 2025 sessions are preserved, not swapped as a blanket rule.
    for (const anchor of anchors) {
      const original = parseDate(anchor.value, false).date;
      if (original?.startsWith('2025-10-')) assert.equal(result.dates.get(anchor.row).date, original);
    }
  }
});
