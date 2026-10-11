/* A small, dependency-free reader for PowerLog's local XLSX workbook. */
(function (root) {
  'use strict';
  const MAX_FILE = 50 * 1024 * 1024;
  const MAX_ENTRY = 20 * 1024 * 1024;
  const MAX_TOTAL = 100 * 1024 * 1024;
  const decoder = new TextDecoder('utf-8');
  const lifts = { '2025-S': 'squat', '2025-B': 'bench', '2025-D': 'deadlift' };
  // Partial-range variants such as "Pin Squat (high)" move more than the full lift,
  // so they count toward volume but not toward best weight or estimated 1RM.
  const PARTIAL_RANGE = /\(high\)|\bhalf\b|\bquarter\b|\bpartial\b|\brack pulls?\b|\bblock pulls?\b|\bboard press\b/i;
  // Runs live in their own sheet: A date, B distance km, C time, D notes.
  const RUN_SHEET = 'Running';
  function fail(message) { throw new Error(message); }
  const nodes = (element, name) => Array.from(element.getElementsByTagNameNS('*', name));
  const textAt = (element, name) => nodes(element, name)[0]?.textContent ?? '';
  const richText = element => nodes(element, 't').map(node => node.textContent).join('');

  function crc32(bytes) {
    let crc = -1;
    for (const value of bytes) {
      crc ^= value;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ -1) >>> 0;
  }

  async function unzip(buffer) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength > MAX_FILE) fail('文件过大或格式无效，请选择 50 MB 以内的 XLSX 文件。');
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const fits = (offset, length) => Number.isSafeInteger(offset) && offset >= 0 && length >= 0 && offset + length <= bytes.length;
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50 && fits(i, 22) && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break; }
    }
    if (end < 0) fail('无法读取 XLSX：文件不是完整的 ZIP 工作簿。');
    const count = view.getUint16(end + 10, true);
    if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || count !== view.getUint16(end + 8, true)) fail('不支持分卷 XLSX 文件。');
    let cursor = view.getUint32(end + 16, true);
    const directorySize = view.getUint32(end + 12, true);
    const directoryEnd = cursor + directorySize;
    if (count > 1000 || !fits(cursor, directorySize) || directoryEnd > end) fail('工作簿目录异常或文件过大。');
    const entries = new Map();
    let total = 0;
    for (let index = 0; index < count; index++) {
      if (!fits(cursor, 46) || cursor + 46 > directoryEnd || view.getUint32(cursor, true) !== 0x02014b50) fail('工作簿目录已损坏。');
      const flags = view.getUint16(cursor + 8, true);
      const method = view.getUint16(cursor + 10, true);
      const crc = view.getUint32(cursor + 16, true);
      const compressed = view.getUint32(cursor + 20, true);
      const size = view.getUint32(cursor + 24, true);
      const nameLength = view.getUint16(cursor + 28, true);
      const extraLength = view.getUint16(cursor + 30, true);
      const commentLength = view.getUint16(cursor + 32, true);
      const local = view.getUint32(cursor + 42, true);
      const length = 46 + nameLength + extraLength + commentLength;
      if (!fits(cursor, length) || cursor + length > directoryEnd) fail('工作簿文件名目录已损坏。');
      if (flags & 1) fail('暂不支持加密工作簿，请选择未加密的 XLSX。');
      if (size > MAX_ENTRY || (total += size) > MAX_TOTAL || compressed === 0xffffffff || local === 0xffffffff) fail('工作簿解压大小超出安全限制。');
      const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
      if (entries.has(name)) fail('工作簿包含重复的内部文件。');
      if (!fits(local, 30) || view.getUint32(local, true) !== 0x04034b50) fail('工作簿内部文件头已损坏。');
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      if (!fits(start, compressed) || start + compressed > view.getUint32(end + 16, true)) fail('工作簿内部文件长度无效。');
      entries.set(name, { start, compressed, size, method, crc });
      cursor += length;
    }
    if (cursor !== directoryEnd) fail('工作簿目录长度不一致。');
    const cache = new Map();
    return {
      has: name => entries.has(name),
      async read(name) {
        if (cache.has(name)) return cache.get(name);
        const entry = entries.get(name);
        if (!entry) fail(`工作簿缺少必要内容：${name}`);
        const data = bytes.subarray(entry.start, entry.start + entry.compressed);
        let output;
        if (entry.method === 0) output = data;
        else if (entry.method === 8) {
          if (typeof DecompressionStream === 'undefined') fail('浏览器不支持本地解压，请使用新版 Chrome、Edge、Firefox 或 Safari。');
          let stream;
          try { stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')); }
          catch { fail('浏览器不支持 XLSX 解压，请升级浏览器后重试。'); }
          const reader = stream.getReader();
          const chunks = [];
          let length = 0;
          try {
            while (true) {
              const result = await reader.read();
              if (result.done) break;
              length += result.value.length;
              if (length > entry.size || length > MAX_ENTRY) { await reader.cancel(); fail('工作簿解压大小与目录不一致。'); }
              chunks.push(result.value);
            }
          } catch (error) { fail(`工作簿解压失败：${error.message}`); }
          output = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
        } else fail(`不支持工作簿的压缩格式（${entry.method}）。`);
        if (output.length !== entry.size || crc32(output) !== entry.crc) fail('工作簿内容校验失败，文件可能已损坏。');
        const result = decoder.decode(output);
        cache.set(name, result);
        return result;
      }
    };
  }

  function xml(source) {
    if (/<!DOCTYPE|<!ENTITY/i.test(source)) fail('工作簿包含不支持的 XML 声明。');
    const document = new DOMParser().parseFromString(source, 'application/xml');
    if (nodes(document, 'parsererror').length) fail('工作簿 XML 内容已损坏。');
    return document;
  }
  function resolvePath(base, target) {
    if (/^[a-z]+:/i.test(target) || target.includes('\\')) fail('工作簿关系路径无效。');
    const parts = target.startsWith('/') ? [] : base.split('/').slice(0, -1);
    for (const part of target.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') { if (!parts.length) fail('工作簿关系路径越界。'); parts.pop(); }
      else parts.push(part);
    }
    return parts.join('/');
  }
  function relationships(document, base) {
    const result = new Map();
    for (const node of nodes(document, 'Relationship')) {
      if (node.getAttribute('TargetMode') === 'External') continue;
      result.set(node.getAttribute('Id'), { type: node.getAttribute('Type'), path: resolvePath(base, node.getAttribute('Target') || '') });
    }
    return result;
  }
  function numeric(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  function todayInSydney() {
    const parts = new Intl.DateTimeFormat('en', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const part = type => parts.find(item => item.type === type).value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  }
  function validISO(candidate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return false;
    const timestamp = Date.parse(candidate + 'T00:00:00Z');
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === candidate;
  }
  function decodeDate(value, date1904 = false) {
    let date = null;
    let source = 'unknown';
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 2958466) {
      source = 'serial';
      const days = Math.floor(value);
      if (!date1904 && days === 60) return { date: null, source, reason: '无效的 Excel 1900 闰日' };
      const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
      date = new Date(epoch + (days - (!date1904 && days > 60 ? 1 : 0)) * 86400000).toISOString().slice(0, 10);
    } else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
      source = 'iso';
      const candidate = value.trim();
      if (validISO(candidate)) date = candidate;
    } else if (typeof value === 'string') {
      const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
      if (match) {
        source = 'dmy';
        const candidate = `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
        if (validISO(candidate)) date = candidate;
      }
    }
    return { date, source, reason: date ? null : value === '' || value == null ? '缺少日期' : '日期格式不明确或无效' };
  }
  function parseDate(value, date1904 = false, referenceDate = todayInSydney()) {
    const decoded = decodeDate(value, date1904);
    if (!decoded.date) return { date: null, reason: decoded.reason };
    const date = decoded.date;
    const year = Number(date.slice(0, 4));
    if (year < 1970 || year > Number(referenceDate.slice(0, 4)) + 1) return { date: null, reason: '年份异常，未猜测修正' };
    if (date > referenceDate) return { date: null, reason: `日期晚于今天（${referenceDate}，悉尼），未纳入趋势` };
    return { date, reason: null };
  }

  function isoNumberFormat(format) {
    return /^yyyy[-/]mm[-/]dd(?:$|[ ;])/i.test(String(format || '').replace(/\[[^\]]*\]/g, '').replace(/"/g, '').replace(/\\/g, '').trim());
  }

  // The user confirmed that legacy records were entered from older to newer dates.
  // Keep a date only when it is shared by every possible non-decreasing sequence.
  // Explicit ISO dates are authoritative and independent, so later backfills do not
  // invalidate or reinterpret an otherwise coherent legacy training history.
  function inferDateSequence(entries, options = {}) {
    const date1904 = Boolean(options.date1904);
    const referenceDate = options.referenceDate || todayInSydney();
    const referenceYear = Number(referenceDate.slice(0, 4));
    const dates = new Map(), dateCorrections = [];
    const reasonableYear = year => year >= 1970 && year <= referenceYear + 1;
    const admissible = date => validISO(date) && date >= '1970-01-01' && date <= referenceDate;
    const legacy = [];
    for (const entry of entries) {
      const decoded = decodeDate(entry.value, date1904);
      const original = decoded.date || String(entry.value ?? '');
      const base = { date: null, dateOriginal: original, dateInferred: false, dateInference: '', reason: decoded.reason };
      dates.set(entry.row, base);
      if (!decoded.date) continue;
      if (decoded.source === 'iso' || (decoded.source === 'serial' && isoNumberFormat(entry.numberFormat))) {
        Object.assign(base, parseDate(entry.value, date1904, referenceDate));
        continue;
      }
      legacy.push({ ...entry, ...decoded, original, base, candidates: [] });
    }
    for (let index = 0; index < legacy.length; index++) {
      const anchor = legacy[index];
      let candidate = anchor.date;
      let correctedYear = false;
      const year = Number(candidate.slice(0, 4));
      if (!reasonableYear(year) && anchor.source === 'serial') {
        let previous = index - 1, next = index + 1;
        while (previous >= 0 && !reasonableYear(Number(legacy[previous].date.slice(0, 4)))) previous--;
        while (next < legacy.length && !reasonableYear(Number(legacy[next].date.slice(0, 4)))) next++;
        const before = legacy[previous]?.date.slice(0, 4), after = legacy[next]?.date.slice(0, 4);
        if (before && before === after) {
          candidate = before + candidate.slice(4);
          correctedYear = true;
        }
      }
      const add = (date, swapped = false) => {
        if (!admissible(date) || anchor.candidates.some(other => other.date === date)) return;
        anchor.candidates.push({ date, swapped, correctedYear });
      };
      add(candidate);
      if (anchor.source === 'serial') {
        const [yearPart, month, day] = candidate.split('-');
        add(`${yearPart}-${day}-${month}`, true);
      }
    }
    if (!legacy.length) return { dates, dateCorrections, completePath: true };
    const forward = legacy.map(anchor => anchor.candidates.map(() => false));
    const backward = legacy.map(anchor => anchor.candidates.map(() => false));
    forward[0].fill(true);
    for (let index = 1; index < legacy.length; index++) {
      legacy[index].candidates.forEach((candidate, at) => {
        forward[index][at] = legacy[index - 1].candidates.some((previous, before) => forward[index - 1][before] && previous.date <= candidate.date);
      });
    }
    backward.at(-1).fill(true);
    for (let index = legacy.length - 2; index >= 0; index--) {
      legacy[index].candidates.forEach((candidate, at) => {
        backward[index][at] = legacy[index + 1].candidates.some((next, after) => backward[index + 1][after] && candidate.date <= next.date);
      });
    }
    const completePath = forward.at(-1).some(Boolean);
    for (let index = 0; index < legacy.length; index++) {
      const anchor = legacy[index];
      const possible = anchor.candidates.filter((_, at) => forward[index][at] && backward[index][at]);
      if (!completePath) {
        anchor.base.reason = '旧记录日期无法形成由旧到新的完整序列；保留原值，未自动修正';
      } else if (possible.length !== 1) {
        anchor.base.reason = `日期顺序仍有多种解释（${possible.map(candidate => candidate.date).join(' / ')}）；保留原值，待确认`;
      } else {
        const selected = possible[0];
        anchor.base.date = selected.date;
        anchor.base.reason = null;
        if (selected.date !== anchor.original && anchor.source === 'serial') {
          const changes = [selected.correctedYear ? '依据前后相同年份修正异常年份' : '', selected.swapped ? '纠正 Excel 月日颠倒' : ''].filter(Boolean);
          const reason = changes.join('；') + '；由旧到新顺序约束下的唯一日期';
          anchor.base.dateInferred = true;
          anchor.base.dateInference = reason;
          dateCorrections.push({ row: anchor.row, from: anchor.original, to: selected.date, reason });
        }
      }
    }
    return { dates, dateCorrections, completePath };
  }

  function recordsFromRows(rows, sheet, date1904 = false) {
    const records = [];
    const warnings = [];
    const anchors = new Map();
    for (const row of rows) {
      if (row.row <= 2 || row.values[0] === '' || row.values[0] == null) continue;
      const anchor = row.dateAnchor ?? row.row;
      if (!anchors.has(anchor)) anchors.set(anchor, { row: anchor, value: row.values[0], numberFormat: row.numberFormat });
    }
    const inferred = inferDateSequence(Array.from(anchors.values()).sort((a, b) => a.row - b.row), { date1904 });
    for (const { row, values, dateAnchor } of rows) {
      if (row <= 2 || !values.slice(2, 8).some(value => value !== '' && value != null)) continue;
      const [dateRaw, exerciseRaw, weightRaw, repsRaw, setsRaw, manualMax, note, rpeRaw] = values;
      const weight = numeric(weightRaw), reps = numeric(repsRaw), sets = numeric(setsRaw);
      const calculatedVolume = weight * reps * sets;
      const calculatedE1rm = reps === 1 ? weight : weight * (1 + reps / 30);
      const valid = weight != null && weight >= 0 && Number.isInteger(reps) && reps > 0 && Number.isInteger(sets) && sets > 0 && Number.isFinite(calculatedVolume) && Number.isFinite(calculatedE1rm);
      const parsedDate = inferred.dates.get(dateAnchor ?? row) || { ...parseDate(dateRaw, date1904), dateOriginal: String(dateRaw ?? ''), dateInferred: false, dateInference: '' };
      const issues = [];
      if (!valid) issues.push('重量 / 次数 / 组数不完整或无效');
      if (parsedDate.reason) issues.push(parsedDate.reason);
      const record = {
        id: `${sheet}:${row}`, row, sheet, lift: lifts[sheet], date: parsedDate.date,
        dateOriginal: parsedDate.dateOriginal, dateInferred: parsedDate.dateInferred, dateInference: parsedDate.dateInference,
        dateRaw: String(dateRaw ?? ''), exercise: String(exerciseRaw || '未填写动作'), partialRange: PARTIAL_RANGE.test(String(exerciseRaw ?? '')),
        weight, reps, sets, weightRaw, repsRaw, setsRaw, manualMax: String(manualMax ?? ''),
        rpe: numeric(rpeRaw), rpeRaw: String(rpeRaw ?? ''), note: String(note ?? ''), valid,
        volume: valid ? calculatedVolume : null,
        e1rm: valid ? calculatedE1rm : null,
        issues
      };
      records.push(record);
      if (issues.length) warnings.push({ sheet, row, message: issues.join('；') });
    }
    return { records, warnings, dateCorrections: inferred.dateCorrections.map(correction => ({ sheet, ...correction })) };
  }

  // A run's time: an Excel time value (fraction of a day) or text such as 45:10 or 1:02:30.
  function durationSeconds(value) {
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 && value < 1 ? Math.round(value * 86400) : null;
    const text = String(value ?? '').trim();
    const long = /^(\d{1,2}):([0-5]\d):([0-5]\d)$/.exec(text), short = /^(\d{1,3}):([0-5]\d)$/.exec(text);
    if (long) return Number(long[1]) * 3600 + Number(long[2]) * 60 + Number(long[3]);
    if (short) return Number(short[1]) * 60 + Number(short[2]);
    return null;
  }

  function runsFromRows(rows, date1904 = false) {
    const runs = [], warnings = [];
    for (const { row, values } of rows) {
      if (row <= 2 || !values.slice(0, 4).some(value => value !== '' && value != null)) continue;
      const [dateRaw, distanceRaw, timeRaw, note] = values;
      const parsed = parseDate(dateRaw, date1904);
      const distance = numeric(distanceRaw);
      const valid = distance != null && distance > 0;
      const hasTime = timeRaw !== '' && timeRaw != null;
      const seconds = hasTime ? durationSeconds(timeRaw) : null;
      const issues = [];
      if (!valid) issues.push('距离缺失或无效');
      if (parsed.reason) issues.push(parsed.reason);
      if (hasTime && seconds == null) issues.push('用时格式无效');
      runs.push({
        id: `${RUN_SHEET}:${row}`, row, sheet: RUN_SHEET, date: parsed.date, dateRaw: String(dateRaw ?? ''),
        distance: valid ? distance : null, seconds, pace: valid && seconds ? seconds / distance : null, note: String(note ?? ''), valid, issues
      });
      if (issues.length) warnings.push({ sheet: RUN_SHEET, row, message: issues.join('；') });
    }
    return { runs, warnings };
  }

  function sheetRows(document, strings, numberFormats = []) {
    const cells = new Map();
    const dateMetadata = new Map();
    const rowNumbers = new Set();
    for (const cell of nodes(document, 'c')) {
      const ref = cell.getAttribute('r');
      const address = /^([A-H])([1-9]\d*)$/.exec(ref || '');
      if (!address) continue;
      const row = Number(address[2]);
      if (row > 100000) fail('工作表行数超出读取限制。');
      rowNumbers.add(row);
      const type = cell.getAttribute('t');
      const raw = textAt(cell, 'v');
      let value = raw;
      if (type === 's') value = strings[Number(raw)] ?? '';
      else if (type === 'inlineStr') value = richText(cell);
      else if (!type || type === 'n') value = raw === '' ? '' : numeric(raw) ?? raw;
      cells.set(ref, value);
      if (address[1] === 'A' && value !== '') dateMetadata.set(row, { dateAnchor: row, numberFormat: numberFormats[Number(cell.getAttribute('s') || 0)] || '' });
    }
    // Fill only explicit merged date/exercise/note/RPE ranges. Never carry values across unmerged blanks.
    for (const merged of nodes(document, 'mergeCell')) {
      const match = /^([A-H])([1-9]\d*):([A-H])([1-9]\d*)$/.exec(merged.getAttribute('ref') || '');
      if (!match || match[1] !== match[3] || !['A', 'B', 'G', 'H'].includes(match[1])) continue;
      const first = Number(match[2]), last = Number(match[4]);
      if (last > 100000 || last < first) fail('工作簿合并区域无效。');
      const value = cells.get(`${match[1]}${first}`) ?? '';
      for (let row = first + 1; row <= last; row++) {
        const ref = `${match[1]}${row}`;
        if (cells.get(ref) === '' || !cells.has(ref)) {
          cells.set(ref, value);
          if (match[1] === 'A') dateMetadata.set(row, dateMetadata.get(first) || { dateAnchor: first, numberFormat: '' });
        }
      }
    }
    return Array.from(rowNumbers).sort((a, b) => a - b).map(row => ({ row, ...dateMetadata.get(row), values: 'ABCDEFGH'.split('').map(col => cells.get(`${col}${row}`) ?? '') }));
  }

  async function readWorkbook(buffer) {
    const zip = await unzip(buffer);
    let workbookPath = 'xl/workbook.xml';
    if (zip.has('_rels/.rels')) {
      const rootRels = relationships(xml(await zip.read('_rels/.rels')), '');
      workbookPath = Array.from(rootRels.values()).find(rel => rel.type?.endsWith('/officeDocument'))?.path || workbookPath;
    }
    const workbook = xml(await zip.read(workbookPath));
    const pathParts = workbookPath.split('/');
    const workbookName = pathParts.pop();
    const relsPath = [...pathParts, '_rels', `${workbookName}.rels`].join('/');
    const rels = relationships(xml(await zip.read(relsPath)), workbookPath);
    const sharedPath = Array.from(rels.values()).find(rel => rel.type?.endsWith('/sharedStrings'))?.path;
    const strings = sharedPath ? nodes(xml(await zip.read(sharedPath)), 'si').map(richText) : [];
    const stylesPath = Array.from(rels.values()).find(rel => rel.type?.endsWith('/styles'))?.path;
    let numberFormats = [];
    if (stylesPath) {
      const styles = xml(await zip.read(stylesPath));
      const customFormats = new Map(nodes(styles, 'numFmt').map(format => [Number(format.getAttribute('numFmtId')), format.getAttribute('formatCode')]));
      const formats = nodes(styles, 'cellXfs')[0];
      if (formats) numberFormats = nodes(formats, 'xf').map(format => customFormats.get(Number(format.getAttribute('numFmtId'))) || '');
    }
    const date1904 = ['1', 'true'].includes(nodes(workbook, 'workbookPr')[0]?.getAttribute('date1904'));
    const records = [], runs = [], warnings = [], sheets = [], dateCorrections = [];
    for (const sheet of nodes(workbook, 'sheet')) {
      const name = sheet.getAttribute('name');
      if (!lifts[name] && name !== RUN_SHEET) continue;
      const id = sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || sheet.getAttribute('r:id');
      const relation = rels.get(id);
      if (!relation) fail(`工作表 ${name} 缺少文件关系。`);
      const rows = sheetRows(xml(await zip.read(relation.path)), strings, numberFormats);
      if (name === RUN_SHEET) {
        const result = runsFromRows(rows, date1904);
        runs.push(...result.runs);
        warnings.push(...result.warnings);
        continue;
      }
      const result = recordsFromRows(rows, name, date1904);
      records.push(...result.records);
      warnings.push(...result.warnings);
      dateCorrections.push(...result.dateCorrections);
      sheets.push(name);
    }
    if (!sheets.length) fail('没有找到力量举工作表。请使用包含 2025-S、2025-B、2025-D 的训练工作簿。');
    for (const name of Object.keys(lifts)) if (!sheets.includes(name)) warnings.push({ sheet: name, row: null, message: '未找到此工作表' });
    return { records, runs, warnings, sheets, date1904, dateCorrections };
  }
  root.PowerLogXlsx = Object.freeze({ readWorkbook, parseDate, inferDateSequence, recordsFromRows, runsFromRows, isoNumberFormat, unzip });
})(typeof window !== 'undefined' ? window : globalThis);
