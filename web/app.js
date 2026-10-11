(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const snapshotMode = document.querySelector('meta[name="powerlog-data-source"]')?.content === 'snapshot';
  const names = { squat: ['深蹲', 'SQUAT'], bench: ['卧推', 'BENCH PRESS'], deadlift: ['硬拉', 'DEADLIFT'] };
  const state = { records: [], warnings: [], dateCorrections: [], lift: 'squat', metric: 'weight', range: 'all', recordLift: 'all', limit: 10, handle: null, source: null, busy: false, loaded: false };
  const number = (value, digits = 1) => value == null || !Number.isFinite(value) ? '—' : value.toLocaleString('zh-CN', { maximumFractionDigits: digits });
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const sum = (records, key) => records.reduce((total, record) => total + (record[key] ?? 0), 0);
  const max = (records, key) => records.length ? records.reduce((best, record) => Math.max(best, record[key] ?? 0), 0) : null;
  const localDay = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  function setNotice(message = '', error = false) { $('notice').textContent = message; $('notice').hidden = !message; $('notice').classList.toggle('error', error); }
  function setBusy(value) { state.busy = value; $('import').disabled = value; $('refresh').disabled = value; }
  function dateBounds() {
    if (state.range === 'custom') return { start: $('date-start').value, end: $('date-end').value };
    if (state.range === 'all') return { start: '', end: '' };
    const today = new Date(), start = new Date(today);
    start.setDate(start.getDate() - Number(state.range) + 1);
    return { start: localDay(start), end: localDay(today) };
  }
  function inRange(record) {
    const { start, end } = dateBounds();
    if (!start && !end) return true;
    return Boolean(record.date && (!start || record.date >= start) && (!end || record.date <= end));
  }
  function daily(records, key) {
    const days = new Map();
    for (const record of records) {
      if (!record.valid || !record.date || (key !== 'volume' && record.partialRange)) continue;
      if (key === 'volume') days.set(record.date, (days.get(record.date) || 0) + record.volume);
      else days.set(record.date, Math.max(days.get(record.date) || 0, record[key] || 0));
    }
    return Array.from(days, ([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date));
  }
  function sparkline(records) {
    const points = daily(records, 'weight').slice(-24);
    if (!points.length) return '<svg class="sparkline" aria-hidden="true"><path d="M0 28H88" stroke="#dce2d3" stroke-dasharray="3 4"/></svg>';
    const values = points.map(point => point.value), low = Math.min(...values), high = Math.max(...values);
    const plot = points.map((point, i) => `${(i / Math.max(1, points.length - 1)) * 88},${32 - ((point.value - low) / (high - low || 1)) * 24}`).join(' ');
    return `<svg class="sparkline" viewBox="0 0 88 40" aria-hidden="true"><polyline points="${plot}" stroke="#a3af8f"/></svg>`;
  }
  function renderCards() {
    $('metric-cards').innerHTML = Object.entries(names).map(([lift, [name, english]]) => {
      const records = state.records.filter(record => record.lift === lift && record.valid);
      const best = max(records.filter(record => !record.partialRange), 'weight');
      return `<article class="metric-card"><div class="metric-top"><span class="lift-symbol">${icon('bars')}</span><div class="metric-title">${name}<span>${english}</span></div><span class="metric-tag">TRAINING BEST</span></div><div class="metric-main"><div><strong>${number(best)}<small>kg</small></strong><div class="metric-caption">最高训练重量 · 含变式，不含半程</div></div>${sparkline(records)}</div><div class="metric-bottom"><span>累计训练量<strong>${records.length ? number(sum(records, 'volume') / 1000) : '—'} t</strong></span><span>工作组<strong>${records.length ? number(sum(records, 'sets'), 0) : '—'} 组</strong></span></div></article>`;
    }).join('');
  }
  function renderChart() {
    const records = state.records.filter(record => record.lift === state.lift && inRange(record));
    const points = daily(records, state.metric);
    const metric = state.metric;
    const best = points.length ? Math.max(...points.map(point => point.value)) : null;
    const unit = metric === 'volume' ? 'kg·次' : 'kg';
    $('chart-value').innerHTML = `${number(best)}<small> ${unit}</small>`;
    $('chart-value-label').textContent = { weight: '期间最高训练重量', e1rm: '期间最高估算 1RM', volume: '期间最高单日训练量' }[metric];
    $('chart-subtitle').textContent = points.length ? `${points[0].date.replaceAll('-', '.')} — ${points.at(-1).date.replaceAll('-', '.')} · ${points.length} 个训练日` : '当前范围内暂无可绘制的记录';
    $('chart-note').textContent = { weight: '每日取最高工作组重量；包含全程变式，不含 Pin Squat (high) 等半程动作，不代表比赛成绩。', e1rm: 'Epley 估算 = 重量 × (1 + 次数 ÷ 30)，单次取实际重量，每日取最高值。不含半程动作；仅供训练参考，非比赛成绩；未使用原表 Max 列。', volume: '每日训练量 = 当日有效行的「重量 × 次数 × 组数」之和；单位 kg·次，含变式动作。' }[metric];
    const chart = $('chart');
    const bounds = dateBounds();
    if (bounds.start && bounds.end && bounds.start > bounds.end) { chart.innerHTML = `<div class="chart-empty">${icon('trend')}开始日期不能晚于结束日期<span>调整日期后即可查看趋势</span></div>`; return; }
    if (!points.length) {
      chart.innerHTML = `<div class="chart-empty">${icon('trend')}${state.loaded ? '这个范围内，还没有训练足迹' : '你的进步，值得被记录'}<span>${state.loaded ? '试试全部时间，或检查下方日期提示' : '选择 Excel 工作簿，点亮第一条力量曲线'}</span></div>`;
      return;
    }
    const width = 640, height = 210, left = 43, right = 15, top = 19, bottom = 33;
    const plotWidth = width - left - right, plotHeight = height - top - bottom;
    const values = points.map(point => point.value);
    let minimum = metric === 'volume' ? 0 : Math.floor((Math.min(...values) * .88) / 10) * 10;
    let maximum = Math.ceil((Math.max(...values) * 1.08) / 10) * 10;
    if (maximum <= minimum) maximum = minimum + 10;
    const firstTime = Date.parse(points[0].date + 'T00:00:00Z'), lastTime = Date.parse(points.at(-1).date + 'T00:00:00Z');
    const x = point => left + (firstTime === lastTime ? .5 : (Date.parse(point.date + 'T00:00:00Z') - firstTime) / (lastTime - firstTime)) * plotWidth;
    const y = point => top + (maximum - point.value) / (maximum - minimum) * plotHeight;
    const line = points.map((point, index) => `${index ? 'L' : 'M'}${x(point).toFixed(2)},${y(point).toFixed(2)}`).join(' ');
    const area = `${line} L${x(points.at(-1)).toFixed(2)},${height - bottom} L${x(points[0]).toFixed(2)},${height - bottom} Z`;
    let grid = '';
    for (let tick = 0; tick <= 4; tick++) {
      const position = top + tick / 4 * plotHeight;
      const value = maximum - (maximum - minimum) * tick / 4;
      grid += `<line class="gridline" x1="${left}" x2="${width - right}" y1="${position}" y2="${position}"/><text x="${left - 12}" y="${position + 4}" text-anchor="end">${number(value, 0)}</text>`;
    }
    const labels = [...new Set([0, Math.round((points.length - 1) / 3), Math.round((points.length - 1) * 2 / 3), points.length - 1])];
    const dates = labels.map(index => `<text x="${x(points[index])}" y="${height - 8}" text-anchor="middle">${points[index].date.slice(5).replace('-', '.')}</text>`).join('');
    const hits = points.map((point, index) => `<circle class="chart-hit" cx="${x(point)}" cy="${y(point)}" r="8" data-point="${index}"><title>${point.date} · ${number(point.value)} ${unit}</title></circle>`).join('');
    chart.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${names[state.lift][0]}${$('chart-value-label').textContent}趋势，共 ${points.length} 个训练日，最高 ${number(best)} ${unit}"><defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#edb08b" stop-opacity=".18"/><stop offset="100%" stop-color="#edb08b" stop-opacity=".01"/></linearGradient></defs>${grid}<path d="${area}" fill="url(#chart-fill)"/><path class="trendline" d="${line}"/><circle class="point" cx="${x(points.at(-1))}" cy="${y(points.at(-1))}" r="3.5"/>${dates}${hits}</svg><div class="chart-tooltip" hidden></div>`;
    const tooltip = chart.querySelector('.chart-tooltip');
    chart.querySelectorAll('[data-point]').forEach(hit => {
      hit.addEventListener('pointerenter', () => {
        const point = points[Number(hit.dataset.point)];
        tooltip.innerHTML = `${point.date}<strong>${number(point.value)} ${unit}</strong>`;
        tooltip.hidden = false;
        const rect = chart.getBoundingClientRect(), dot = hit.getBoundingClientRect();
        tooltip.style.left = Math.max(0, Math.min(rect.width - tooltip.offsetWidth, dot.left - rect.left - tooltip.offsetWidth / 2)) + 'px';
        tooltip.style.top = Math.max(0, dot.top - rect.top - tooltip.offsetHeight - 8) + 'px';
      });
      hit.addEventListener('pointerleave', () => { tooltip.hidden = true; });
    });
  }
  function renderRhythm() {
    const records = state.records.filter(record => record.valid && inRange(record));
    const dated = records.filter(record => record.date);
    const days = new Set(dated.map(record => record.date));
    $('session-count').textContent = state.loaded ? number(days.size, 0) : '—';
    $('total-volume').innerHTML = `${state.loaded ? number(sum(records, 'volume') / 1000) : '—'}<small> t</small>`;
    $('total-sets').innerHTML = `${state.loaded ? number(sum(records, 'sets'), 0) : '—'}<small> 组</small>`;
    $('rhythm-period').textContent = `${state.range === 'all' ? '全部时间' : state.range === 'custom' ? '所选日期范围' : `最近 ${state.range} 天`} · 三项合计，记录你的坚持`;
    const allDated = state.records.filter(record => record.valid && record.date);
    const lastDate = allDated.map(record => record.date).sort().at(-1);
    const anchor = lastDate ? new Date(lastDate + 'T00:00:00Z') : new Date(localDay(new Date()) + 'T00:00:00Z');
    const countByDate = new Map();
    for (const record of allDated) countByDate.set(record.date, (countByDate.get(record.date) || 0) + record.sets);
    const cells = [];
    for (let index = 83; index >= 0; index--) {
      const date = new Date(anchor.getTime() - index * 86400000).toISOString().slice(0, 10);
      const sets = countByDate.get(date) || 0;
      const level = sets >= 12 ? 3 : sets >= 6 ? 2 : sets ? 1 : 0;
      cells.push(`<span class="activity-cell level-${level}" title="${date}：${sets} 组" aria-label="${date}：${sets} 组"></span>`);
    }
    $('activity').innerHTML = cells.join('');
  }
  function renderRecords() {
    const records = state.records.filter(record => (state.recordLift === 'all' || state.recordLift === record.lift) && inRange(record)).sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.row - a.row || a.sheet.localeCompare(b.sheet));
    $('record-count').textContent = `${number(records.length, 0)} 条记录`;
    const shown = records.slice(0, state.limit);
    $('records').innerHTML = shown.length ? shown.map(record => {
      const date = record.date ? record.date.replaceAll('-', '.') : escape(record.dateOriginal || record.dateRaw || '未填写日期');
      const detail = !record.date ? '<small>日期待确认</small>' : record.dateInferred ? `<small title="${escape(`${record.dateOriginal} → ${record.date}；${record.dateInference}`)}">已按顺序校正</small>` : '';
      const quantity = value => value == null || value === '' ? '—' : escape(value);
      const issues = record.issues.length ? `<span class="data-issue">${escape(record.issues.join('；'))}</span>` : '';
      return `<tr><td class="date-cell">${date}${detail}</td><td><span class="lift-chip ${record.lift}">${names[record.lift][0]}</span>${escape(record.exercise)}</td><td class="weight-cell">${quantity(record.weightRaw)}<small>kg</small></td><td>${quantity(record.repsRaw)} <span aria-label="乘">×</span> ${quantity(record.setsRaw)}</td><td>${record.rpeRaw ? `<span class="rpe-badge">${escape(record.rpeRaw)}</span>` : '—'}</td><td>${record.valid ? `${number(record.volume)} <small>kg·次</small>` : '—'}</td><td class="note-cell">${escape(record.note || '—')}${record.manualMax ? `<span class="data-issue">原表 Max：${escape(record.manualMax)}</span>` : ''}${record.partialRange ? '<span class="data-issue">半程动作，不计入最高重量和 1RM</span>' : ''}${issues}</td></tr>`;
    }).join('') : `<tr><td colspan="7" class="empty-table"><strong>${state.loaded ? '当前筛选没有训练记录' : '你的下一次进步，从这里开始'}</strong>${state.loaded ? '切换项目或日期范围，看看其他训练。' : '选择 HylPowerliftingTraining.xlsx，读取你的真实训练数据。'}</td></tr>`;
    $('show-more').hidden = records.length <= state.limit;
    $('table-description').textContent = records.length ? `已显示 ${shown.length} / ${records.length} 条 · 日期明确的记录优先，按日期倒序` : '原始记录来自你的 Excel 工作簿';
  }
  function renderQuality() {
    $('data-quality').hidden = !state.warnings.length && !state.dateCorrections.length;
    const invalid = state.records.filter(record => !record.valid).length;
    const undated = state.records.filter(record => !record.date).length;
    const summaries = [];
    if (state.dateCorrections.length) summaries.push(`${state.dateCorrections.length} 处历史日期已按记录顺序校正`);
    if (invalid) summaries.push(`${invalid} 行无效数值未计入统计`);
    if (undated) summaries.push(`${undated} 行日期仍待确认`);
    if (!summaries.length && state.warnings.length) summaries.push(`${state.warnings.length} 条数据提示`);
    $('quality-summary').textContent = summaries.join(' · ');
    $('date-corrections').hidden = !state.dateCorrections.length;
    $('date-correction-list').innerHTML = state.dateCorrections.map(correction => `<li><strong>${escape(correction.sheet)} · A${correction.row}</strong>：${escape(correction.from)} → ${escape(correction.to)}<span>（${escape(correction.reason)}）</span></li>`).join('');
    $('quality-list').innerHTML = state.warnings.map(warning => `<li>${escape(warning.sheet)}${warning.row ? ` · 第 ${warning.row} 行` : ''}：${escape(warning.message)}</li>`).join('');
  }
  function render() { renderCards(); renderChart(); renderRhythm(); renderRecords(); renderQuality(); }
  async function loadBuffer(buffer, name, source) {
    const workbook = await window.PowerLogXlsx.readWorkbook(buffer);
    loadData(workbook, name, source);
  }
  function loadData(workbook, name, source) {
    state.records = workbook.records;
    state.warnings = workbook.warnings;
    state.dateCorrections = workbook.dateCorrections || [];
    state.loaded = true;
    state.source = source;
    state.limit = 10;
    $('source-name').textContent = name;
    $('source-status').textContent = source === 'snapshot' ? '已发布副本' : '已读取';
    $('source-status').classList.remove('error');
    $('source-detail').textContent = `${workbook.sheets.length} 张工作表 · ${workbook.records.length} 条记录 · ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 读取${state.dateCorrections.length ? ` · 已统一 ${state.dateCorrections.length} 处历史日期` : ''}${source === 'file' ? ' · 更新后请重新选择文件' : ''}`;
    if (source === 'snapshot') $('source-detail').textContent = `${workbook.sheets.length} 张工作表 · ${workbook.records.length} 条记录 · 数据生成于 ${new Date(workbook.generatedAt).toLocaleString('zh-CN', { timeZone: 'Australia/Sydney', hour12: false })}（悉尼）`;
    setNotice();
    render();
  }
  function showError(error) {
    setNotice(`${error.message || '读取失败，请重试。'}${state.loaded ? ' 页面保留上次成功读取的数据。' : ''}`, true);
    $('source-status').textContent = state.loaded ? '刷新未成功' : '尚未读取';
    $('source-status').classList.add('error');
    if (!state.loaded) $('source-detail').textContent = '请选择有效的 XLSX 训练工作簿';
  }
  async function chooseFile() {
    if (state.busy) return;
    if ('showOpenFilePicker' in window && window.isSecureContext) {
      setBusy(true);
      try {
        const [handle] = await window.showOpenFilePicker({ multiple: false, types: [{ description: 'Excel 训练工作簿', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } }] });
        const file = await handle.getFile();
        await loadBuffer(await file.arrayBuffer(), file.name, 'handle');
        state.handle = handle;
      } catch (error) {
        if (error.name !== 'AbortError') {
          if (error.name === 'SecurityError' || error.name === 'NotAllowedError') $('file-input').click();
          else showError(error);
        }
      } finally { setBusy(false); }
    } else $('file-input').click();
  }
  async function fetchWorkbook(initial = false) {
    setBusy(true);
    try {
      if (snapshotMode) {
        const response = await fetch(new URL('training-data.json', window.location.href), { cache: 'no-store' });
        if (!response.ok) throw new Error(`训练数据未能加载（HTTP ${response.status}），请稍后刷新。`);
        const workbook = await response.json();
        if (workbook.schemaVersion !== 1 || !Array.isArray(workbook.records) || !Array.isArray(workbook.sheets) || !Array.isArray(workbook.warnings) || !Number.isFinite(Date.parse(workbook.generatedAt))) throw new Error('训练数据格式无效，请重新发布页面。');
        loadData(workbook, 'HylPowerliftingTraining.xlsx · 私人网页副本', 'snapshot');
        state.handle = null;
        return;
      }
      const response = await fetch(new URL('HylPowerliftingTraining.xlsx', window.location.href), { cache: 'no-store' });
      if (!response.ok) throw new Error(`没有读到目录中的工作簿（HTTP ${response.status}），请点击“选择工作簿”。`);
      const length = Number(response.headers.get('Content-Length'));
      if (length > 50 * 1024 * 1024) throw new Error('工作簿超过 50 MB，请选择较小的文件。');
      await loadBuffer(await response.arrayBuffer(), 'HylPowerliftingTraining.xlsx', 'server');
      state.handle = null;
    } catch (error) { showError(initial && error instanceof TypeError ? new Error('无法自动读取目录中的工作簿，请点击“选择工作簿”。') : error); }
    finally { setBusy(false); }
  }
  $('import').addEventListener('click', chooseFile);
  $('file-input').addEventListener('change', async event => {
    const file = event.target.files[0];
    if (!file) return;
    setBusy(true);
    try {
      if (file.size > 50 * 1024 * 1024) throw new Error('请选择 50 MB 以内的 XLSX 文件。');
      await loadBuffer(await file.arrayBuffer(), file.name, 'file');
      state.handle = null;
    } catch (error) { showError(error); }
    finally { event.target.value = ''; setBusy(false); }
  });
  $('refresh').addEventListener('click', async () => {
    if (state.busy) return;
    if (state.handle) {
      setBusy(true);
      try { const file = await state.handle.getFile(); await loadBuffer(await file.arrayBuffer(), file.name, 'handle'); }
      catch (error) { showError(new Error(`未能重新读取已选文件，请再次选择工作簿。${error.message ? `（${error.message}）` : ''}`)); }
      finally { setBusy(false); }
    } else if (state.source === 'server' || state.source === 'snapshot' || (!state.source && location.protocol !== 'file:')) await fetchWorkbook();
    else { setNotice('请重新选择更新后的工作簿。浏览器需要你再次选择文件，才能读取磁盘上的最新内容。'); await chooseFile(); }
  });
  document.querySelectorAll('[data-lift]').forEach(button => button.addEventListener('click', () => {
    state.lift = button.dataset.lift;
    document.querySelectorAll('[data-lift]').forEach(other => { other.classList.toggle('selected', other === button); other.setAttribute('aria-pressed', String(other === button)); });
    renderChart();
  }));
  $('chart-metric').addEventListener('change', event => { state.metric = event.target.value; renderChart(); });
  $('range').addEventListener('change', event => { state.range = event.target.value; state.limit = 10; $('custom-dates').hidden = state.range !== 'custom'; renderChart(); renderRhythm(); renderRecords(); });
  ['date-start', 'date-end'].forEach(id => $(id).addEventListener('change', () => { state.limit = 10; renderChart(); renderRhythm(); renderRecords(); }));
  $('record-lift').addEventListener('change', event => { state.recordLift = event.target.value; state.limit = 10; renderRecords(); });
  $('show-more').addEventListener('click', () => { state.limit += 20; renderRecords(); });
  document.querySelectorAll('.nav-link').forEach(link => link.addEventListener('click', () => { document.querySelectorAll('.nav-link').forEach(other => other.classList.toggle('active', other === link)); }));
  render();
  if (location.protocol === 'file:') {
    $('source-detail').textContent = '点击“选择工作簿”，从你的电脑读取训练数据';
    $('source-status').textContent = '等待选择';
    setNotice('本地文件模式：选择工作簿后即可查看。所有数据只在浏览器中读取；聊天更新 Excel 后，再次刷新读取。');
  } else fetchWorkbook(true);
})();
