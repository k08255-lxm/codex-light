// Account: identity, quota windows, credits, official usage. Only fields documented by
// account/read, account/rateLimits/read and account/usage/read are shown. Nothing is invented.
import { el, compact, integer, usd, localTime, UNKNOWN } from './format.js';
import { barChart } from './chart.js';
import { icon } from '../icons.js';
import { quotaBuckets, windowView } from '../account-quota.js';
export { quotaBuckets, windowView } from '../account-quota.js';

const AUTH = { chatgpt: 'ChatGPT 登录', apiKey: 'API Key', amazonBedrock: 'Amazon Bedrock' };
const PLAN = { free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', prolite: 'Pro Lite', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu', edu_plus: 'Edu Plus', edu_pro: 'Edu Pro', unknown: '未知套餐' };
const micros = value => typeof value === 'number' && Number.isFinite(value) ? value / 1e6 : null;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const decimal = value => finite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 6 }) : UNKNOWN;
const RESET_STATUS = { available: '可用', redeeming: '处理中', redeemed: '已使用', unknown: '状态未知' };
const REACHED = { rate_limit_reached: '已达使用限额', workspace_owner_credits_depleted: '工作区额度已耗尽', workspace_member_credits_depleted: '成员额度已耗尽', workspace_owner_usage_limit_reached: '已达工作区用量上限', workspace_member_usage_limit_reached: '已达成员用量上限' };

export function mountAccount(host, { rpc, loginPanelHost, pendingHost, demo = () => false, getThreadId = () => null, onQuota = () => {} }) {
  const document = host.ownerDocument;
  let generation = 0, accountEpoch = 0, active = false, quotaResult = null, attempt = null, selectedCredit = null, bucketId = null, usageTab = 'overview';
  let loadTask = null, creditSignature = null;
  const rendered = new Map();
  host.classList.add('account');
  const header = el(document, 'header', 'page-head');
  const titles = el(document, 'div', 'page-titles'); titles.append(el(document, 'h1', '', '账户'), el(document, 'p', 'page-sub', '本机 Codex 登录与额度'));
  const refresh = el(document, 'button', 'btn icon-only acct-refresh'); refresh.type = 'button'; refresh.setAttribute('aria-label', '刷新账户'); refresh.title = '刷新'; refresh.append(icon(document, 'refresh', { size: 16 }));
  refresh.addEventListener('click', () => load());
  const controls = el(document, 'div', 'page-controls'); controls.append(refresh);
  header.append(titles, controls);

  const identity = el(document, 'section', 'acct-identity');
  const quota = el(document, 'section', 'acct-quota');
  const usage = el(document, 'section', 'acct-usage');
  const resetCredits = el(document, 'section', 'acct-reset-credits'); resetCredits.hidden = true;
  const manage = el(document, 'section', 'acct-manage');
  manage.append(el(document, 'h2', 'section-title', '登录管理'));
  if (pendingHost) manage.append(pendingHost);
  if (loginPanelHost) manage.append(loginPanelHost);
  const grid = el(document, 'div', 'acct-grid'); grid.append(identity, quota);
  host.replaceChildren(header, grid, resetCredits, usage, manage);

  const section = (node, title, ...children) => {
    const focusKey = node.contains(document.activeElement) ? document.activeElement?.dataset.focusKey : null;
    const open = new Map([...node.querySelectorAll('details')].map(detail => [detail.dataset.stateKey, detail.open]));
    node.replaceChildren(el(document, 'h2', 'section-title', title), ...children);
    for (const detail of node.querySelectorAll('details')) if (open.has(detail.dataset.stateKey)) detail.open = open.get(detail.dataset.stateKey);
    if (focusKey) [...node.querySelectorAll('[data-focus-key]')].find(item => item.dataset.focusKey === focusKey)?.focus({ preventScroll: true });
  };
  const fact = (label, value, mono = false) => { const row = el(document, 'div', 'fact'); row.append(el(document, 'span', 'fact-label', label), el(document, 'span', 'fact-value' + (mono ? ' mono' : ''), value)); return row; };
  const errorLine = (text, error) => el(document, 'p', 'inline-error', `${text}：${error?.message || error}`);

  function renderIdentity(result, error) {
    if (error) { section(identity, '身份', errorLine('无法读取账户', error)); return; }
    const account = result?.account;
    if (!account) { section(identity, '身份', el(document, 'p', 'empty-line', demo() ? '演示模式没有真实账户。' : result?.requiresOpenaiAuth ? '尚未登录。使用下方“登录管理”登录 ChatGPT。' : '服务没有返回账户信息。')); return; }
    const avatar = el(document, 'div', 'acct-avatar', (account.email || AUTH[account.type] || '?').trim().charAt(0).toUpperCase());
    const head = el(document, 'div', 'acct-head');
    const who = el(document, 'div', 'acct-who');
    const name = el(document, 'strong', '', account.email || AUTH[account.type] || String(account.type || '未知')); name.title = name.textContent;
    who.append(name, el(document, 'span', 'acct-auth', AUTH[account.type] || String(account.type || '未知授权')));
    head.append(avatar, who);
    if (account.type === 'chatgpt') head.append(el(document, 'span', 'plan-badge', PLAN[account.planType] || String(account.planType || '未知套餐')));
    const facts = el(document, 'div', 'facts');
    facts.append(fact('授权方式', AUTH[account.type] || String(account.type)));
    if (account.type === 'chatgpt') facts.append(fact('套餐', PLAN[account.planType] || String(account.planType || UNKNOWN)));
    if (account.type === 'amazonBedrock' && typeof account.usesCodexManagedCredentials === 'boolean') facts.append(fact('凭据管理', account.usesCodexManagedCredentials ? 'Codex 托管' : '外部提供'));
    if (typeof result?.requiresOpenaiAuth === 'boolean') facts.append(fact('OpenAI 授权要求', result.requiresOpenaiAuth ? '需要' : '不需要'));
    section(identity, '身份', head, facts);
  }

  function meter(view) {
    const node = el(document, 'div', 'quota-window');
    const top = el(document, 'div', 'quota-top');
    top.append(el(document, 'span', 'quota-name', view.label), el(document, 'strong', 'quota-left', view.remaining === null ? UNKNOWN : `剩余 ${Math.round(view.remaining)}%`));
    const bar = el(document, 'div', 'quota-bar'); bar.setAttribute('role', 'meter'); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100');
    if (view.remaining !== null) { bar.setAttribute('aria-valuenow', String(Math.round(view.remaining))); bar.setAttribute('aria-label', `${view.label}剩余额度 ${Math.round(view.remaining)}%`); const fill = el(document, 'span'); fill.style.width = view.remaining + '%'; bar.append(fill); bar.dataset.level = view.remaining <= 10 ? 'high' : view.remaining <= 30 ? 'mid' : 'low'; }
    else bar.setAttribute('aria-label', `${view.label}剩余额度未知`);
    const foot = el(document, 'div', 'quota-foot'); foot.append(el(document, 'span', '', '剩余额度'), el(document, 'span', '', view.reset));
    foot.title = '重置时间 ' + view.resetAt;
    node.append(top, bar, foot); return node;
  }
  function renderQuota(result, error) {
    if (selectedCredit) selectedCredit = result?.rateLimitResetCredits?.credits?.find(credit => credit.id === selectedCredit.id && credit.status === 'available' && credit.resetType === 'codexRateLimits' && (!finite(credit.expiresAt) || credit.expiresAt * 1000 > Date.now())) || null;
    if (error) { quotaResult = null; renderResetCredits(); section(quota, '额度', errorLine('无法读取额度', error)); return; }
    quotaResult = result; onQuota(result);
    const buckets = quotaBuckets(result);
    const children = [];
    if (result?.ordinaryUsageAllowed === false) children.push(el(document, 'p', 'quota-alert', '服务当前不允许普通用量。'));
    if (!buckets.length) children.push(el(document, 'p', 'empty-line', '服务没有返回额度窗口。'));
    if (!buckets.some(bucket => bucket.id === bucketId)) bucketId = buckets[0]?.id;
    if (buckets.length > 1) {
      const label = el(document, 'label', 'acct-quota-select'); label.append(el(document, 'span', '', '额度类型'));
      const select = el(document, 'select');
      select.dataset.focusKey = 'quota-bucket';
      for (const bucket of buckets) { const option = el(document, 'option', '', bucket.limitName || bucket.id); option.value = bucket.id; select.append(option); }
      select.value = bucketId; select.addEventListener('change', () => { bucketId = select.value; renderQuota(quotaResult); }); label.append(select); children.push(label);
    }
    for (const bucket of buckets.filter(bucket => bucket.id === bucketId)) {
      const group = el(document, 'div', 'quota-group');
      const head = el(document, 'div', 'quota-group-head'); head.append(el(document, 'strong', '', bucket.limitName || bucket.id || '额度'));
      if (bucket.planType) head.append(el(document, 'span', 'quota-plan', PLAN[bucket.planType] || bucket.planType));
      if (bucket.spendControlReached === true) head.append(el(document, 'span', 'quota-flag', '已达支出上限'));
      group.append(head);
      if (bucket.normalModelSlug) group.append(el(document, 'p', 'quota-credits', `对应模型 · ${bucket.normalModelSlug}`));
      if (REACHED[bucket.rateLimitReachedType]) group.append(el(document, 'p', 'quota-alert', REACHED[bucket.rateLimitReachedType]));
      for (const key of ['primary', 'secondary']) { const view = windowView(bucket[key]); if (view) group.append(meter(view)); }
      const credits = bucket.credits;
      if (credits && typeof credits === 'object') {
        const text = credits.unlimited === true ? '无限额度' : credits.hasCredits === false ? '无可用 credits' : credits.balance != null ? `余额 ${String(credits.balance).slice(0, 40)}（服务 credits 单位）` : credits.hasCredits === true ? '有可用 credits（余额未提供）' : '';
        if (text) group.append(el(document, 'p', 'quota-credits', 'Credits · ' + text));
      }
      const limit = bucket.individualLimit;
      if (limit) {
        const details = el(document, 'details', 'acct-details'); details.dataset.stateKey = 'individual-limit'; const summary = el(document, 'summary', '', '个人支出控制'); summary.dataset.focusKey = 'individual-limit'; details.append(summary);
        details.append(fact('已使用 / 上限', `${limit.used} / ${limit.limit}`), fact('剩余比例', `${limit.remainingPercent}%`), fact('重置时间', localTime(limit.resetsAt * 1000))); group.append(details);
      }
      children.push(group);
    }
    section(quota, '额度', ...children);
    renderResetCredits();
  }

  function renderResetCredits() {
    const summary = quotaResult?.rateLimitResetCredits;
    const signature = JSON.stringify([summary, attempt, selectedCredit?.id, demo(), summary?.credits?.map(credit => finite(credit.expiresAt) && credit.expiresAt * 1000 <= Date.now())]);
    if (signature === creditSignature) return;
    creditSignature = signature;
    resetCredits.hidden = !summary && !attempt;
    if (!summary && !attempt) return;
    const body = el(document, 'div', 'acct-credit-body');
    if (summary) {
      const top = el(document, 'div', 'acct-credit-heading'); top.append(el(document, 'strong', '', `${integer(summary.availableCount)} 张可用`), el(document, 'span', '', '用于重置符合条件的 Codex 限额窗口'));
      body.append(top);
    }
    if (attempt?.state === 'pending') body.append(el(document, 'p', 'empty-line', '正在使用重置卡，请勿重复提交。'));
    else if (attempt?.state === 'unknown') body.append(el(document, 'p', 'quota-alert', '使用结果尚未确认，已锁定再次提交。请刷新额度及卡片状态核实；不会自动重试。'));
    else if (attempt?.message) body.append(el(document, 'p', attempt.error ? 'inline-error' : 'acct-credit-result', attempt.message));
    const credits = Array.isArray(summary?.credits) ? summary.credits : null;
    if (credits === null && summary?.availableCount > 0) body.append(el(document, 'p', 'empty-line', '服务只返回可用数量，暂未提供可选择的卡片。'));
    else if (credits && !credits.length && summary?.availableCount > 0) body.append(el(document, 'p', 'empty-line', '服务未返回卡片详情，暂时无法选择使用。'));
    if (credits?.length) {
      const details = el(document, 'details', 'acct-details'); details.open = !!selectedCredit; details.dataset.stateKey = 'reset-credits';
      const toggle = el(document, 'summary', '', `查看卡片（${credits.length}）`); toggle.dataset.focusKey = 'reset-credits'; details.append(toggle);
      const list = el(document, 'div', 'acct-credit-list');
      for (const credit of credits) {
        const expired = finite(credit.expiresAt) && credit.expiresAt * 1000 <= Date.now();
        const canUse = credit.status === 'available' && credit.resetType === 'codexRateLimits' && !expired && !demo() && !['pending', 'unknown'].includes(attempt?.state);
        const row = el(document, 'div', 'acct-credit-row');
        const info = el(document, 'div', 'acct-credit-info'); info.append(el(document, 'strong', '', credit.title || 'Codex 限额重置卡'));
        if (credit.description) info.append(el(document, 'span', '', credit.description));
        info.append(el(document, 'span', 'acct-credit-meta', `${expired ? '已过期' : RESET_STATUS[credit.status] || '状态未知'} · ${localTime(credit.grantedAt * 1000)} 获得${finite(credit.expiresAt) ? ` · ${localTime(credit.expiresAt * 1000)} 到期` : ''}`));
        const choose = el(document, 'button', 'btn', selectedCredit?.id === credit.id ? '已选择' : '选择使用'); choose.type = 'button'; choose.disabled = !canUse;
        choose.dataset.focusKey = `credit:${credit.id}`;
        choose.addEventListener('click', () => { selectedCredit = credit; renderResetCredits(); resetCredits.querySelector('[data-focus-key="credit-confirm"]')?.focus(); });
        row.append(info, choose); list.append(row);
      }
      details.append(list); body.append(details);
      if (credits.length < summary.availableCount) body.append(el(document, 'p', 'empty-line', '服务仅返回部分可用卡片。'));
    }
    if (selectedCredit && !['pending', 'unknown'].includes(attempt?.state)) {
      const confirm = el(document, 'div', 'acct-credit-confirm');
      confirm.append(el(document, 'strong', '', `使用「${selectedCredit.title || 'Codex 限额重置卡'}」？`), el(document, 'p', '', '将消耗这张卡，并重置服务判定符合条件的限额窗口。此操作无法撤销；没有可重置窗口时以服务返回结果为准。'));
      const actions = el(document, 'div', 'acct-credit-actions');
      const cancel = el(document, 'button', 'btn', '取消'); cancel.type = 'button'; cancel.addEventListener('click', () => { selectedCredit = null; renderResetCredits(); });
      const use = el(document, 'button', 'btn primary', '确认使用这张卡'); use.type = 'button'; use.addEventListener('click', consumeCredit);
      cancel.dataset.focusKey = 'credit-cancel'; use.dataset.focusKey = 'credit-confirm';
      actions.append(cancel, use); confirm.append(actions); body.append(confirm);
    }
    section(resetCredits, '限额重置卡', body);
  }

  async function consumeCredit() {
    const credit = selectedCredit;
    if (!credit || demo() || ['pending', 'unknown'].includes(attempt?.state)) return;
    if (credit.status !== 'available' || credit.resetType !== 'codexRateLimits' || (finite(credit.expiresAt) && credit.expiresAt * 1000 <= Date.now())) { selectedCredit = null; await load(); return; }
    const mine = accountEpoch;
    // This UUID belongs to one logical redemption. An uncertain result never creates a new attempt.
    const current = { creditId: credit.id, idempotencyKey: crypto.randomUUID(), state: 'pending' }; attempt = current; selectedCredit = null; refresh.disabled = true; renderResetCredits();
    try {
      const result = await rpc('account/rateLimitResetCredit/consume', { creditId: current.creditId, idempotencyKey: current.idempotencyKey });
      if (mine !== accountEpoch) return;
      const messages = { reset: '重置卡已使用，符合条件的窗口已重置。', alreadyRedeemed: '这次操作已成功使用，无需再次提交。', nothingToReset: '当前没有符合条件的可重置窗口。', noCredit: '服务确认没有可用的重置卡。' };
      if (!messages[result?.outcome]) { current.state = 'unknown'; }
      else { current.state = 'complete'; current.message = messages[result.outcome]; }
    } catch { if (mine === accountEpoch) current.state = 'unknown'; }
    finally { if (mine === accountEpoch) { refresh.disabled = false; if (active) await load(); else renderResetCredits(); } }
  }

  function renderUsage(result, error) {
    if (error) { section(usage, '官方账户用量', errorLine('无法读取官方用量', error)); return; }
    const summary = result?.summary || {};
    const strip = el(document, 'div', 'usage-strip');
    const stat = (label, value, full = value) => { const cell = el(document, 'div', 'usage-stat'); cell.title = full; cell.append(el(document, 'span', '', label), el(document, 'strong', '', value)); return cell; };
    if (finite(summary.lifetimeTokens)) strip.append(stat('累计 Tokens', compact(summary.lifetimeTokens), integer(summary.lifetimeTokens)));
    if (finite(summary.peakDailyTokens)) strip.append(stat('单日峰值', compact(summary.peakDailyTokens), integer(summary.peakDailyTokens)));
    if (finite(summary.longestRunningTurnSec)) strip.append(stat('最长回合', `${integer(summary.longestRunningTurnSec)} 秒`));
    if (finite(summary.currentStreakDays)) strip.append(stat('当前连续', `${integer(summary.currentStreakDays)} 天`));
    if (finite(summary.longestStreakDays)) strip.append(stat('最长连续', `${integer(summary.longestStreakDays)} 天`));
    const buckets = Array.isArray(result?.dailyUsageBuckets) ? result.dailyUsageBuckets.filter(row => typeof row?.startDate === 'string' && finite(row.tokens)).sort((a, b) => a.startDate.localeCompare(b.startDate)) : [];
    const thread = result?.threadUsage;
    const tabs = [{ id: 'overview', name: '概览' }];
    if (buckets.length) tabs.push({ id: 'daily', name: '每日用量' });
    if (thread && thread.threadId === getThreadId()) tabs.push({ id: 'thread', name: '当前对话' });
    if (!tabs.some(tab => tab.id === usageTab)) usageTab = 'overview';
    const children = [];
    if (tabs.length > 1) {
      const nav = el(document, 'div', 'acct-tabs'); nav.setAttribute('role', 'group'); nav.setAttribute('aria-label', '官方用量维度');
      for (const tab of tabs) { const button = el(document, 'button', '', tab.name); button.type = 'button'; button.setAttribute('aria-pressed', String(tab.id === usageTab)); button.addEventListener('click', () => { usageTab = tab.id; renderUsage(result); usage.querySelector(`[data-tab="${tab.id}"]`)?.focus(); }); button.dataset.tab = tab.id; button.dataset.focusKey = `usage:${tab.id}`; nav.append(button); }
      children.push(nav);
    }
    if (usageTab === 'overview') {
      if (strip.childNodes.length) children.push(strip);
      if (buckets.length) {
        const chart = el(document, 'div', 'chart-host compact');
        const shown = buckets.slice(-30);
        chart.append(barChart(document, shown.map(row => ({ label: row.startDate.slice(5), value: row.tokens, title: `${row.startDate} · ${integer(row.tokens)} tokens` })), { height: 140 })); children.push(chart);
        children.push(el(document, 'p', 'acct-usage-caption', `${shown[0].startDate} — ${shown[shown.length - 1].startDate} · ${integer(shown.reduce((sum, row) => sum + row.tokens, 0))} Tokens（返回日期合计）`));
      }
      if (!strip.childNodes.length && !buckets.length) children.push(el(document, 'p', 'empty-line', '服务没有返回账户用量统计。'));
    } else if (usageTab === 'daily') {
      const sum = buckets.reduce((total, row) => total + row.tokens, 0);
      children.push(el(document, 'p', 'acct-usage-caption', `服务返回 ${integer(buckets.length)} 个日期 · 合计 ${integer(sum)} Tokens`));
      children.push(dataTable(['日期', 'Tokens', '占返回日期合计'], buckets.slice().reverse().map(row => [row.startDate, integer(row.tokens), sum ? `${(row.tokens / sum * 100).toFixed(1)}%` : '0%'])));
    } else if (usageTab === 'thread') {
      const facts = el(document, 'div', 'facts');
      if (finite(thread.estimatedUsageCreditsMicros)) facts.append(fact('估算 Credits', decimal(micros(thread.estimatedUsageCreditsMicros))));
      if (finite(thread.estimatedUsageUsdMicros)) facts.append(fact('估算费用（USD）', usd(micros(thread.estimatedUsageUsdMicros))));
      children.push(facts);
      const groups = Array.isArray(thread.groups) ? thread.groups : [];
      if (groups.length) {
        const columns = [
          ['model', '模型', String], ['reasoningEffort', '推理强度', String], ['speed', '速度档', String],
          ['inputTokens', '输入', integer], ['cachedInputTokens', '缓存输入', integer], ['netNewInputTokens', '新增输入', integer], ['outputTokens', '输出', integer], ['totalTokens', '总 Tokens', integer],
          ['estimatedUsageCreditsMicros', '估算 Credits', value => decimal(micros(value))],
        ].filter(([key]) => groups.some(group => group[key] != null));
        children.push(dataTable(columns.map(([, name]) => name), groups.map(group => columns.map(([key, , format]) => group[key] == null ? UNKNOWN : format(group[key])))));
      }
    }
    if (result?.threadUsageError) children.push(el(document, 'p', 'inline-error', '当前对话的官方用量估算暂时无法读取，可刷新重试。'));
    section(usage, '官方账户用量', ...children);
  }

  function dataTable(headers, rows) {
    const wrap = el(document, 'div', 'acct-table-wrap'); wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', '账户用量明细，可横向滚动');
    const table = el(document, 'table', 'acct-table'); const head = el(document, 'thead'); const tr = el(document, 'tr');
    for (const name of headers) { const th = el(document, 'th', '', name); th.scope = 'col'; tr.append(th); } head.append(tr);
    const body = el(document, 'tbody'); for (const values of rows) { const row = el(document, 'tr'); for (const value of values) row.append(el(document, 'td', '', value)); body.append(row); }
    table.append(head, body); wrap.append(table); return wrap;
  }

  function setRefreshing(value) {
    refresh.disabled = value;
    refresh.setAttribute('aria-busy', String(value));
    refresh.setAttribute('aria-label', value ? '正在刷新账户' : '刷新账户');
    host.classList.toggle('acct-refreshing', value);
    for (const node of [identity, quota, usage]) node.setAttribute('aria-busy', String(value));
  }

  function load() {
    if (!active || attempt?.state === 'pending') return;
    if (loadTask) return loadTask;
    const mine = ++generation; setRefreshing(true);
    for (const [node, title] of [[identity, '身份'], [quota, '额度'], [usage, '官方账户用量']]) {
      if (!node.childNodes.length) { node.classList.add('acct-loading'); section(node, title, el(document, 'p', 'empty-line', '正在读取…')); }
    }
    const settle = async (promise, node, render, signatureFor = result => result) => {
      try {
        const result = await promise;
        if (!active || mine !== generation) return;
        node.querySelector('.acct-refresh-error')?.remove();
        const signature = JSON.stringify(signatureFor(result));
        if (rendered.get(node) !== signature) { render(result, null); rendered.set(node, signature); }
        // The credit attempt can change independently of the quota response.
        if (node === quota) renderResetCredits();
      } catch (error) {
        if (!active || mine !== generation) return;
        if (rendered.has(node)) {
          node.querySelector('.acct-refresh-error')?.remove();
          const line = errorLine('刷新失败，显示上次读取结果', error); line.classList.add('acct-refresh-error'); line.setAttribute('role', 'status'); node.append(line);
        } else render(null, error);
      } finally {
        if (active && mine === generation) { node.classList.remove('acct-loading'); node.setAttribute('aria-busy', 'false'); }
      }
    };
    const readUsage = async () => {
      const threadId = getThreadId();
      // A thread-scoped request returns thread estimates instead of account-wide activity.
      const requests = [rpc('account/usage/read', {})];
      if (threadId) requests.push(rpc('account/usage/read', { threadId }));
      const [accountResult, threadResult] = await Promise.allSettled(requests);
      if (accountResult.status === 'rejected') throw accountResult.reason;
      return { ...accountResult.value, threadUsage: threadResult?.status === 'fulfilled' ? threadResult.value?.threadUsage : null, threadUsageError: threadResult?.status === 'rejected' };
    };
    loadTask = Promise.all([
      settle(Promise.resolve().then(() => rpc('account/read', { refreshToken: false })), identity, renderIdentity),
      settle(Promise.resolve().then(() => rpc('account/rateLimits/read', { excludeResetCreditDetails: false })), quota, renderQuota, result => [result, quotaBuckets(result).map(bucket => [windowView(bucket.primary), windowView(bucket.secondary)])]),
      settle(readUsage(), usage, renderUsage, result => [result, getThreadId()]),
    ]).finally(() => { if (mine === generation) { loadTask = null; setRefreshing(false); } });
    return loadTask;
  }
  return {
    activate() { active = true; return load(); },
    deactivate() { active = false; generation++; loadTask = null; setRefreshing(false); },
    refresh: load,
    reset() { generation++; accountEpoch++; loadTask = null; rendered.clear(); creditSignature = null; quotaResult = null; selectedCredit = null; attempt = null; bucketId = null; usageTab = 'overview'; setRefreshing(false); resetCredits.hidden = true; for (const node of [identity, quota, usage, resetCredits]) { node.classList.remove('acct-loading'); node.replaceChildren(); } },
  };
}
