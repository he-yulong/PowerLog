// Shared by the read-only website builds. Reads the workbook; never writes it or uses the network.
import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

export const root = fileURLToPath(new URL('../', import.meta.url));

// Raw worksheet rows from powerlog.export, and the dashboard's own reader (web/xlsx-reader.js).
export async function exportRows(python) {
  const input = spawnSync(python, ['-m', 'powerlog.export', path.join(root, 'HylPowerliftingTraining.xlsx')], { cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (input.status !== 0) throw new Error(input.stderr || input.error?.message || 'Excel 导出失败');
  if (!globalThis.PowerLogXlsx) vm.runInThisContext(await readFile(path.join(root, 'web/xlsx-reader.js'), 'utf8'));
  return { raw: JSON.parse(input.stdout), reader: globalThis.PowerLogXlsx };
}

export async function buildSnapshot(python) {
  const { raw } = await exportRows(python);
  const snapshot = { schemaVersion: 1, generatedAt: new Date().toISOString(), sourceSha256: raw.sourceSha256, date1904: raw.date1904, records: [], runs: [], warnings: [], sheets: [], dateCorrections: [] };
  for (const sheet of raw.sheets) {
    const result = globalThis.PowerLogXlsx.recordsFromRows(sheet.rows, sheet.name, raw.date1904);
    snapshot.records.push(...result.records);
    snapshot.warnings.push(...result.warnings);
    snapshot.dateCorrections.push(...result.dateCorrections);
    snapshot.sheets.push(sheet.name);
  }
  if (raw.runs) {
    const result = globalThis.PowerLogXlsx.runsFromRows(raw.runs.rows, raw.date1904);
    snapshot.runs.push(...result.runs);
    snapshot.warnings.push(...result.warnings);
  }
  if (!snapshot.records.length) throw new Error('没有训练记录，停止发布空白数据。');
  return snapshot;
}

// index.html switched to the published snapshot; app.js adjusts the wording for a hosted copy.
export async function snapshotHtml() {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  if (!html.includes('<meta charset="utf-8">')) throw new Error('index.html 缺少 charset 声明，无法生成只读副本。');
  return html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n  <meta name="powerlog-data-source" content="snapshot">');
}

export async function writeSite(directory, snapshot, html, page = 'index.html') {
  await mkdir(path.join(directory, 'web'), { recursive: true });
  await writeFile(path.join(directory, page), html);
  for (const file of ['app.js', 'styles.css', 'xlsx-reader.js']) await copyFile(path.join(root, 'web', file), path.join(directory, 'web', file));
  await writeFile(path.join(directory, 'training-data.json'), JSON.stringify(snapshot));
  await checkAssets(directory);
}

// Never include the source workbook or backup directories in a deployment.
async function checkAssets(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isSymbolicLink() || /\.xlsx?$|^\.powerlog$/i.test(item.name)) throw new Error(`不允许发布的文件：${item.name}`);
    if (item.isDirectory()) await checkAssets(path.join(directory, item.name));
  }
}

export function summary(snapshot, extra = {}) {
  return JSON.stringify({ ...extra, records: snapshot.records.length, runs: snapshot.runs.length, dateCorrections: snapshot.dateCorrections.length, generatedAt: snapshot.generatedAt, sourceSha256: snapshot.sourceSha256, latest: Object.fromEntries(snapshot.sheets.map(sheet => [sheet, snapshot.records.filter(r => r.sheet === sheet && r.date).map(r => r.date).sort().at(-1)])) });
}
