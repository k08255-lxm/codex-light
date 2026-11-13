// Usage & performance analytics. Strictly follows STATISTICS-CONTRACT: POST /api/statistics/query|import.
// Light (observed by this app) and Local (imported Codex logs) are separate scopes and never summed.
import { el, compact, integer, percent, usd, seconds, rate, localTime, UNKNOWN } from './format.js';
import { barChart } from './chart.js';
import { icon } from '../icons.js';

const METRICS = {
  tokens: { label: 'Tokens', value: row => row.totalTokens, format: compact },
  output: { label: '输出 Tokens', value: row => row.outputTokens, format: compact },
  turns: { label: '回合', value: row => row.turnCount, format: integer },
  cost: { label: '估算成本', value: row => row.estimatedCost?.usd ?? null, format: usd },
};
const RANGES = [['24h', '24 小时', 24 * 3600e3, 'hour'], ['7d', '7 天', 7 * 86400e3, 'day'], ['30d', '30 天', 30 * 86400e3, 'day'], ['all', '全部', null, 'day']];
const STATUS = { completed: '完成', failed: '失败', interrupted: '已停止', inProgress: '进行中', unknown: '未知' };

/**
 * Builds a query body from UI state. `to` is exclusive; `from` inclusive (contract).
 * The time window is anchored at `ui.anchor` (fixed per fresh query) because backend cursors
 * are bound to the exact filters: every page of one query must send identical from/to.
 */
export function statisticsQuery(ui, now = ui.anchor ?? Date.now()) {
  const range = RANGES.find(row => row[0] === ui.range) || RANGES[2];
  const body = { scope: ui.scope === 'local' ? 'local' : 'light', bucket: range[3], limit: 30 };
  if (range[2]) { body.from = new Date(now - range[2]).toISOString(); body.to = new Date(now + 60e3).toISOString(); }
  if (ui.model) body.model = ui.model;
  if (ui.provider) body.provider = ui.provider;
  if (ui.cursor) body.cursor = ui.cursor;
  return body;
}

/** Short description of how much of the cost is actually priced. */
export function costCoverage(cost) {
  if (!cost || typeof cost.totalRows !== 'number') return '价格覆盖未知';
  if (!cost.totalRows) return '无可计价记录';
  return `已计价 ${cost.pricedRows} · 未计价 ${cost.unpricedRows??cost.totalRows-cost.pricedRows}${cost.complete?'':' · 部分估算'}`;
}

export function mountStatistics(host, { api, notice = () => {}, onPickFolder = null }) {
  const document = host.ownerDocument;
  const ui = { scope: 'light', range: '30d', metric: 'tokens', tab: 'details', model: '', provider: '', cursor: null, history: [], sort: null, anchor: null };
  let data = null, dataBucket='day', loading = false, generation = 0, active = false, importing = false, discovered = false, localImported = false, importingPrices=false;

  host.classList.add('stats');
  const header = el(document, 'header', 'page-head');
  const titles = el(document, 'div', 'page-titles');
  titles.append(el(document, 'h1', '', '用量与性能'), el(document, 'p', 'page-sub', ''));
  const controls = el(document, 'div', 'page-controls');
  const scope = segmented([['light', '本应用观测'], ['local', 'Codex 日志']], ui.scope, value => {
    ui.scope = value; ui.model = ''; ui.provider = ''; resetPaging();
    if (value === 'local' && !localImported) discoverAndImport(); else load();
  });
  const range = segmented(RANGES.map(row => [row[0], row[1]]), ui.range, value => { ui.range = value; resetPaging(); load(); });
  const refresh = el(document, 'button', 'btn icon-only'); refresh.type = 'button'; refresh.title = '刷新'; refresh.setAttribute('aria-label', '刷新统计'); refresh.append(icon(document, 'refresh', { size: 16 }));
  refresh.addEventListener('click', () => { resetPaging(); if (ui.scope === 'local' && importInput.value.trim()) importDirectory(); else load(); });
  const priceImport=el(document,'button','btn small','导入 models.dev 价格');priceImport.type='button';priceImport.title='显式获取公共参考单价，不发送对话或账户信息';
  priceImport.addEventListener('click',async()=>{
    if(importingPrices)return;importingPrices=true;priceImport.disabled=true;priceImport.setAttribute('aria-busy','true');
    try{const result=await api('/api/pricing/refresh',{});resetPaging();await load();setStatus(`已导入 ${integer(result.modelCount)} 个模型的参考价格；按供应商与模型精确匹配，手工价格优先。`);}
    catch(error){setStatus('价格导入失败：'+error.message,true);}
    finally{importingPrices=false;priceImport.disabled=false;priceImport.removeAttribute('aria-busy');}
  });
  controls.append(scope.node, range.node, priceImport, refresh);
  header.append(titles, controls);

  const importBar = el(document, 'form', 'import-bar hidden');
  const importInput = el(document, 'input'); importInput.placeholder = '选择或输入 Codex sessions 目录，例如 C:\\Users\\you\\.codex\\sessions'; importInput.setAttribute('aria-label', '日志目录');
  const importPick = el(document, 'button', 'btn', '选择文件夹…'); importPick.type = 'button';
  const importGo = el(document, 'button', 'btn primary', '导入'); importGo.type = 'submit';
  importBar.append(icon(document, 'folder', { size: 16 }), importInput, importPick, importGo);
  importPick.hidden = !onPickFolder;
  importPick.addEventListener('click', async () => { try { const path = await onPickFolder(); if (path) { importInput.value = path; await importDirectory(); } } catch (error) { setStatus(error.message, true); } });
  importBar.addEventListener('submit', event => { event.preventDefault(); importDirectory(); });
  async function discoverAndImport() {
    importBar.classList.remove('hidden');
    if (!discovered && !importInput.value.trim()) {
      setStatus('正在查找 Codex 日志…');
      try {
        const result = await api('/api/statistics/directories', {});
        discovered = true;
        if (!importInput.value.trim() && result.directory) importInput.value = result.directory;
      } catch (error) { setStatus('查找失败：' + error.message, true); return; }
    }
    if (!active || ui.scope !== 'local') return;
    if (importInput.value.trim()) await importDirectory();
    else { await load(); setStatus('未找到 Codex 日志，请选择 sessions 目录。'); }
  }
  async function importDirectory() {
    const directory = importInput.value.trim(); if (!directory || importing) return;
    const mine = ++generation;
    importing = true; loading = true; importGo.disabled = true; importPick.disabled = true; importInput.disabled = true; refresh.disabled = true;
    host.setAttribute('aria-busy', 'true'); setStatus('正在读取 Codex 日志…');
    try {
      const result = await api('/api/statistics/import', { directory });
      localImported = true;
      if (mine !== generation || !active) return;
      ui.scope = 'local'; ui.range = 'all'; ui.model = ''; ui.provider = ''; ui.sort = null;
      scope.set('local'); range.set('all'); resetPaging();
      // Show the actual imported snapshot, without stale filters hiding the result.
      data = result.statistics;dataBucket='day'; render();
      const total = data?.details?.total || 0;
      setStatus(total ? `已读取 ${integer(result.scan?.filesRead)} 份日志，导入 ${integer(total)} 条记录${result.scan?.partial?'；部分日志未计入':''}。` : '日志中没有可确认的回合或用量记录。');
    }
    catch (error) { if (mine === generation && active) setStatus('导入失败：' + error.message, true); }
    finally {
      importing = false; importGo.disabled = false; importPick.disabled = false; importInput.disabled = false;
      if (mine === generation) { loading = false; refresh.disabled = false; host.removeAttribute('aria-busy'); renderPager(); }
    }
  }

  const status = el(document, 'p', 'page-status'); status.setAttribute('role', 'status');status.style.minHeight='1.5em';
  const overview = el(document, 'section', 'stats-overview');
  const kpis = el(document, 'div', 'kpi-row'); kpis.setAttribute('role', 'tablist'); kpis.setAttribute('aria-label', '图表指标');
  const chartBox = el(document, 'div', 'chart-box');
  const chartHead = el(document, 'div', 'chart-head');
  const chartTitle = el(document, 'strong', 'chart-title');
  const chartNote = el(document, 'span', 'chart-note');
  chartHead.append(chartTitle, chartNote);
  const chartHost = el(document, 'div', 'chart-host');
  chartBox.append(chartHead, chartHost);
  overview.append(kpis, chartBox);

  const perf = el(document, 'section', 'perf-strip'); perf.setAttribute('aria-label', '性能');

  const table = el(document, 'section', 'stats-table');
  const tabs = el(document, 'div', 'table-tabs'); tabs.setAttribute('role', 'tablist');
  const filters = el(document, 'div', 'table-filters');
  const modelFilter = el(document, 'select'); modelFilter.setAttribute('aria-label', '按模型筛选');
  const providerFilter = el(document, 'select'); providerFilter.setAttribute('aria-label', '按供应商筛选');
  modelFilter.addEventListener('change', () => { ui.model = modelFilter.value; resetPaging(); load(); });
  providerFilter.addEventListener('change', () => { ui.provider = providerFilter.value; resetPaging(); load(); });
  filters.append(icon(document, 'search', { size: 14 }), providerFilter, modelFilter);
  const tableHead = el(document, 'div', 'table-head'); tableHead.append(tabs, filters);
  const scroller = el(document, 'div', 'table-scroll');
  const pager = el(document, 'div', 'table-pager');
  table.append(tableHead, scroller, pager);

  const scopeNote = el(document, 'details', 'scope-note');
  const scopeSummary = el(document, 'summary', '', '数据口径');
  const scopeBody = el(document, 'div', 'scope-body');
  scopeNote.append(scopeSummary, scopeBody);

  host.replaceChildren(header, importBar, status, overview, perf, table, scopeNote);

  function segmented(options, value, onChange) {
    const node = el(document, 'div', 'segmented'); node.setAttribute('role', 'radiogroup');
    const buttons = options.map(([key, label]) => {
      const button = el(document, 'button', '', label); button.type = 'button'; button.dataset.value = key; button.setAttribute('role', 'radio');
      button.addEventListener('click', () => { if (importing || button.getAttribute('aria-checked') === 'true') return; set(key); onChange(key); });
      node.append(button); return button;
    });
    const set = key => { for (const button of buttons) button.setAttribute('aria-checked', String(button.dataset.value === key)); };
    set(value); return { node, set };
  }
  function setStatus(text, error = false) { status.textContent = text; status.classList.toggle('error', error);status.hidden=false; }
  // A fresh query: new time anchor, first page. Paging keeps both.
  function resetPaging() { ui.cursor = null; ui.history = []; ui.anchor = null; }

  async function load() {
    if (!active || importing) return;
    const mine = ++generation; loading = true; refresh.disabled = true; host.setAttribute('aria-busy', 'true');
    if (ui.anchor === null) ui.anchor = Date.now();
    renderPager();
    importBar.classList.toggle('hidden', ui.scope !== 'local');
    refresh.setAttribute('aria-label','正在更新统计');if(!data)setStatus('正在读取…');
    try {
      const query=statisticsQuery(ui);const result = await api('/api/statistics/query', query);
      if (mine !== generation) return;
      loading = false; data = result;dataBucket=query.bucket; setStatus(''); render();
    } catch (error) {
      if (mine !== generation) return;
      loading = false; setStatus('统计读取失败：' + error.message, true); render();
    } finally { if (mine === generation) { loading = false; refresh.disabled = false;refresh.setAttribute('aria-label','刷新统计'); host.removeAttribute('aria-busy'); renderPager(); } }
  }

  function render() {
    const totals = data?.totals || null;
    titles.querySelector('.page-sub').textContent = data ? `${ui.scope === 'local' ? '导入日志' : '本应用观测'} · ${localTime(data.generatedAt)} 更新` : '';
    renderKpis(totals); renderChart(); renderPerf(totals); renderTable(); renderScope();
    importBar.classList.toggle('hidden', ui.scope !== 'local');
  }

  function kpi(key, label, value, sub, help) {
    const button = el(document, 'button', 'kpi'); button.type = 'button'; button.setAttribute('role', 'tab');
    const selectable = Object.hasOwn(METRICS, key);
    button.disabled = !selectable; button.setAttribute('aria-selected', String(ui.metric === key));
    button.append(el(document, 'span', 'kpi-label', label), el(document, 'strong', 'kpi-value', value), el(document, 'span', 'kpi-sub', sub || ''));
    if (help) button.title = help;
    if (selectable) button.addEventListener('click', () => { ui.metric = key; renderKpis(data?.totals); renderChart(); });
    return button;
  }
  function renderKpis(t) {
    if (!t) { kpis.replaceChildren(kpi('tokens', 'Tokens', UNKNOWN), kpi('turns', '回合', UNKNOWN), kpi('cost', '估算成本', UNKNOWN), kpi('cache', '缓存命中', UNKNOWN)); return; }
    const io = `输入 ${compact(t.inputTokens)} · 输出 ${compact(t.outputTokens)}`;
    kpis.replaceChildren(
      kpi('tokens', 'Tokens', compact(t.totalTokens), io, '总 tokens（输入含缓存 + 输出）'),
      kpi('turns', '回合', integer(t.turnCount), `${integer(t.submissionCount)} 次提交 · 成功 ${percent(t.successRate)}`, '观测到的回合与提交（包括立即补充）；上游 API 请求次数不公开'),
      kpi('cost', '估算总成本', usd(t.estimatedCost?.usd), costCoverage(t.estimatedCost), '当前筛选范围已计价记录之和；未计价项不作零，非账单或实际扣款'),
      kpi('cache', '缓存命中', percent(t.cacheHitRate), `缓存 ${compact(t.cachedInputTokens)} / 输入 ${compact(t.inputTokens)}`, '缓存输入 ÷ 输入'),
    );
  }
  function bucketLabel(iso) { const hour = dataBucket === 'hour'; return localTime(iso, { date: !hour, time: hour }); }
  function renderChart() {
    const metric = METRICS[ui.metric] || METRICS.tokens;
    const trend = Array.isArray(data?.trend) ? data.trend : [];
    chartTitle.textContent = `${metric.label} · ${dataBucket === 'hour' ? '按小时' : '按天'}`;
    chartNote.textContent = trend.length ? `${trend.length} 个有数据的时间段（无数据的时段不补零）` : '';
    chartHost.style.minHeight='200px';chartHost.firstElementChild?.dispose?.();
    chartHost.replaceChildren(barChart(document, trend.map(row => ({ label: bucketLabel(row.start), value: metric.value(row), title: `${localTime(row.start)} · ${metric.format(metric.value(row))} · ${integer(row.turnCount)} 回合` })), { format: metric.format }));
  }
  function perfCell(label, stat, format, help) {
    const cell = el(document, 'div', 'perf-cell'); cell.title = help;
    const values = el(document, 'div', 'perf-values');
    values.append(el(document, 'strong', '', stat?.count ? format(stat.p50) : UNKNOWN), el(document, 'span', '', stat?.count ? `p95 ${format(stat.p95)}` : '无样本'));
    cell.append(el(document, 'span', 'perf-label', label), values, el(document, 'span', 'perf-n', stat?.count ? `n=${integer(stat.count)}` : ''));
    return cell;
  }
  function renderPerf(t) {
    const p = t?.performance;
    const outcome = el(document, 'div', 'perf-cell perf-outcome');
    const bar = el(document, 'div', 'outcome-bar'); bar.setAttribute('role', 'img');
    const parts = [['ok', t?.completedCount, '完成'], ['stop', t?.interruptedCount, '已停止'], ['fail', t?.failedCount, '失败']];
    const total = parts.reduce((sum, [, n]) => sum + (Number.isFinite(n) ? n : 0), 0);
    for (const [kind, n] of parts) if (n > 0) { const seg = el(document, 'span', 'seg-' + kind); seg.style.flexGrow = String(n); bar.append(seg); }
    bar.setAttribute('aria-label', parts.map(([, n, label]) => `${label} ${integer(n)}`).join('，'));
    const legend = el(document, 'div', 'outcome-legend');
    for (const [kind, n, label] of parts) { const item = el(document, 'span', 'leg-' + kind, `${label} ${integer(n)}`); legend.append(item); }
    outcome.append(el(document, 'span', 'perf-label', '回合结果'), total ? bar : el(document, 'span', 'perf-empty', '无已结束回合'), legend);
    perf.replaceChildren(
      perfCell('首次可见输出等待', p?.firstTextLatencyMs, seconds, '从回合开始到第一段可见文本；包含思考与工具时间，不是 API 首 token 延迟'),
      perfCell('回合总耗时', p?.durationMs, seconds, '原生回合时长或观测的开始到结束；包含工具与等待'),
      perfCell('回合平均输出', p?.turnOutputTokensPerSecond, value => rate(value, 'tok/s'), '已完成回合的输出 tokens ÷ 整轮耗时（含思考、工具与等待），不是纯模型生成速度'),
      outcome,
    );
  }

  const DETAIL_COLUMNS = [
    ['time', '时间', row => localTime(row.timestamp || row.completedAt || row.startedAt), row => Date.parse(row.timestamp || row.completedAt || row.startedAt || '') || 0],
    ['model', '模型', row => row.model || '未知模型', row => row.model || ''],
    ['provider', '供应商', row => row.provider || '未知', row => row.provider || ''],
    ['status', '结果', row => STATUS[row.status] || row.status, row => row.status || ''],
    ['input', '输入', row => compact(row.tokens?.inputTokens), row => row.tokens?.inputTokens ?? -1, 'num'],
    ['cached', '缓存', row => compact(row.tokens?.cachedInputTokens), row => row.tokens?.cachedInputTokens ?? -1, 'num'],
    ['output', '输出', row => compact(row.tokens?.outputTokens), row => row.tokens?.outputTokens ?? -1, 'num'],
    ['cost', '估算', row => usd(row.estimatedCost?.usd), row => row.estimatedCost?.usd ?? -1, 'num'],
    ['first', '首次输出', row => seconds(row.performance?.firstTextLatencyMs), row => row.performance?.firstTextLatencyMs ?? -1, 'num'],
    ['duration', '耗时', row => seconds(row.performance?.durationMs), row => row.performance?.durationMs ?? -1, 'num'],
    ['speed', '回合 tok/s', row => rate(row.performance?.turnOutputTokensPerSecond, 'tok/s'), row => row.performance?.turnOutputTokensPerSecond ?? -1, 'num'],
  ];
  const GROUP_COLUMNS = [
    ['turns', '回合', row => integer(row.turnCount), row => row.turnCount ?? -1, 'num'],
    ['tokens', 'Tokens', row => compact(row.totalTokens), row => row.totalTokens ?? -1, 'num'],
    ['input', '输入', row => compact(row.inputTokens), row => row.inputTokens ?? -1, 'num'],
    ['output', '输出', row => compact(row.outputTokens), row => row.outputTokens ?? -1, 'num'],
    ['cache', '缓存命中', row => percent(row.cacheHitRate), row => row.cacheHitRate ?? -1, 'num'],
    ['cost', '估算成本', row => usd(row.estimatedCost?.usd), row => row.estimatedCost?.usd ?? -1, 'num'],
    ['success', '成功率', row => percent(row.successRate), row => row.successRate ?? -1, 'num'],
    ['p50', '耗时 p50', row => seconds(row.performance?.durationMs?.p50), row => row.performance?.durationMs?.p50 ?? -1, 'num'],
    ['tps', '回合 tok/s p50', row => rate(row.performance?.turnOutputTokensPerSecond?.p50, 'tok/s'), row => row.performance?.turnOutputTokensPerSecond?.p50 ?? -1, 'num'],
  ];
  function renderTabs() {
    const counts = { details: data?.details?.total, models: data?.models?.length, providers: data?.providers?.length };
    tabs.replaceChildren(...[['details', '明细'], ['models', '模型'], ['providers', '供应商']].map(([key, label]) => {
      const tab = el(document, 'button', 'tab'); tab.type = 'button'; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(ui.tab === key));
      tab.append(el(document, 'span', '', label), el(document, 'span', 'count', Number.isFinite(counts[key]) ? integer(counts[key]) : ''));
      tab.addEventListener('click', () => { ui.tab = key; ui.sort = null; renderTable(); });
      return tab;
    }));
    const option = (label, value) => { const node = el(document, 'option', '', label); node.value = value; return node; };
    const options = (select, rows, key, current, all) => {
      const names = [...new Set((rows || []).map(row => row[key]).filter(value => typeof value === 'string'))];
      select.replaceChildren(option(all, ''), ...names.map(name => option(name, name)));
      if (current && !names.includes(current)) select.append(option(current, current));
      select.value = current;
    };
    options(modelFilter, data?.models, 'model', ui.model, '全部模型');
    options(providerFilter, data?.providers, 'provider', ui.provider, '全部供应商');
  }
  function renderTable() {
    renderTabs();
    const detail = ui.tab === 'details';
    const columns = detail ? DETAIL_COLUMNS : [[ui.tab === 'models' ? 'model' : 'provider', ui.tab === 'models' ? '模型' : '供应商', row => row[ui.tab === 'models' ? 'model' : 'provider'] || '未知', row => row[ui.tab === 'models' ? 'model' : 'provider'] || ''], ...GROUP_COLUMNS];
    let rows = detail ? data?.details?.data || [] : (ui.tab === 'models' ? data?.models : data?.providers) || [];
    if (ui.sort) { const column = columns.find(c => c[0] === ui.sort.key); if (column) rows = [...rows].sort((a, b) => { const x = column[3](a), y = column[3](b); return (x > y ? 1 : x < y ? -1 : 0) * ui.sort.dir; }); }
    const tableNode = el(document, 'table', 'data-table');
    const head = el(document, 'thead'); const tr = el(document, 'tr');
    for (const [key, label, , , kind] of columns) {
      const th = el(document, 'th', kind || ''); th.scope = 'col';
      const button = el(document, 'button', 'sort', label); button.type = 'button';
      const dir = ui.sort?.key === key ? ui.sort.dir : 0;
      th.setAttribute('aria-sort', dir === 1 ? 'ascending' : dir === -1 ? 'descending' : 'none');
      button.addEventListener('click', () => { ui.sort = { key, dir: ui.sort?.key === key ? -ui.sort.dir : kind === 'num' ? -1 : 1 }; renderTable(); });
      th.append(button); tr.append(th);
    }
    head.append(tr);
    const body = el(document, 'tbody');
    for (const row of rows) {
      const line = el(document, 'tr');
      if (row.status) line.dataset.status = row.status;
      for (const [key, , text, , kind] of columns) {
        const td = el(document, 'td', [kind, key === 'model' ? 'mono' : ''].filter(Boolean).join(' '), text(row));
        if(detail&&key==='cost'){
          const cost=row.estimatedCost,details=el(document,'details'),summary=el(document,'summary','',cost?.usd===null?'未计价':usd(cost?.usd));summary.title='展开该回合参考成本分项；不是底层每次模型 API 请求成本';details.append(summary);
          const labels={input:'未缓存输入',cacheRead:'缓存读取',cacheWrite:'缓存写入',output:'输出',reasoning:'推理输出'};
          for(const part of cost?.components||[])details.append(el(document,'p','',`${labels[part.kind]||part.kind}：${compact(part.tokens)} tokens × ${usd(part.pricePerMillion)} / 百万 = ${usd(part.usd)}`));
          if(cost?.usd!==null&&!cost?.complete)details.append(el(document,'p','','仅估算已观测的 Token 片段，可能不是完整回合成本。'));
          if(cost?.reason)details.append(el(document,'p','',cost.reason));td.replaceChildren(details);
        }
        line.append(td);
      }
      body.append(line);
    }
    tableNode.append(head, body);
    scroller.replaceChildren(rows.length ? tableNode : el(document, 'p', 'table-empty', data ? '没有符合条件的记录' : '尚未读取'));
    renderPager();
  }
  function renderPager() {
    pager.replaceChildren();
    if (ui.tab !== 'details' || !data) return;
    const prev = el(document, 'button', 'btn', '上一页'); prev.type = 'button'; prev.disabled = !ui.history.length || loading;
    const next = el(document, 'button', 'btn', '下一页'); next.type = 'button'; next.disabled = !data.details?.nextCursor || loading;
    prev.addEventListener('click', () => { if (loading) return; ui.cursor = ui.history.pop() || null; load(); });
    next.addEventListener('click', () => { if (loading || !data.details?.nextCursor) return; ui.history.push(ui.cursor); ui.cursor = data.details.nextCursor; load(); });
    pager.append(el(document, 'span', '', `第 ${ui.history.length + 1} 页 · 共 ${integer(data.details?.total)} 条`), prev, next);
  }
  function renderScope() {
    const c = data?.coverage; const pricing = data?.pricing;
    const lines = [];
    lines.push(ui.scope === 'local' ? '导入日志：来自你选择的 Codex sessions 目录中的元数据与累计 token 差值；不包含首字延迟或流速。' : '本应用观测：只包括本窗口实际看到的回合；一个回合可能包含多次模型调用。');
    lines.push('两个范围可能重叠，界面不会相加。官方账户用量见“账户”。');
    lines.push('“首次可见输出等待”包含思考与工具时间，不是 API 首 token。“回合平均输出 tok/s”= 已完成回合输出 tokens ÷ 整轮耗时（含思考、工具与等待），不是纯模型生成速度；当前协议不提供纯推理耗时，因此纯生成速度与 TTFT 不显示。');
    if (pricing) lines.push(`价格：${pricing.available ? `${pricing.source || '参考价格'}${pricing.fetchedAt ? '，' + localTime(pricing.fetchedAt) + ' 获取' : ''}` : '未获取参考价格，成本不可估算'}。估算不是账单。`);
    if (c?.partial) lines.push('覆盖不完整：部分记录被排除或截断。');
    if(Number.isFinite(c?.knownModelRows))lines.push(`模型已确认 ${integer(c.knownModelRows)} 条，未知 ${integer(c.unknownModelRows)} 条。历史未知仅按相同对话与回合的日志上下文恢复，不套用当前默认模型。`);
    if (c?.excludedOverlappingThreads || c?.excludedAmbiguousSessions) lines.push(`Token 归属暂缓：重叠对话 ${integer(c.excludedOverlappingThreads)}，歧义会话 ${integer(c.excludedAmbiguousSessions)}；可确认的回合仍保留。`);
    if (data?.dsh && data.dsh.available === false) lines.push('DSH 子代理：' + (data.dsh.reason || '暂无可验证的用量数据'));
    for (const note of Array.isArray(c?.notes) ? c.notes.slice(0, 6) : []) lines.push(String(note));
    if (c?.persistenceWarning) lines.push(String(c.persistenceWarning));
    scopeBody.replaceChildren(...lines.map(line => el(document, 'p', '', line)));
    scopeSummary.textContent = c?.partial ? '数据口径 · 部分覆盖' : '数据口径';
  }

  render();
  return {
    activate() { active = true; if (ui.scope === 'local' && !localImported) discoverAndImport(); else load(); },
    deactivate() { active = false; generation++; loading = false; },
    reset() { data = null; resetPaging(); render(); },
  };
}
