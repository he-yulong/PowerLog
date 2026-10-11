(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const snapshotMode = document.querySelector('meta[name="powerlog-data-source"]')?.content === 'snapshot';
  const fileMode = location.protocol === 'file:';
  // Identity colors follow competition plates; text always stays in the ink colors.
  const LIFTS = [
    { key: 'squat', name: '深蹲', color: 'var(--squat)' },
    { key: 'bench', name: '卧推', color: 'var(--bench)' },
    { key: 'deadlift', name: '硬拉', color: 'var(--deadlift)' }
  ];
  const LIFT = Object.fromEntries(LIFTS.map(lift => [lift.key, lift]));
  const RUN_COLOR = 'var(--run)';
  const METRICS = {
    weight: { label: '最高重量', note: '每个训练日取最好的一组重量。包含全程杠铃变式，不含 Pin Squat (high) 等半程动作和哑铃、自重等辅助动作。' },
    e1rm: { label: '估算 1RM', note: 'Epley 公式：重量 × (1 + 次数 ÷ 30)，单次取实际重量，每个训练日取最高值。不含半程和辅助动作，仅供训练参考，不代表比赛成绩。' },
    volume: { label: '训练量', note: '每个训练日所有有效组的 重量 × 次数 × 组数 之和，包含变式和辅助动作。' }
  };
  const RANGE_LABEL = { 30: '最近 30 天', 90: '最近 90 天', 365: '最近 1 年', all: '全部时间' };
  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const RPE_LABEL = { easy: '轻松', moderate: '中等', hard: '吃力', 'very-hard': '很吃力', max: '极限' };
  const DAY = 86400000;
  const state = {
    records: [], runs: [], warnings: [], dateCorrections: [], lift: 'squat', metric: 'weight', range: '90', logFilter: 'all', logDays: 10,
    trendIndex: null, calendarDate: null, runWeek: null, handle: null, source: null, busy: false, loaded: false, readAt: null, generatedAt: null
  };
  // Inputs of the drawn charts, kept so a resize or a new selection redraws without recomputing.
  const view = { trend: [], trendGeometry: null, weeks: [], runXs: [], calendar: new Map(), calendarFirst: null };

  const fmt = (value, digits = 1) => value == null || !Number.isFinite(value) ? '—' : value.toLocaleString('zh-CN', { maximumFractionDigits: digits });
  const tons = kg => fmt(kg / 1000, kg >= 100000 ? 0 : 1);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const plate = color => `<svg class="plate" viewBox="0 0 20 20" aria-hidden="true" style="--plate:${color}"><circle cx="10" cy="10" r="9"/><circle class="hole" cx="10" cy="10" r="2.6"/></svg>`;
  const time = date => Date.parse(date + 'T00:00:00Z');
  const isoDate = ms => new Date(ms).toISOString().slice(0, 10);
  const localToday = () => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; };
  const monthDay = date => `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
  const weekday = date => WEEKDAYS[new Date(time(date)).getUTCDay()];
  const fullDate = date => `${date.slice(0, 4)}年${monthDay(date)}`;
  const weekStart = date => isoDate(time(date) - ((new Date(time(date)).getUTCDay() + 6) % 7) * DAY);
  const stamp = date => date.toLocaleString('zh-CN', { timeZone: 'Australia/Sydney', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const countsTowardBest = record => !record.partialRange && !record.accessory;
  const rpeBand = rpe => rpe == null || !Number.isFinite(rpe) ? '' : rpe >= 10 ? 'max' : rpe >= 9 ? 'very-hard' : rpe >= 8 ? 'hard' : rpe >= 7 ? 'moderate' : 'easy';
  const clock = seconds => {
    if (seconds == null) return '—';
    const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = String(Math.round(seconds % 60)).padStart(2, '0');
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
  };
  const pace = secondsPerKm => { const total = Math.round(secondsPerKm); return `${Math.floor(total / 60)}'${String(total % 60).padStart(2, '0')}"`; };
  const rangeStart = () => state.range === 'all' ? null : isoDate(time(localToday()) - (Number(state.range) - 1) * DAY);
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const measure = document.createElement('canvas').getContext('2d');
  const textWidth = text => { measure.font = `12px ${getComputedStyle(document.body).fontFamily}`; return measure.measureText(text).width; };
  const stat = (label, value, unit = '', note = '') => `<div class="stat"><span>${label}</span><strong>${value}${unit && value !== '—' ? `<small>${unit}</small>` : ''}</strong>${note ? `<em>${note}</em>` : ''}</div>`;

  // Rounded axis values that cover [low, high].
  function niceTicks(low, high, count, padded) {
    if (padded) { const margin = (high - low) * 0.1 || Math.max(high * 0.05, 5); low -= margin; high += margin; }
    low = Math.max(0, low);
    if (high <= low) high = low + 1;
    const raw = (high - low) / count, magnitude = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map(factor => factor * magnitude).find(candidate => candidate >= raw);
    const ticks = [];
    for (let value = Math.floor(low / step) * step; value < high + step - 1e-9; value += step) ticks.push(Number(value.toFixed(6)));
    return ticks;
  }
  function dateTicks(first, last, count) {
    if (last <= first) return [first];
    return Array.from({ length: count }, (_, index) => first + (last - first) * index / (count - 1));
  }
  const tickDate = (ms, long) => { const date = isoDate(ms); return long ? `${date.slice(0, 4)}.${Number(date.slice(5, 7))}` : `${Number(date.slice(5, 7))}.${Number(date.slice(8, 10))}`; };
  // A column that grows from the baseline with a 4px rounded data end.
  function column(x, y, width, base) {
    const height = base - y, radius = Math.min(4, width / 2, height);
    if (height <= 0) return '';
    return `M${x.toFixed(1)},${base.toFixed(1)}V${(y + radius).toFixed(1)}Q${x.toFixed(1)},${y.toFixed(1)} ${(x + radius).toFixed(1)},${y.toFixed(1)}H${(x + width - radius).toFixed(1)}Q${(x + width).toFixed(1)},${y.toFixed(1)} ${(x + width).toFixed(1)},${(y + radius).toFixed(1)}V${base.toFixed(1)}Z`;
  }

  // One entry per training day of a lift: best set by weight and by e1RM, plus totals.
  function trainingDays(lift, start) {
    const days = new Map();
    for (const record of state.records) {
      if (record.lift !== lift || !record.valid || !record.date || (start && record.date < start)) continue;
      const day = days.get(record.date) || { date: record.date, volume: 0, sets: 0, records: [], top: null, topE1rm: null };
      day.volume += record.volume;
      day.sets += record.sets;
      day.records.push(record);
      if (countsTowardBest(record)) {
        if (!day.top || record.weight > day.top.weight || (record.weight === day.top.weight && record.reps > day.top.reps)) day.top = record;
        if (!day.topE1rm || record.e1rm > day.topE1rm.e1rm) day.topE1rm = record;
      }
      days.set(record.date, day);
    }
    return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  }
  const metricValue = (day, metric) => metric === 'volume' ? day.volume : metric === 'e1rm' ? day.topE1rm?.e1rm ?? null : day.top?.weight ?? null;
  const valueHtml = value => state.metric === 'volume' ? `${fmt(value, 0)}<small>kg</small>` : `${fmt(value)}<small>kg</small>`;
  const valueText = value => state.metric === 'volume' ? `${fmt(value, 0)} kg` : `${fmt(value)} kg`;
  const setText = record => `${escape(record.exercise)} ${fmt(record.weight)}kg × ${record.reps}${record.sets > 1 ? ` × ${record.sets} 组` : ''}${record.rpe != null ? ` · RPE ${fmt(record.rpe)}` : ''}`;
  function exerciseSummary(records) {
    const sets = new Map();
    for (const record of records) sets.set(record.exercise, (sets.get(record.exercise) || 0) + record.sets);
    return [...sets].map(([name, count]) => `${escape(name)} ${count} 组`).join('、');
  }

  // The top bar keeps only the freshness of the data; counts and provenance live in the footer.
  function renderHeader() {
    if (!state.loaded) return;
    const snapshot = state.source === 'snapshot' && state.generatedAt;
    $('source-detail').textContent = snapshot ? `数据更新于 ${stamp(new Date(state.generatedAt))}` : `读取于 ${stamp(state.readAt)}`;
    const counts = `共 ${fmt(state.records.length, 0)} 条力量记录${state.runs.length ? `、${fmt(state.runs.length, 0)} 次跑步` : ''}`;
    $('footer-text').textContent = snapshot ? `${counts} · 私人只读页面，数据以最近一次发布为准` : `${counts} · 数据只在这台电脑的浏览器里读取，不上传`;
  }

  function liftSummary(key) {
    const days = trainingDays(key, null);
    let best = null, bestE1rm = null;
    for (const day of days) {
      if (day.top && (!best || day.top.weight > best.weight)) best = day.top;
      if (day.topE1rm && (!bestE1rm || day.topE1rm.e1rm > bestE1rm.e1rm)) bestE1rm = day.topE1rm;
    }
    // Weekly best e1RM over the last 12 weeks, for the sparkline.
    const end = time(weekStart(localToday()));
    const weekly = Array.from({ length: 12 }, (_, index) => ({ week: isoDate(end - (11 - index) * 7 * DAY), value: null }));
    const byWeek = new Map(weekly.map(item => [item.week, item]));
    for (const day of days) {
      const item = byWeek.get(weekStart(day.date));
      if (item && day.topE1rm) item.value = Math.max(item.value ?? 0, day.topE1rm.e1rm);
    }
    return { best, bestE1rm, spark: weekly.map(item => item.value) };
  }
  function sparkline(values) {
    const known = values.map((value, index) => ({ value, index })).filter(item => item.value != null);
    if (known.length < 2) return '<svg class="spark" aria-hidden="true"></svg>';
    const low = Math.min(...known.map(item => item.value)), high = Math.max(...known.map(item => item.value));
    const x = index => index / (values.length - 1) * 100, y = value => 26 - (value - low) / (high - low || 1) * 22;
    const path = known.map((item, index) => `${index ? 'L' : 'M'}${x(item.index).toFixed(2)},${y(item.value).toFixed(2)}`).join('');
    const last = known.at(-1);
    return `<svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><path class="spark-line" d="${path}"/><path class="spark-end" d="M${x(last.index).toFixed(2)},${y(last.value).toFixed(2)}h0"/></svg>`;
  }
  function renderHero() {
    const summaries = LIFTS.map(lift => ({ lift, ...liftSummary(lift.key) }));
    const total = summaries.every(item => item.best) ? summaries.reduce((sum, item) => sum + item.best.weight, 0) : null;
    $('total-value').innerHTML = total == null ? '—' : `${fmt(total)}<small>kg</small>`;
    $('total-split').innerHTML = summaries.map(({ lift, best }) => `<span>${plate(lift.color)}${lift.name} ${best ? fmt(best.weight) : '—'}</span>`).join('<span class="plus" aria-hidden="true">+</span>');
    $('lift-tiles').innerHTML = summaries.map(({ lift, best, bestE1rm, spark }) => {
      const detail = best ? `${best.exercise} ${fmt(best.weight)}kg × ${best.reps} · ${best.date}` : '暂无记录';
      return `<button type="button" class="lift-tile" data-lift="${lift.key}" aria-pressed="${state.lift === lift.key}" style="--lift:${lift.color}" title="${escape(detail)}" aria-label="${lift.name}最高训练重量 ${best ? fmt(best.weight) + ' 公斤' : '暂无'}，查看趋势"><span class="tile-name">${plate(lift.color)}${lift.name}</span><span class="tile-value">${best ? fmt(best.weight) : '—'}<small>kg</small></span><span class="tile-meta">${bestE1rm ? `估算 1RM ${fmt(bestE1rm.e1rm)}` : '暂无记录'}</span>${sparkline(spark)}</button>`;
    }).join('');
  }
  function renderLiftSwitch() {
    $('lift-switch').innerHTML = LIFTS.map(lift => `<button class="chip" type="button" data-lift="${lift.key}" aria-pressed="${state.lift === lift.key}">${plate(lift.color)}${lift.name}</button>`).join('');
  }

  function renderTrend() {
    const start = rangeStart();
    const days = trainingDays(state.lift, start);
    view.trend = days.map(day => ({ day, value: metricValue(day, state.metric) })).filter(point => point.value != null && point.value > 0);
    if (state.trendIndex == null || state.trendIndex >= view.trend.length) state.trendIndex = view.trend.length ? view.trend.length - 1 : null;
    const lift = LIFT[state.lift], metric = METRICS[state.metric], points = view.trend;
    $('trend-caption').textContent = `${lift.name} · ${metric.label} · ${RANGE_LABEL[state.range]}`;
    $('trend-note').textContent = metric.note;
    const peak = points.reduce((best, point) => !best || point.value > best.value ? point : best, null);
    const latest = points.at(-1);
    const stats = state.metric === 'volume'
      ? [stat('期间总量', points.length ? tons(points.reduce((sum, point) => sum + point.value, 0)) : '—', 't'), stat('单日最高', peak ? tons(peak.value) : '—', 't', peak ? monthDay(peak.day.date) : ''), stat('训练日', fmt(days.length, 0), '天')]
      : [stat('期间最高', peak ? fmt(peak.value) : '—', 'kg', peak ? monthDay(peak.day.date) : ''), stat('最近一次', latest ? fmt(latest.value) : '—', 'kg', latest ? monthDay(latest.day.date) : ''), stat('训练日', fmt(days.length, 0), '天')];
    $('trend-stats').innerHTML = stats.join('');
    drawTrend();
    renderTrendTable();
  }
  function drawTrend() {
    const box = $('trend-chart'), points = view.trend, lift = LIFT[state.lift];
    box.style.setProperty('--series', lift.color);
    view.trendGeometry = null;
    if (!points.length) {
      box.innerHTML = `<div class="chart-empty">${icon('trend')}${state.loaded ? `${RANGE_LABEL[state.range]}没有${lift.name}记录` : '载入记录后显示趋势'}<span>${state.loaded ? '换个时间范围看看' : ''}</span></div>`;
      $('trend-readout').hidden = true;
      return;
    }
    const isVolume = state.metric === 'volume';
    const width = Math.max(280, Math.round(box.clientWidth || 640)), height = width < 560 ? 230 : 280;
    const values = points.map(point => point.value);
    const ticks = niceTicks(isVolume ? 0 : Math.min(...values), Math.max(...values), 4, !isVolume);
    const tickLabel = value => isVolume ? `${fmt(value / 1000)}t` : fmt(value);
    const pad = { top: 26, right: 16, bottom: 30, left: Math.ceil(Math.max(...ticks.map(tick => textWidth(tickLabel(tick))))) + 10 };
    const plotWidth = width - pad.left - pad.right, plotHeight = height - pad.top - pad.bottom;
    const start = rangeStart();
    const first = time(start ?? points[0].day.date), last = Math.max(time(localToday()), time(points.at(-1).day.date));
    const span = Math.max(last - first, DAY);
    const xOf = date => pad.left + (time(date) - first) / span * plotWidth;
    const yOf = value => pad.top + (ticks.at(-1) - value) / (ticks.at(-1) - ticks[0]) * plotHeight;
    const base = yOf(ticks[0]);
    let svg = '';
    for (const tick of ticks) {
      const y = yOf(tick);
      svg += `<line class="${tick === ticks[0] ? 'axis' : 'grid'}" x1="${pad.left}" x2="${width - pad.right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/><text x="${pad.left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end">${tickLabel(tick)}</text>`;
    }
    const xTicks = dateTicks(first, last, width < 420 ? 3 : 5);
    xTicks.forEach((tick, index) => {
      const anchor = xTicks.length === 1 ? 'middle' : index === 0 ? 'start' : index === xTicks.length - 1 ? 'end' : 'middle';
      svg += `<text x="${(pad.left + (tick - first) / span * plotWidth).toFixed(1)}" y="${height - 8}" text-anchor="${anchor}">${tickDate(tick, span > 330 * DAY)}</text>`;
    });
    const xs = points.map(point => xOf(point.day.date)), ys = values.map(yOf);
    const peakIndex = values.indexOf(Math.max(...values));
    if (isVolume) {
      const barWidth = Math.max(2, Math.min(24, plotWidth / (span / DAY + 1) * 0.7));
      svg += points.map((point, index) => `<path class="bar" d="${column(xs[index] - barWidth / 2, ys[index], barWidth, base)}"/>`).join('');
    } else {
      const line = xs.map((x, index) => `${index ? 'L' : 'M'}${x.toFixed(1)},${ys[index].toFixed(1)}`).join('');
      svg += `<path class="area" d="${line}L${xs.at(-1).toFixed(1)},${base.toFixed(1)}L${xs[0].toFixed(1)},${base.toFixed(1)}Z"/><path class="line" d="${line}"/>`;
      if (plotWidth / Math.max(points.length - 1, 1) >= 7) svg += xs.map((x, index) => `<circle class="point" cx="${x.toFixed(1)}" cy="${ys[index].toFixed(1)}" r="2.5"/>`).join('');
      svg += `<circle class="best" cx="${xs[peakIndex].toFixed(1)}" cy="${ys[peakIndex].toFixed(1)}" r="5.5"/><circle class="end" cx="${xs.at(-1).toFixed(1)}" cy="${ys.at(-1).toFixed(1)}" r="4.5"/>`;
    }
    // Label only the extreme; the axis, readout and table carry every other value.
    const peakLabel = `${isVolume ? '单日最高' : '最佳'} ${isVolume ? `${fmt(values[peakIndex] / 1000)}t` : fmt(values[peakIndex])}`;
    const labelWidth = textWidth(peakLabel);
    const labelX = Math.min(Math.max(xs[peakIndex], pad.left + labelWidth / 2), width - pad.right - labelWidth / 2);
    svg += `<text class="best-label" x="${labelX.toFixed(1)}" y="${(ys[peakIndex] - 11).toFixed(1)}" text-anchor="middle">${peakLabel}</text>`;
    const aria = `${lift.name}${METRICS[state.metric].label}，${RANGE_LABEL[state.range]}，${points.length} 个训练日，最高 ${valueText(values[peakIndex])}`;
    box.innerHTML = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(aria)}">${svg}<line class="crosshair" x1="0" x2="0" y1="${pad.top - 6}" y2="${base.toFixed(1)}" visibility="hidden"/><circle class="focus" r="5" visibility="hidden"/></svg><div class="tooltip" hidden></div>`;
    view.trendGeometry = { xs, ys };
    showTrendSelection(false);
  }
  function showTrendSelection(withTooltip) {
    const box = $('trend-chart'), geometry = view.trendGeometry, index = state.trendIndex;
    if (!geometry || index == null) return;
    const svg = box.querySelector('svg'), cross = svg.querySelector('.crosshair'), focus = svg.querySelector('.focus'), tip = box.querySelector('.tooltip');
    const x = geometry.xs[index], y = geometry.ys[index];
    cross.setAttribute('x1', x.toFixed(1));
    cross.setAttribute('x2', x.toFixed(1));
    // The crosshair appears while the reader is scrubbing; at rest the focus dot marks the day.
    cross.setAttribute('visibility', withTooltip ? 'visible' : 'hidden');
    focus.setAttribute('cx', x.toFixed(1));
    focus.setAttribute('cy', y.toFixed(1));
    focus.setAttribute('visibility', 'visible');
    if (withTooltip) {
      const point = view.trend[index];
      tip.innerHTML = `<strong>${valueText(point.value)}</strong>${monthDay(point.day.date)} ${weekday(point.day.date)}`;
      tip.hidden = false;
      const left = Math.min(Math.max(x - tip.offsetWidth / 2, 0), box.clientWidth - tip.offsetWidth);
      const top = y - tip.offsetHeight - 14 < 0 ? y + 14 : y - tip.offsetHeight - 14;
      tip.style.transform = `translate(${left.toFixed(0)}px, ${top.toFixed(0)}px)`;
    } else tip.hidden = true;
    renderTrendReadout();
  }
  function renderTrendReadout() {
    const box = $('trend-readout'), point = view.trend[state.trendIndex];
    if (!point) { box.hidden = true; return; }
    const day = point.day;
    let detail;
    if (state.metric === 'volume') detail = `<p>${fmt(day.sets, 0)} 组：${exerciseSummary(day.records)}</p>`;
    else {
      const top = state.metric === 'e1rm' ? day.topE1rm : day.top;
      const other = state.metric === 'weight' ? `估算 1RM ${fmt(top.e1rm)}kg` : `当天最高重量 ${fmt(day.top.weight)}kg`;
      detail = `<p>最好的一组：${setText(top)}</p><p>${other} · 当天 ${fmt(day.sets, 0)} 组 · 训练量 ${fmt(day.volume, 0)}kg</p>`;
    }
    box.innerHTML = `<div class="readout-head"><span>${fullDate(day.date)} ${weekday(day.date)}</span><span>第 ${state.trendIndex + 1} / ${view.trend.length} 个训练日</span></div><span class="readout-value">${valueHtml(point.value)}</span>${detail}<button type="button" class="link-button" data-goto="${day.date}">查看这天的训练${icon('arrow')}</button>`;
    box.hidden = false;
  }
  function renderTrendTable() {
    const volume = state.metric === 'volume';
    const rows = [...view.trend].reverse().map(point => {
      const top = state.metric === 'e1rm' ? point.day.topE1rm : point.day.top;
      return `<tr><td>${point.day.date}</td><td>${valueText(point.value)}</td><td>${volume || !top ? `${fmt(point.day.sets, 0)} 组` : `${escape(top.exercise)} ${fmt(top.weight)} × ${top.reps}`}</td></tr>`;
    }).join('');
    $('trend-table').innerHTML = `<thead><tr><th>日期</th><th>${METRICS[state.metric].label}</th><th>${volume ? '组数' : '最好的一组'}</th></tr></thead><tbody>${rows || '<tr><td colspan="3">没有数据</td></tr>'}</tbody>`;
  }

  function calendarDays(start) {
    const days = new Map();
    const entry = date => {
      if (!days.has(date)) days.set(date, { date, sets: { squat: 0, bench: 0, deadlift: 0 }, total: 0, volume: 0, km: 0, runs: 0 });
      return days.get(date);
    };
    for (const record of state.records) {
      if (!record.valid || !record.date || (start && record.date < start)) continue;
      const day = entry(record.date);
      day.sets[record.lift] += record.sets;
      day.total += record.sets;
      day.volume += record.volume;
    }
    for (const run of state.runs) {
      if (!run.valid || !run.date || (start && run.date < start)) continue;
      const day = entry(run.date);
      day.km += run.distance;
      day.runs += 1;
    }
    return days;
  }
  function renderCalendar() {
    const start = rangeStart(), today = localToday();
    const days = calendarDays(start);
    view.calendar = days;
    const lifting = [...days.values()].filter(day => day.total > 0);
    $('calendar-stats').innerHTML = [
      stat('力量训练日', fmt(lifting.length, 0), '天'),
      stat('工作组', fmt(lifting.reduce((sum, day) => sum + day.total, 0), 0), '组'),
      stat('训练量', lifting.length ? tons(lifting.reduce((sum, day) => sum + day.volume, 0)) : '—', 't')
    ].join('');
    $('calendar-caption').textContent = `${RANGE_LABEL[state.range]} · 点一下格子，查看那天练了什么`;
    const dates = [...days.keys()].sort();
    const first = start ?? dates[0] ?? today;
    view.calendarFirst = first;
    const firstWeek = time(weekStart(first)), lastWeek = time(weekStart(today));
    const weeks = Math.max(1, Math.round((lastWeek - firstWeek) / (7 * DAY)) + 1);
    const cell = 14, step = 17, left = 22, top = 18;
    const width = left + weeks * step, height = top + 7 * step;
    let svg = [['一', 0], ['三', 2], ['五', 4]].map(([label, row]) => `<text x="0" y="${top + row * step + 11}">${label}</text>`).join('');
    let labelledColumn = -3, labelledMonth = '';
    for (let week = 0; week < weeks; week++) {
      const weekTime = firstWeek + week * 7 * DAY;
      const month = isoDate(weekTime + 6 * DAY).slice(0, 7);
      if (month !== labelledMonth && week - labelledColumn >= 3) {
        svg += `<text x="${left + week * step}" y="11">${Number(month.slice(5))}月</text>`;
        labelledColumn = week;
        labelledMonth = month;
      }
      for (let weekdayIndex = 0; weekdayIndex < 7; weekdayIndex++) {
        const date = isoDate(weekTime + weekdayIndex * DAY);
        if (date > today || date < first) continue;
        const day = days.get(date);
        const level = !day || !day.total ? 0 : day.total >= 18 ? 4 : day.total >= 12 ? 3 : day.total >= 6 ? 2 : 1;
        const x = left + week * step, y = top + weekdayIndex * step;
        const summary = day ? [day.total ? `${day.total} 组` : '', day.runs ? `跑步 ${fmt(day.km)} km` : ''].filter(Boolean).join('，') : '休息';
        svg += `<rect class="cell h${level}${date === today ? ' today' : ''}" data-date="${date}" x="${x}" y="${y}" width="${cell}" height="${cell}" rx="3"><title>${monthDay(date)} ${weekday(date)}：${summary}</title></rect>`;
        if (day?.runs) svg += `<circle class="run-dot" cx="${x + cell - 3}" cy="${y + cell - 3}" r="3"/>`;
      }
    }
    $('calendar').innerHTML = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(`${RANGE_LABEL[state.range]}训练日历，${lifting.length} 个力量训练日`)}">${svg}</svg>`;
    if (!state.calendarDate || state.calendarDate < first || state.calendarDate > today) state.calendarDate = dates.at(-1) ?? today;
    selectCalendarDate(state.calendarDate, false);
    const scroller = $('calendar-scroll');
    scroller.scrollLeft = scroller.scrollWidth;
  }
  function selectCalendarDate(date, reveal) {
    state.calendarDate = date;
    const svg = $('calendar').querySelector('svg');
    svg?.querySelectorAll('.selected').forEach(cell => cell.classList.remove('selected'));
    const cell = svg?.querySelector(`[data-date="${date}"]`);
    cell?.classList.add('selected');
    if (reveal && cell) cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const box = $('day-readout'), day = view.calendar.get(date);
    if (!state.loaded) { box.hidden = true; return; }
    const items = day ? [
      ...LIFTS.filter(lift => day.sets[lift.key]).map(lift => `<li>${plate(lift.color)}${lift.name} ${day.sets[lift.key]} 组</li>`),
      day.runs ? `<li>${plate(RUN_COLOR)}跑步 ${fmt(day.km, 2)} km</li>` : ''
    ].join('') : '';
    box.innerHTML = `<div class="readout-head"><span>${fullDate(date)} ${weekday(date)}</span><span>${date === localToday() ? '今天' : ''}</span></div>${day ? `<ul class="readout-items">${items}</ul>${day.total ? `<p>训练量 ${fmt(day.volume, 0)}kg</p>` : ''}<button type="button" class="link-button" data-goto="${date}">查看这天的训练${icon('arrow')}</button>` : '<p>这天没有训练记录。</p>'}`;
    box.hidden = false;
  }

  function renderRunning() {
    const start = rangeStart(), today = localToday();
    const runs = state.runs.filter(run => run.valid && run.date && (!start || run.date >= start)).sort((a, b) => a.date.localeCompare(b.date));
    const total = runs.reduce((sum, run) => sum + run.distance, 0);
    const timed = runs.filter(run => run.seconds);
    const average = timed.length ? timed.reduce((sum, run) => sum + run.seconds, 0) / timed.reduce((sum, run) => sum + run.distance, 0) : null;
    $('running-stats').innerHTML = [
      stat('里程', runs.length ? fmt(total) : '—', 'km'),
      stat('次数', runs.length ? fmt(runs.length, 0) : '—', '次'),
      stat('最长', runs.length ? fmt(Math.max(...runs.map(run => run.distance))) : '—', 'km'),
      stat('平均配速', average ? pace(average) : '—', average ? '/km' : '')
    ].join('');
    $('running-caption').textContent = `${RANGE_LABEL[state.range]} · 每周里程，周一为一周开始`;
    view.weeks = [];
    if (runs.length) {
      const firstWeek = time(weekStart(start ?? runs[0].date)), lastWeek = time(weekStart(today));
      const count = Math.max(1, Math.round((lastWeek - firstWeek) / (7 * DAY)) + 1);
      view.weeks = Array.from({ length: count }, (_, index) => ({ week: isoDate(firstWeek + index * 7 * DAY), runs: [], km: 0 }));
      const byWeek = new Map(view.weeks.map(item => [item.week, item]));
      for (const run of runs) {
        const item = byWeek.get(weekStart(run.date));
        if (item) { item.runs.push(run); item.km += run.distance; }
      }
      if (!byWeek.has(state.runWeek)) state.runWeek = [...view.weeks].reverse().find(item => item.km > 0)?.week ?? view.weeks.at(-1).week;
    }
    drawRunChart();
    renderRunReadout();
  }
  function drawRunChart() {
    const box = $('run-chart'), weeks = view.weeks;
    box.style.setProperty('--series', RUN_COLOR);
    view.runXs = [];
    if (!weeks.length) {
      box.innerHTML = `<div class="chart-empty">${icon('run')}${state.loaded ? `${RANGE_LABEL[state.range]}没有跑步记录` : '载入记录后显示每周里程'}<span>在聊天里发“10.12 跑步 10km”就能记录</span></div>`;
      return;
    }
    const width = Math.max(260, Math.round(box.clientWidth || 480)), height = 200;
    const ticks = niceTicks(0, Math.max(...weeks.map(item => item.km), 1), 3, false);
    const pad = { top: 24, right: 8, bottom: 30, left: Math.ceil(Math.max(...ticks.map(tick => textWidth(fmt(tick))))) + 10 };
    const plotWidth = width - pad.left - pad.right, plotHeight = height - pad.top - pad.bottom;
    const slot = plotWidth / weeks.length, barWidth = Math.max(3, Math.min(24, slot * 0.6));
    const yOf = value => pad.top + (ticks.at(-1) - value) / ticks.at(-1) * plotHeight, base = yOf(0);
    let svg = '';
    for (const tick of ticks) {
      const y = yOf(tick);
      svg += `<line class="${tick === 0 ? 'axis' : 'grid'}" x1="${pad.left}" x2="${width - pad.right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/><text x="${pad.left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end">${fmt(tick)}</text>`;
    }
    const labelEvery = Math.max(1, Math.ceil(weeks.length / (width < 420 ? 4 : 6)));
    weeks.forEach((item, index) => {
      const center = pad.left + slot * index + slot / 2;
      view.runXs.push(center);
      if (item.week === state.runWeek) svg += `<rect class="week-highlight" x="${(center - slot / 2).toFixed(1)}" y="${pad.top - 8}" width="${slot.toFixed(1)}" height="${(base - pad.top + 8).toFixed(1)}" rx="6"/>`;
      if (item.km > 0) {
        svg += `<path class="bar" d="${column(center - barWidth / 2, yOf(item.km), barWidth, base)}"/>`;
        if (barWidth >= 14) svg += `<text class="bar-value" x="${center.toFixed(1)}" y="${(yOf(item.km) - 6).toFixed(1)}" text-anchor="middle">${fmt(item.km)}</text>`;
      }
      if ((weeks.length - 1 - index) % labelEvery === 0) svg += `<text x="${center.toFixed(1)}" y="${height - 8}" text-anchor="middle">${Number(item.week.slice(5, 7))}.${Number(item.week.slice(8, 10))}</text>`;
      svg += `<rect class="hit" x="${(center - slot / 2).toFixed(1)}" y="${pad.top - 8}" width="${slot.toFixed(1)}" height="${(base - pad.top + 8).toFixed(1)}"><title>${monthDay(item.week)} 起这一周：${fmt(item.km)} km</title></rect>`;
    });
    box.innerHTML = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(`每周跑步里程，共 ${weeks.length} 周，最多一周 ${fmt(Math.max(...weeks.map(item => item.km)))} 公里`)}">${svg}</svg>`;
  }
  function renderRunReadout() {
    const box = $('run-readout'), item = view.weeks.find(week => week.week === state.runWeek);
    if (!item) { box.hidden = true; return; }
    const end = isoDate(time(item.week) + 6 * DAY);
    const list = item.runs.map(run => `<li>${plate(RUN_COLOR)}${monthDay(run.date)} ${fmt(run.distance, 2)} km${run.seconds ? ` · ${clock(run.seconds)} · ${pace(run.pace)}/km` : ''}</li>`).join('');
    box.innerHTML = `<div class="readout-head"><span>${monthDay(item.week)} – ${monthDay(end)}</span><span>${item.runs.length} 次</span></div><span class="readout-value">${fmt(item.km)}<small>km</small></span>${list ? `<ul class="readout-items">${list}</ul>` : '<p>这一周没有跑步。</p>'}`;
    box.hidden = false;
  }

  function renderLogFilter() {
    const options = [['all', '全部', null], ...LIFTS.map(lift => [lift.key, lift.name, lift.color]), ['run', '跑步', RUN_COLOR]];
    $('log-filter').innerHTML = options.map(([key, label, color]) => `<button class="chip" type="button" data-filter="${key}" aria-pressed="${state.logFilter === key}">${color ? plate(color) : ''}${label}</button>`).join('');
  }
  function logDays() {
    const start = rangeStart(), filter = state.logFilter, days = new Map();
    const day = date => {
      if (!days.has(date)) days.set(date, { date, lifts: { squat: [], bench: [], deadlift: [] }, runs: [] });
      return days.get(date);
    };
    for (const record of state.records) {
      if ((filter !== 'all' && filter !== record.lift) || (record.date && start && record.date < start)) continue;
      day(record.date || '').lifts[record.lift].push(record);
    }
    for (const run of state.runs) {
      if ((filter !== 'all' && filter !== 'run') || (run.date && start && run.date < start)) continue;
      day(run.date || '').runs.push(run);
    }
    return [...days.values()].sort((a, b) => b.date.localeCompare(a.date));
  }
  function setChip(record) {
    const weight = record.weight != null ? fmt(record.weight) : escape(record.weightRaw || '?');
    const reps = record.reps ?? escape(record.repsRaw || '?'), sets = record.sets ?? escape(record.setsRaw || '?');
    const band = rpeBand(record.rpe);
    const rpe = record.rpeRaw ? `<span class="rpe ${band}" title="RPE ${escape(record.rpeRaw)}${band ? ` · ${RPE_LABEL[band]}` : ''}">${escape(record.rpeRaw)}</span>` : '';
    return `<span class="set${rpe ? '' : ' plain'}">${weight}<small>kg</small> × ${reps}${sets !== 1 ? ` × ${sets}` : ''}${rpe}</span>`;
  }
  function exerciseBlock(name, records) {
    const first = records[0];
    const tags = `${first.partialRange ? '<span class="tag">半程</span>' : ''}${first.accessory ? '<span class="tag">辅助</span>' : ''}`;
    const notes = [...new Set(records.map(record => record.note).filter(Boolean))].map(note => `<div class="entry-note">${escape(note)}</div>`).join('');
    const marks = [...new Set(records.map(record => record.manualMax).filter(Boolean))].map(mark => `<div class="entry-note">原表标注：${escape(mark)}</div>`).join('');
    const issues = [...new Set(records.flatMap(record => record.issues))].map(issue => `<div class="entry-issue">${escape(issue)}</div>`).join('');
    return `<div class="exercise"><div class="exercise-name">${escape(name)}${tags}</div><div class="sets">${records.map(setChip).join('')}</div>${notes}${marks}${issues}</div>`;
  }
  function liftGroup(lift, records) {
    if (!records.length) return '';
    const exercises = [];
    for (const record of [...records].sort((a, b) => a.row - b.row)) {
      const last = exercises.at(-1);
      if (last && last.name === record.exercise) last.records.push(record);
      else exercises.push({ name: record.exercise, records: [record] });
    }
    return `<div class="lift-group"><div class="lift-label">${plate(lift.color)}${lift.name}</div>${exercises.map(item => exerciseBlock(item.name, item.records)).join('')}</div>`;
  }
  function runGroup(runs) {
    if (!runs.length) return '';
    return `<div class="lift-group"><div class="lift-label">${plate(RUN_COLOR)}跑步</div>${runs.map(run => `<div class="exercise"><div class="sets"><span class="set plain">${run.distance != null ? fmt(run.distance, 2) : '?'}<small>km</small></span>${run.seconds ? `<span class="set plain">${clock(run.seconds)}</span>` : ''}${run.pace ? `<span class="set plain">${pace(run.pace)}<small>/km</small></span>` : ''}</div>${run.note ? `<div class="entry-note">${escape(run.note)}</div>` : ''}${run.issues.map(issue => `<div class="entry-issue">${escape(issue)}</div>`).join('')}</div>`).join('')}</div>`;
  }
  function dayCard(day) {
    const lifting = LIFTS.flatMap(lift => day.lifts[lift.key]).filter(record => record.valid);
    const sets = lifting.reduce((sum, record) => sum + record.sets, 0), volume = lifting.reduce((sum, record) => sum + record.volume, 0);
    const km = day.runs.reduce((sum, run) => sum + (run.distance || 0), 0);
    const meta = [lifting.length ? `${fmt(sets, 0)} 组 · ${fmt(volume, 0)} kg` : '', day.runs.length ? `跑步 ${fmt(km)} km` : ''].filter(Boolean).join(' · ');
    const year = day.date && day.date.slice(0, 4) !== localToday().slice(0, 4) ? ` · ${day.date.slice(0, 4)}` : '';
    const title = day.date ? `${monthDay(day.date)}<span>${weekday(day.date)}${year}</span>` : '日期待确认';
    return `<article class="day" id="day-${day.date || 'undated'}"><div class="day-head"><div class="day-date">${title}</div><div class="day-meta">${meta}</div></div>${LIFTS.map(lift => liftGroup(lift, day.lifts[lift.key])).join('')}${runGroup(day.runs)}</article>`;
  }
  function renderLog() {
    const days = logDays(), shown = days.slice(0, state.logDays);
    $('history-caption').textContent = days.length ? `${RANGE_LABEL[state.range]} · ${days.length} 个训练日，最新的在前` : RANGE_LABEL[state.range];
    $('log').innerHTML = shown.length ? shown.map(dayCard).join('') : `<div class="log-empty">${state.loaded ? '这个范围内没有记录' : '载入记录后显示训练日志'}<span>${state.loaded ? '换个时间范围或筛选条件看看' : ''}</span></div>`;
    $('show-more').hidden = days.length <= state.logDays;
    $('show-more').textContent = `显示更多（还有 ${days.length - shown.length} 天）`;
  }
  function gotoDay(date) {
    if (state.logFilter !== 'all') { state.logFilter = 'all'; renderLogFilter(); }
    const index = logDays().findIndex(day => day.date === date);
    if (index >= state.logDays) state.logDays = index + 1;
    renderLog();
    const card = document.getElementById(`day-${date}`);
    if (!card) return;
    card.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    card.classList.add('flash');
    setTimeout(() => card.classList.remove('flash'), 1600);
  }

  function renderQuality() {
    const invalid = state.records.filter(record => !record.valid).length + state.runs.filter(run => !run.valid).length;
    const undated = state.records.filter(record => !record.date).length + state.runs.filter(run => !run.date).length;
    const parts = [];
    if (state.dateCorrections.length) parts.push(`${state.dateCorrections.length} 处历史日期已按记录顺序校正`);
    if (invalid) parts.push(`${invalid} 行数值不完整，未计入统计`);
    if (undated) parts.push(`${undated} 行日期待确认`);
    if (!parts.length && state.warnings.length) parts.push(`${state.warnings.length} 条数据提示`);
    $('data-quality').hidden = !parts.length;
    $('quality-summary').textContent = `数据提示：${parts.join(' · ')}`;
    $('date-corrections').hidden = !state.dateCorrections.length;
    $('date-correction-list').innerHTML = state.dateCorrections.map(item => `<li>${escape(item.sheet)} · A${item.row}：${escape(item.from)} → ${escape(item.to)}（${escape(item.reason)}）</li>`).join('');
    $('quality-list').innerHTML = state.warnings.map(item => `<li>${escape(item.sheet)}${item.row ? ` 第 ${item.row} 行` : ''}：${escape(item.message)}</li>`).join('');
  }

  function render() {
    renderHeader();
    renderHero();
    renderLiftSwitch();
    renderTrend();
    renderCalendar();
    renderRunning();
    renderLogFilter();
    renderLog();
    renderQuality();
  }

  // Horizontal scrubbing on charts: mouse hover, touch drag (vertical swipes still scroll) and arrow keys.
  function bindScrub(box, positions, current, select) {
    const nearest = clientX => {
      const xs = positions();
      if (!xs.length) return null;
      const x = clientX - box.getBoundingClientRect().left;
      let low = 0, high = xs.length - 1;
      while (low < high) { const middle = (low + high) >> 1; if (xs[middle] < x) low = middle + 1; else high = middle; }
      return low > 0 && Math.abs(xs[low - 1] - x) <= Math.abs(xs[low] - x) ? low - 1 : low;
    };
    let dragging = false;
    box.addEventListener('pointerdown', event => { const index = nearest(event.clientX); if (index == null) return; dragging = true; select(index, true); });
    box.addEventListener('pointermove', event => { if (event.pointerType !== 'mouse' && !dragging) return; const index = nearest(event.clientX); if (index != null) select(index, true); });
    const stop = event => { dragging = false; if (event.pointerType !== 'mouse') hideTooltip(box); };
    box.addEventListener('pointerup', stop);
    box.addEventListener('pointercancel', stop);
    box.addEventListener('pointerleave', event => { dragging = false; if (event.pointerType === 'mouse') hideTooltip(box); });
    box.addEventListener('keydown', event => {
      const count = positions().length;
      if (!count) return;
      const index = current() ?? count - 1;
      const next = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: count - 1 }[event.key];
      if (next == null) return;
      event.preventDefault();
      select(Math.min(Math.max(next, 0), count - 1), true);
    });
  }
  const hideTooltip = box => { const tip = box.querySelector('.tooltip'); if (tip) tip.hidden = true; };

  function setNotice(message = '', error = false) { $('notice').textContent = message; $('notice').hidden = !message; $('notice').classList.toggle('error', error); }
  function setBusy(value) { state.busy = value; document.body.classList.toggle('busy', value); $('import').disabled = value; $('refresh').disabled = value; }
  async function loadBuffer(buffer, source) { loadData(await window.PowerLogXlsx.readWorkbook(buffer), source); }
  function loadData(workbook, source) {
    Object.assign(state, {
      records: workbook.records, runs: workbook.runs || [], warnings: workbook.warnings, dateCorrections: workbook.dateCorrections || [],
      loaded: true, source, readAt: new Date(), generatedAt: workbook.generatedAt || null, trendIndex: null, calendarDate: null, runWeek: null, logDays: 10
    });
    setNotice(source === 'file' ? '已读取所选文件。Excel 更新后，需要重新选择文件。' : '');
    render();
  }
  function showError(error) {
    setNotice(`${error.message || '读取失败，请重试。'}${state.loaded ? ' 页面保留上次成功读取的数据。' : ''}`, true);
    if (!state.loaded) $('source-detail').textContent = '尚未读取训练记录';
  }
  async function chooseFile() {
    if (state.busy) return;
    if ('showOpenFilePicker' in window && window.isSecureContext) {
      setBusy(true);
      try {
        const [handle] = await window.showOpenFilePicker({ multiple: false, types: [{ description: 'Excel 训练工作簿', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } }] });
        await loadBuffer(await (await handle.getFile()).arrayBuffer(), 'handle');
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
        if (workbook.schemaVersion !== 1 || !Array.isArray(workbook.records) || !Array.isArray(workbook.sheets) || !Array.isArray(workbook.warnings) || (workbook.runs != null && !Array.isArray(workbook.runs)) || !Number.isFinite(Date.parse(workbook.generatedAt))) throw new Error('训练数据格式无效，请重新发布页面。');
        loadData(workbook, 'snapshot');
        state.handle = null;
        return;
      }
      const response = await fetch(new URL('HylPowerliftingTraining.xlsx', window.location.href), { cache: 'no-store' });
      if (!response.ok) throw new Error(`没有读到目录中的工作簿（HTTP ${response.status}），请点击“选择工作簿”。`);
      if (Number(response.headers.get('Content-Length')) > 50 * 1024 * 1024) throw new Error('工作簿超过 50 MB，请选择较小的文件。');
      await loadBuffer(await response.arrayBuffer(), 'server');
      state.handle = null;
    } catch (error) { showError(initial && error instanceof TypeError ? new Error('无法自动读取目录中的工作簿，请点击“选择工作簿”。') : error); }
    finally { setBusy(false); }
  }

  function selectLift(key, reveal) {
    if (!LIFT[key]) return;
    state.lift = key;
    state.trendIndex = null;
    document.querySelectorAll('.lift-tile, #lift-switch .chip').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.lift === key)));
    renderTrend();
    const card = $('progress'), rect = card.getBoundingClientRect();
    if (reveal && (rect.top > window.innerHeight * 0.55 || rect.bottom < 80)) card.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  }
  $('lift-tiles').addEventListener('click', event => { const tile = event.target.closest('[data-lift]'); if (tile) selectLift(tile.dataset.lift, true); });
  $('lift-switch').addEventListener('click', event => { const chip = event.target.closest('[data-lift]'); if (chip) selectLift(chip.dataset.lift, false); });
  $('metric-switch').addEventListener('click', event => {
    const button = event.target.closest('[data-metric]');
    if (!button) return;
    state.metric = button.dataset.metric;
    state.trendIndex = null;
    $('metric-switch').querySelectorAll('button').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
    renderTrend();
  });
  $('range-chips').addEventListener('click', event => {
    const button = event.target.closest('[data-range]');
    if (!button) return;
    state.range = button.dataset.range;
    Object.assign(state, { trendIndex: null, calendarDate: null, runWeek: null, logDays: 10 });
    $('range-chips').querySelectorAll('button').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
    renderTrend();
    renderCalendar();
    renderRunning();
    renderLog();
  });
  $('log-filter').addEventListener('click', event => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    state.logFilter = button.dataset.filter;
    state.logDays = 10;
    renderLogFilter();
    renderLog();
  });
  $('show-more').addEventListener('click', () => { state.logDays += 15; renderLog(); });
  document.addEventListener('click', event => { const link = event.target.closest('[data-goto]'); if (link) gotoDay(link.dataset.goto); });
  $('calendar').addEventListener('click', event => { const cell = event.target.closest('[data-date]'); if (cell) selectCalendarDate(cell.dataset.date, false); });
  $('calendar').addEventListener('keydown', event => {
    const shift = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }[event.key];
    if (!shift || !state.calendarDate) return;
    event.preventDefault();
    const next = isoDate(time(state.calendarDate) + shift * DAY);
    if (next >= view.calendarFirst && next <= localToday()) selectCalendarDate(next, true);
  });
  bindScrub($('trend-chart'), () => view.trendGeometry?.xs ?? [], () => state.trendIndex, index => { state.trendIndex = index; showTrendSelection(true); });
  bindScrub($('run-chart'), () => view.runXs, () => view.weeks.findIndex(item => item.week === state.runWeek), index => {
    if (view.weeks[index].week === state.runWeek) return;
    state.runWeek = view.weeks[index].week;
    drawRunChart();
    renderRunReadout();
  });

  // Charts are drawn at their real width, so redraw when the width changes.
  const widths = new Map();
  const redraw = target => { if (!state.loaded) return; if (target.id === 'trend-chart') drawTrend(); else drawRunChart(); };
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(entries => entries.forEach(entry => {
      const width = Math.round(entry.contentRect.width);
      if (widths.get(entry.target) === width) return;
      widths.set(entry.target, width);
      redraw(entry.target);
    }));
    observer.observe($('trend-chart'));
    observer.observe($('run-chart'));
  } else window.addEventListener('resize', () => { redraw($('trend-chart')); redraw($('run-chart')); });

  $('import').addEventListener('click', chooseFile);
  $('file-input').addEventListener('change', async event => {
    const file = event.target.files[0];
    if (!file) return;
    setBusy(true);
    try {
      if (file.size > 50 * 1024 * 1024) throw new Error('请选择 50 MB 以内的 XLSX 文件。');
      await loadBuffer(await file.arrayBuffer(), 'file');
      state.handle = null;
    } catch (error) { showError(error); }
    finally { event.target.value = ''; setBusy(false); }
  });
  $('refresh').addEventListener('click', async () => {
    if (state.busy) return;
    if (state.handle) {
      setBusy(true);
      try { await loadBuffer(await (await state.handle.getFile()).arrayBuffer(), 'handle'); }
      catch (error) { showError(new Error(`未能重新读取已选文件，请再次选择工作簿。${error.message ? `（${error.message}）` : ''}`)); }
      finally { setBusy(false); }
    } else if (state.source === 'server' || state.source === 'snapshot' || (!state.source && !fileMode)) await fetchWorkbook();
    else { setNotice('浏览器需要你再次选择文件，才能读取磁盘上的最新内容。'); await chooseFile(); }
  });

  if (snapshotMode) {
    $('chat-tip-text').innerHTML = '练完把训练发到 PowerLog 聊天，比如 <code>10.12 深蹲 160*5*3@8</code> 或 <code>10.12 跑步 10km 52:30</code>。助手写入 Excel 并重新发布后，点右上角刷新。';
  } else $('import').hidden = false;
  render();
  if (fileMode) {
    $('source-detail').textContent = '等待选择工作簿';
    setNotice('本地文件模式：点右上角“选择工作簿”读取 Excel，数据只在浏览器里读取。');
  } else fetchWorkbook(true);
})();
