// Codex-only projections. No persistence, network requests, price catalog or WB telemetry.
export const USAGE_UNKNOWN = '未知（服务未提供）';
export const safeUsageNumber = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const label = value => typeof value === 'string' && value.length ? value.slice(0, 300) : null;
const SUMMARY = ['lifetimeTokens','peakDailyTokens','longestRunningTurnSec','currentStreakDays','longestStreakDays'];
const TOKENS = ['totalTokens','inputTokens','cachedInputTokens','outputTokens','reasoningOutputTokens'];
const GROUP = ['estimatedUsageCreditsMicros','netNewInputTokens','cachedInputTokens','inputTokens','outputTokens','totalTokens'];
const pickNumbers = (obj, keys) => Object.fromEntries(keys.map(key => [key, safeUsageNumber(obj?.[key])]));
export function formatUsageNumber(value) { const n = safeUsageNumber(value); return n === null ? USAGE_UNKNOWN : n.toLocaleString('zh-CN'); }
export function formatUsageMicros(value, unit = 'USD') {
  const n = safeUsageNumber(value);
  // Decimal construction avoids floating-point rounding of integer micro units.
  return n === null ? USAGE_UNKNOWN : `${Math.floor(n / 1000000)}.${String(n % 1000000).padStart(6, '0')} ${unit}`;
}
export function normalizeOfficialUsageStatistics(response) {
  const buckets = Array.isArray(response?.dailyUsageBuckets) ? response.dailyUsageBuckets : null;
  const thread = response?.threadUsage;
  const groups = Array.isArray(thread?.groups) ? thread.groups : null;
  return {
    summary: pickNumbers(response?.summary, SUMMARY),
    // Keep server ordering/date strings, missing vs empty, duplicates and gaps. No fabricated dates.
    dailyUsageBuckets: buckets === null ? null : buckets.slice(0, 3660).map(row => ({startDate: label(row?.startDate), tokens: safeUsageNumber(row?.tokens)})),
    bucketsTruncated: buckets !== null && buckets.length > 3660,
    threadUsage: thread && typeof thread === 'object' ? {
      threadId: label(thread.threadId),
      estimatedUsageCreditsMicros: safeUsageNumber(thread.estimatedUsageCreditsMicros),
      estimatedUsageUsdMicros: safeUsageNumber(thread.estimatedUsageUsdMicros),
      groups: groups === null ? null : groups.slice(0, 500).map(row => ({
        model: label(row?.model), reasoningEffort: label(row?.reasoningEffort), speed: label(row?.speed), ...pickNumbers(row, GROUP)
      })),
      groupsTruncated: groups !== null && groups.length > 500
    } : null
  };
}
export function normalizeTokenUsageEvent(params) {
  if (typeof params?.threadId !== 'string' || !params.threadId || params.threadId.length > 300) return null;
  return {threadId: params.threadId, ...pickNumbers(params.tokenUsage?.total, TOKENS)};
}
export function createTokenUsageSnapshots() {
  const snapshots = new Map();
  return {
    update(params) {
      const snapshot = normalizeTokenUsageEvent(params);
      if (!snapshot) return null;
      // Backend total is authoritative even after rollback/reset. Never sum notifications or last.
      snapshots.set(snapshot.threadId, snapshot);
      return {...snapshot};
    },
    get(threadId) { const snapshot = snapshots.get(threadId); return snapshot ? {...snapshot} : null; },
    clear(threadId) { if (threadId === undefined) snapshots.clear(); else snapshots.delete(threadId); }
  };
}

export function mountOfficialUsageStatistics(container) {
  const doc = container.ownerDocument;
  let disposed = false;
  const make = (tag, text, className) => {
    const el = doc.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  const table = (title, headers, rows) => {
    const el = make('table', undefined, 'usage-statistics-table');
    el.append(make('caption', title));
    const head = make('thead'), tr = make('tr');
    for (const text of headers) { const th = make('th', text); th.setAttribute('scope', 'col'); tr.append(th); }
    head.append(tr); el.append(head);
    const body = make('tbody');
    for (const row of rows) {
      const line = make('tr');
      row.forEach((text, i) => { const cell = make(i === 0 ? 'th' : 'td', text); if (i === 0) cell.setAttribute('scope', 'row'); line.append(cell); });
      body.append(line);
    }
    el.append(body); return el;
  };
  function update(response, {loading = false, error = false, demo = false, tokenSnapshot = null, scope = 'all'} = {}) {
    if (disposed) return;
    container.replaceChildren();
    container.classList.add('usage-statistics');
    container.setAttribute('aria-busy', loading ? 'true' : 'false');
    const status = make('p', loading ? '正在读取 Codex 统计…' : error ? 'Codex 统计读取失败，请重试。' : demo ? '演示数据，不是真实账户统计。' : '来源：Codex 账户用量数据。', 'usage-statistics-status');
    status.setAttribute('role', 'status'); container.append(status);
    if (loading || error) return;
    const data = normalizeOfficialUsageStatistics(response);
    container.append(make('p', '本页仅展示官方接口数据，不与本地扫描统计相加。费用与积分为后端估算，非账单；未知值不计作零。日桶日期按服务原文显示，不代表连续或完整覆盖。', 'usage-statistics-note'));
    if (scope !== 'thread') {
    container.append(table('Codex 全局汇总', ['指标', '值'], [
      ['累计 tokens', formatUsageNumber(data.summary.lifetimeTokens)], ['单日峰值 tokens', formatUsageNumber(data.summary.peakDailyTokens)],
      ['最长任务时长（秒）', formatUsageNumber(data.summary.longestRunningTurnSec)], ['当前连续天数', formatUsageNumber(data.summary.currentStreakDays)], ['最长连续天数', formatUsageNumber(data.summary.longestStreakDays)]
    ]));
    if (data.dailyUsageBuckets === null) container.append(make('p', '日趋势：服务未提供数据。'));
    else if (!data.dailyUsageBuckets.length) container.append(make('p', '日趋势：没有返回日桶。'));
    else {
      const max = Math.max(0, ...data.dailyUsageBuckets.map(row => row.tokens ?? 0));
      const chart = table('日桶趋势（服务日期）', ['日期', 'Tokens', '相对趋势'], data.dailyUsageBuckets.map(row => [row.startDate ?? USAGE_UNKNOWN, formatUsageNumber(row.tokens), '']));
      const body = chart.children[2];
      data.dailyUsageBuckets.forEach((row, i) => {
        const cell = body.children[i].children[2];
        if (row.tokens === null) { cell.textContent = USAGE_UNKNOWN; return; }
        const bar = make('span', undefined, 'usage-statistics-bar');
        bar.setAttribute('aria-hidden', 'true');
        bar.style.display = 'block'; bar.style.height = '8px'; bar.style.borderRadius = '4px';
        bar.style.background = 'var(--accent, #6097ff)';
        bar.style.width = `${max > 0 ? row.tokens / max * 100 : 0}%`;
        cell.append(bar);
      });
      container.append(chart);
      if (data.bucketsTruncated) container.append(make('p', '仅显示前 3660 个日桶，未据此重新计算全局汇总。'));
    }
    }
    if (scope !== 'account') {
    const thread = data.threadUsage;
    if (thread) {
      container.append(table('当前会话估算（不是全账户按模型统计）', ['指标','值'], [
        ['会话 ID',thread.threadId ?? USAGE_UNKNOWN], ['估算积分',formatUsageMicros(thread.estimatedUsageCreditsMicros, '积分')], ['估算费用',formatUsageMicros(thread.estimatedUsageUsdMicros)]
      ]));
      if (thread.groups === null) container.append(make('p', '服务未提供当前会话模型分组。'));
      else if (!thread.groups.length) container.append(make('p', '当前会话未返回模型分组。'));
      else container.append(table('当前会话模型分组（后端原始分组，不合并档位）', ['模型','思考强度','速度','输入','新增输入','缓存输入','输出','总 tokens','估算积分'], thread.groups.map(row => [
        row.model ?? USAGE_UNKNOWN, row.reasoningEffort ?? '默认 / 未提供', row.speed ?? USAGE_UNKNOWN,
        ...['inputTokens','netNewInputTokens','cachedInputTokens','outputTokens','totalTokens'].map(key => formatUsageNumber(row[key])), formatUsageMicros(row.estimatedUsageCreditsMicros,'积分')
      ])));
      if (thread.groupsTruncated) container.append(make('p', '仅显示前 500 个会话模型分组。'));
    } else container.append(make('p', '服务未提供当前会话估算。'));
    // Only a selected thread snapshot belongs here; never aggregate different threads/accounts.
    if (tokenSnapshot?.threadId && (!thread?.threadId || tokenSnapshot.threadId === thread.threadId)) {
      container.append(table('当前会话实时累计快照（不与以上统计相加）', ['指标','值'], [
        ['会话 ID',label(tokenSnapshot.threadId) ?? USAGE_UNKNOWN],
        ...[['totalTokens','总 tokens'],['inputTokens','输入'],['cachedInputTokens','缓存输入（已包含于输入）'],['outputTokens','输出'],['reasoningOutputTokens','推理输出（已包含于输出）']].map(([key,title]) => [title,formatUsageNumber(tokenSnapshot[key])])
      ]));
    }
    }
  }
  update(undefined);
  return {update, reset() { update(undefined); }, destroy() { disposed = true; container.replaceChildren(); }};
}
