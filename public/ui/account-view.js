// Account: identity, quota windows, credits, official usage. Only fields documented by
// account/read, account/rateLimits/read and account/usage/read are shown. Nothing is invented.
import { el, compact, integer, usd, localTime, relativeReset, windowLabel, UNKNOWN } from './format.js';
import { barChart } from './chart.js';
import { icon } from '../icons.js';

const AUTH = { chatgpt: 'ChatGPT 登录', apiKey: 'API Key', amazonBedrock: 'Amazon Bedrock' };
const PLAN = { free: 'Free', plus: 'Plus', pro: 'Pro', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu', unknown: '未知套餐' };

/** Quota buckets: the id map when present, otherwise the single fallback. Never both. */
export function quotaBuckets(result) {
  const map = result?.rateLimitsByLimitId;
  if (map && typeof map === 'object' && Object.keys(map).length) return Object.entries(map).slice(0, 20).map(([id, bucket]) => ({ id, ...bucket }));
  if (result?.rateLimits && typeof result.rateLimits === 'object') return [{ id: result.rateLimits.limitId || 'default', ...result.rateLimits }];
  return [];
}
/** Remaining is derived only as a percentage of its own window. */
export function windowView(window, now = Date.now()) {
  if (!window || typeof window !== 'object') return null;
  const used = typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent) ? Math.min(100, Math.max(0, window.usedPercent)) : null;
  return { used, remaining: used === null ? null : Math.max(0, 100 - used), label: windowLabel(window.windowDurationMins), reset: relativeReset(window.resetsAt, now), resetAt: typeof window.resetsAt === 'number' ? localTime(window.resetsAt * 1000) : UNKNOWN };
}
const micros = value => typeof value === 'number' && Number.isFinite(value) ? value / 1e6 : null;

export function mountAccount(host, { rpc, loginPanelHost, pendingHost, demo = () => false }) {
  const document = host.ownerDocument;
  let generation = 0, active = false;
  host.classList.add('account');
  const header = el(document, 'header', 'page-head');
  const titles = el(document, 'div', 'page-titles'); titles.append(el(document, 'h1', '', '账户'), el(document, 'p', 'page-sub', '本机 Codex 登录与额度'));
  const refresh = el(document, 'button', 'btn icon-only'); refresh.type = 'button'; refresh.setAttribute('aria-label', '刷新账户'); refresh.title = '刷新'; refresh.append(icon(document, 'refresh', { size: 16 }));
  refresh.addEventListener('click', () => load());
  const controls = el(document, 'div', 'page-controls'); controls.append(refresh);
  header.append(titles, controls);

  const identity = el(document, 'section', 'acct-identity');
  const quota = el(document, 'section', 'acct-quota');
  const usage = el(document, 'section', 'acct-usage');
  const manage = el(document, 'section', 'acct-manage');
  manage.append(el(document, 'h2', 'section-title', '登录管理'));
  if (pendingHost) manage.append(pendingHost);
  if (loginPanelHost) manage.append(loginPanelHost);
  const grid = el(document, 'div', 'acct-grid'); grid.append(identity, quota);
  host.replaceChildren(header, grid, usage, manage);

  const section = (node, title, ...children) => node.replaceChildren(el(document, 'h2', 'section-title', title), ...children);
  const fact = (label, value, mono = false) => { const row = el(document, 'div', 'fact'); row.append(el(document, 'span', 'fact-label', label), el(document, 'span', 'fact-value' + (mono ? ' mono' : ''), value)); return row; };
  const errorLine = (text, error) => el(document, 'p', 'inline-error', `${text}：${error?.message || error}`);

  function renderIdentity(result, error) {
    if (error) { section(identity, '身份', errorLine('无法读取账户', error)); return; }
    const account = result?.account;
    if (!account) { section(identity, '身份', el(document, 'p', 'empty-line', demo() ? '演示模式没有真实账户。' : result?.requiresOpenaiAuth ? '尚未登录。使用下方“登录管理”登录 ChatGPT。' : '服务没有返回账户信息。')); return; }
    const avatar = el(document, 'div', 'acct-avatar', (account.email || AUTH[account.type] || '?').trim().charAt(0).toUpperCase());
    const head = el(document, 'div', 'acct-head');
    const who = el(document, 'div', 'acct-who');
    who.append(el(document, 'strong', '', account.email || AUTH[account.type] || String(account.type || '未知')), el(document, 'span', 'acct-auth', AUTH[account.type] || String(account.type || '未知授权')));
    head.append(avatar, who);
    if (account.type === 'chatgpt') head.append(el(document, 'span', 'plan-badge', PLAN[account.planType] || String(account.planType || '未知套餐')));
    const facts = el(document, 'div', 'facts');
    facts.append(fact('授权方式', AUTH[account.type] || String(account.type)));
    if (account.type === 'chatgpt') facts.append(fact('套餐', PLAN[account.planType] || String(account.planType || UNKNOWN)));
    if (account.type === 'apiKey') facts.append(fact('密钥', '由本机 Codex 保管，不在此显示'));
    section(identity, '身份', head, facts);
  }

  function meter(view) {
    const node = el(document, 'div', 'quota-window');
    const top = el(document, 'div', 'quota-top');
    top.append(el(document, 'span', 'quota-name', view.label), el(document, 'strong', 'quota-left', view.remaining === null ? UNKNOWN : `剩余 ${Math.round(view.remaining)}%`));
    const bar = el(document, 'div', 'quota-bar'); bar.setAttribute('role', 'meter'); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100');
    if (view.used !== null) { bar.setAttribute('aria-valuenow', String(Math.round(view.used))); bar.setAttribute('aria-label', `${view.label}已用 ${Math.round(view.used)}%`); const fill = el(document, 'span'); fill.style.width = view.used + '%'; bar.append(fill); bar.dataset.level = view.used >= 90 ? 'high' : view.used >= 70 ? 'mid' : 'low'; }
    else bar.setAttribute('aria-label', `${view.label}用量未知`);
    const foot = el(document, 'div', 'quota-foot'); foot.append(el(document, 'span', '', view.used === null ? '已用未知' : `已用 ${Math.round(view.used)}%`), el(document, 'span', '', view.reset));
    foot.title = '重置时间 ' + view.resetAt;
    node.append(top, bar, foot); return node;
  }
  function renderQuota(result, error) {
    if (error) { section(quota, '额度', errorLine('无法读取额度', error)); return; }
    const buckets = quotaBuckets(result);
    const children = [];
    if (result?.ordinaryUsageAllowed === false) children.push(el(document, 'p', 'quota-alert', '服务当前不允许普通用量。'));
    if (!buckets.length) children.push(el(document, 'p', 'empty-line', '服务没有返回额度窗口。'));
    for (const bucket of buckets) {
      const group = el(document, 'div', 'quota-group');
      const head = el(document, 'div', 'quota-group-head'); head.append(el(document, 'strong', '', bucket.limitName || bucket.id || '额度'));
      if (bucket.planType) head.append(el(document, 'span', 'quota-plan', PLAN[bucket.planType] || bucket.planType));
      if (bucket.spendControlReached === true) head.append(el(document, 'span', 'quota-flag', '已达支出上限'));
      group.append(head);
      for (const key of ['primary', 'secondary']) { const view = windowView(bucket[key]); if (view) group.append(meter(view)); }
      const credits = bucket.credits;
      if (credits && typeof credits === 'object') {
        const text = credits.unlimited === true ? '无限额度' : credits.hasCredits === false ? '无可用 credits' : credits.balance != null ? `余额 ${String(credits.balance).slice(0, 40)}（服务 credits 单位）` : credits.hasCredits === true ? '有可用 credits（余额未提供）' : '';
        if (text) group.append(el(document, 'p', 'quota-credits', 'Credits · ' + text));
      }
      children.push(group);
    }
    section(quota, '额度', ...children);
  }

  function renderUsage(result, error) {
    if (error) { section(usage, '官方账户用量', errorLine('无法读取官方用量', error)); return; }
    const summary = result?.summary || result || {};
    const strip = el(document, 'div', 'usage-strip');
    const stat = (label, value) => { const cell = el(document, 'div', 'usage-stat'); cell.append(el(document, 'span', '', label), el(document, 'strong', '', value)); return cell; };
    strip.append(stat('累计 Tokens', compact(summary.lifetimeTokens)), stat('单日峰值', compact(summary.peakDailyTokens)), stat('最长回合', typeof summary.longestRunningTurnSec === 'number' ? `${integer(summary.longestRunningTurnSec)} 秒` : UNKNOWN), stat('连续使用', typeof summary.currentStreakDays === 'number' ? `${summary.currentStreakDays} 天（最长 ${integer(summary.longestStreakDays)}）` : UNKNOWN));
    const buckets = Array.isArray(result?.dailyUsageBuckets) ? result.dailyUsageBuckets.slice(-60) : [];
    const chart = el(document, 'div', 'chart-host compact');
    chart.append(barChart(document, buckets.map(row => ({ label: String(row.startDate || '').slice(5), value: typeof row.tokens === 'number' ? row.tokens : null, title: `${row.startDate} · ${compact(row.tokens)} tokens` })), { height: 140, emptyText: '服务没有返回每日用量' }));
    const children = [strip, chart];
    const thread = result?.threadUsage;
    if (thread) children.push(el(document, 'p', 'usage-thread', `当前对话估算 ${usd(micros(thread.estimatedUsageUsdMicros))} · ${compact(micros(thread.estimatedUsageCreditsMicros))} credits`));
    children.push(el(document, 'p', 'fine', '官方统计按服务日期汇总，与“用量与性能”中的本机观测相互独立，不相加。没有账单、余额或订阅到期信息时不显示。'));
    section(usage, '官方账户用量', ...children);
  }

  async function load() {
    if (!active) return;
    const mine = ++generation; refresh.disabled = true;
    const loading = text => el(document, 'p', 'empty-line', text);
    section(identity, '身份', loading('正在读取…')); section(quota, '额度', loading('正在读取…')); section(usage, '官方账户用量', loading('正在读取…'));
    const settle = async (promise, render) => { try { const result = await promise; if (mine === generation) render(result, null); } catch (error) { if (mine === generation) render(null, error); } };
    await Promise.all([
      settle(rpc('account/read', { refreshToken: false }), renderIdentity),
      settle(rpc('account/rateLimits/read', {}), renderQuota),
      settle(rpc('account/usage/read', {}), renderUsage),
    ]);
    if (mine === generation) refresh.disabled = false;
  }
  return { activate() { active = true; load(); }, deactivate() { active = false; generation++; refresh.disabled = false; }, refresh: load, reset() { generation++; for (const node of [identity, quota, usage]) node.replaceChildren(); } };
}
