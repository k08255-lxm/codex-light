import test from 'node:test';
import assert from 'node:assert/strict';
import { mountAccount, usageReadFailure } from '../public/ui/account-view.js';
import { createDocument } from './mini-dom.mjs';

const identity = email => ({ account: { type: 'chatgpt', email, planType: 'plus' }, requiresOpenaiAuth: true });
const quota = (used = 24) => ({ rateLimitsByLimitId: { codex: { primary: { usedPercent: used, windowDurationMins: 300 } }, extra: { primary: { usedPercent: 50, windowDurationMins: 300 } } }, rateLimitResetCredits: { availableCount: 1, credits: [{ id: 'one', title: '测试卡', status: 'available', resetType: 'codexRateLimits', grantedAt: 1 }] } });
const usage = { summary: { lifetimeTokens: 1200 }, dailyUsageBuckets: [{ startDate: '2026-11-12', tokens: 1200 }] };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function setup({ getThreadId = () => null } = {}) {
  const document = createDocument(), host = document.createElement('main'); document.body.append(host);
  let read = method => method === 'account/read' ? identity('one@example.test') : method === 'account/rateLimits/read' ? quota() : usage;
  const calls = [], callbacks = [];
  const account = mountAccount(host, { rpc: (method, params) => { calls.push([method, params]); return read(method, params); }, getThreadId, onQuota: value => callbacks.push(value) });
  return { document, host, calls, callbacks, account, use: fn => { read = fn; } };
}

test('account quota bar, meter and label consistently describe remaining allowance', async () => {
  const view = setup();
  view.use(method => method === 'account/read' ? identity('one@example.test') : method === 'account/rateLimits/read' ? quota(90) : usage);
  await view.account.activate();
  const window = view.host.querySelector('.quota-window'), bar = window.querySelector('.quota-bar');
  assert.equal(bar.firstChild.style.width, '10%');
  assert.equal(bar.getAttribute('aria-valuenow'), '10');
  assert.match(bar.getAttribute('aria-label'), /剩余额度 10%/);
  assert.equal(bar.dataset.level, 'high');
  assert.match(window.querySelector('.quota-left').textContent, /剩余 10%/);
  assert.doesNotMatch(window.textContent, /已用/);
  assert.match(window.querySelector('.quota-foot').textContent, /剩余额度/);
});

test('unknown allowance has no fabricated bar fill or numeric accessible value', async () => {
  const view = setup();
  view.use(method => method === 'account/read' ? identity('one@example.test') : method === 'account/rateLimits/read' ? { rateLimits: { primary: { windowDurationMins: 300 } } } : usage);
  await view.account.activate();
  const window = view.host.querySelector('.quota-window'), bar = window.querySelector('.quota-bar');
  assert.equal(bar.children.length, 0);
  assert.equal(bar.getAttribute('aria-valuenow'), null);
  assert.match(bar.getAttribute('aria-label'), /剩余额度未知/);
  assert.equal(window.querySelector('.quota-left').textContent, '—');
  assert.doesNotMatch(window.textContent, /0%|已用/);
});

test('reentering refreshes in the background without replacing trusted content or resetting credit selection', async () => {
  const view = setup(); await view.account.activate();
  const identity = view.host.querySelector('.acct-head'), selector = view.host.querySelector('select'), tabs = view.host.querySelector('.acct-tabs'), credits = view.host.querySelector('.acct-reset-credits');
  assert.equal(credits.querySelector('details'), null);
  credits.querySelector('[data-focus-key="credit:one"]').click();
  const confirm = credits.querySelector('[data-focus-key="credit-confirm"]'); confirm.focus();
  view.account.deactivate();
  const wait = deferred(); view.use(() => wait.promise);
  const refresh = view.account.activate();
  assert.equal(view.host.querySelector('.acct-head'), identity);
  assert.equal(view.host.querySelector('select'), selector);
  assert.equal(view.host.querySelector('.acct-tabs'), tabs);
  assert.equal(credits.hidden, false); assert.equal(credits.querySelector('[data-focus-key="credit-confirm"]'), confirm);
  assert.equal(view.host.querySelector('.acct-refresh').getAttribute('aria-busy'), 'true');
  wait.resolve({}); await refresh;
});

test('identical results retain visible cards and focus; reads are coalesced', async () => {
  const view = setup(); await view.account.activate();
  const head = view.host.querySelector('.acct-head'), selector = view.host.querySelector('select'), card = view.host.querySelector('.acct-credit-row');
  selector.focus();
  const first = view.account.refresh(), second = view.account.refresh(); assert.equal(first, second);
  await first;
  assert.equal(view.calls.length, 6); assert.equal(view.callbacks.length, 1);
  assert.equal(view.host.querySelector('.acct-head'), head); assert.equal(view.host.querySelector('select'), selector);
  assert.equal(view.document.activeElement, selector); assert.equal(view.host.querySelector('.acct-credit-row'),card);
});

test('changed quota preserves selected bucket and restores the active control', async () => {
  const view = setup(); await view.account.activate();
  const select = view.host.querySelector('select'); select.value = 'extra'; select.dispatch('change');
  view.host.querySelector('select').focus();
  view.use(method => method === 'account/read' ? identity('one@example.test') : method === 'account/rateLimits/read' ? quota(35) : usage);
  await view.account.refresh();
  assert.equal(view.host.querySelector('select').value, 'extra');
  assert.equal(view.document.activeElement, view.host.querySelector('select'));
});

test('failed refresh keeps successful sections and selection, exposes failure, and clears it on recovery', async () => {
  const view = setup(); await view.account.activate();
  const head = view.host.querySelector('.acct-head'), select = view.host.querySelector('select');
  view.use(() => Promise.reject(new Error('offline'))); await view.account.refresh();
  assert.equal(view.host.querySelector('.acct-head'), head); assert.equal(view.host.querySelector('select'), select);
  assert.equal(view.host.querySelectorAll('.acct-refresh-error').length, 3);
  assert.match(view.host.textContent, /刷新失败，显示上次读取结果：offline/);
  assert.equal(view.host.querySelector('.acct-refresh').disabled, false);
  view.use(method => method === 'account/read' ? identity('one@example.test') : method === 'account/rateLimits/read' ? quota() : usage);
  await view.account.refresh();
  assert.equal(view.host.querySelectorAll('.acct-refresh-error').length, 0); assert.equal(view.host.querySelector('.acct-head'), head);
});

test('reset clears identity, quota, cards and cache; late earlier-account results cannot repopulate them', async () => {
  const view = setup(); await view.account.activate();
  const stale = deferred(); view.use(() => stale.promise); const oldLoad = view.account.refresh();
  await Promise.resolve(); view.account.reset();
  assert.doesNotMatch(view.host.textContent, /one@example|测试卡|1,200/);
  view.use(method => method === 'account/read' ? identity('new@example.test') : method === 'account/rateLimits/read' ? {} : { summary: {} });
  await view.account.refresh();
  stale.resolve(identity('stale@example.test')); await oldLoad;
  assert.match(view.host.textContent, /new@example.test/); assert.doesNotMatch(view.host.textContent, /stale@example|测试卡/);
  assert.equal(view.host.querySelector('.acct-reset-credits').hidden, true);
});

test('leaving during the initial read discards its result; a new activation can finish independently', async () => {
  const view = setup(), stale = deferred(); view.use(() => stale.promise);
  const oldLoad = view.account.activate(); await Promise.resolve(); view.account.deactivate();
  view.use(method => method === 'account/read' ? identity('latest@example.test') : method === 'account/rateLimits/read' ? quota() : usage);
  await view.account.activate(); stale.resolve(identity('stale@example.test')); await oldLoad;
  assert.match(view.host.textContent, /latest@example.test/); assert.doesNotMatch(view.host.textContent, /stale@example/);
  assert.equal(view.host.querySelector('.acct-refresh').getAttribute('aria-busy'), 'false');
  assert.equal(view.host.querySelectorAll('.acct-loading').length, 0);
});

test('usage failures retain only safe HTTP/RPC diagnostics and never infer an account suspension', () => {
  const failure = usageReadFailure(Object.assign(new Error('request returned HTTP status server error (500 Internal Server Error) for https://example.test?token=PRIVATE&account_id=PRIVATE_ACCOUNT'), { code: -32603 }));
  assert.deepEqual(failure, { kind: 'service', httpStatus: 500, rpcCode: -32603 });
  assert.doesNotMatch(JSON.stringify(failure), /PRIVATE|https|account_id/);
  assert.deepEqual(usageReadFailure({ message: 'SECRET_TOKEN_VALUE', code: 'SECRET_TOKEN_VALUE' }), { kind: 'unknown', httpStatus: null, rpcCode: null });
  assert.equal(usageReadFailure({ status: 401 }).kind, 'authorization');
  assert.equal(usageReadFailure({ message: '429 Too Many Requests' }).kind, 'rateLimit');
  assert.equal(usageReadFailure({ code: 'RPC_TIMEOUT' }).kind, 'timeout');
  assert.equal(usageReadFailure({ code: -32601 }).kind, 'unsupported');
});

test('thread usage failure keeps account totals and quota, exposes safe codes and recovers to an honest unavailable state', async () => {
  const view = setup({ getThreadId: () => 'current' });
  let fail = true;
  view.use((method, params) => {
    if (method === 'account/read') return identity('one@example.test');
    if (method === 'account/rateLimits/read') return quota();
    if (!params.threadId) return usage;
    if (fail) throw Object.assign(new Error('HTTP 500 Internal Server Error https://example.test?token=PRIVATE'), { code: -32603 });
    return { summary: {}, dailyUsageBuckets: null, threadUsage: null };
  });
  await view.account.activate();
  const section = view.host.querySelector('.acct-usage');
  assert.match(section.textContent, /1,200|1.2千/);
  assert.match(section.textContent, /当前对话.*用量服务暂时出错.*HTTP 500.*RPC -32603/);
  assert.doesNotMatch(section.textContent, /PRIVATE|https|封禁|风控/);
  assert.match(view.host.querySelector('.acct-quota').textContent, /剩余 76%/);
  assert.deepEqual(view.calls.filter(([method]) => method === 'account/usage/read').map(([, params]) => params), [{}, { threadId: 'current' }]);
  fail = false; await view.account.refresh();
  assert.doesNotMatch(section.textContent, /读取失败|HTTP 500/);
  assert.match(section.textContent, /暂无当前对话的官方用量/);
  assert.equal(section.querySelector('.inline-error'), null);
});

test('account usage failure does not hide a successful current-thread estimate', async () => {
  const view = setup({ getThreadId: () => 'current' });
  view.use((method, params) => {
    if (method === 'account/read') return identity('one@example.test');
    if (method === 'account/rateLimits/read') return quota();
    if (!params.threadId) return Promise.reject(Object.assign(new Error('HTTP 503 Service Unavailable SECRET'), { code: -32603 }));
    return { threadUsage: { threadId: 'current', estimatedUsageCreditsMicros: 1000000, groups: [] } };
  });
  await view.account.activate();
  const section = view.host.querySelector('.acct-usage');
  assert.match(section.textContent, /Credits1/);
  assert.match(section.textContent, /来自官方用量估算，实际扣款以账单为准/);
  assert.match(section.textContent, /官方账户汇总.*HTTP 503.*RPC -32603/);
  assert.doesNotMatch(section.textContent, /SECRET|服务没有返回账户用量统计/);
  assert.match(section.querySelector('.acct-usage-caption').textContent, /当前对话/);
  assert.equal(section.querySelector('[data-tab="overview"]'), null);
});

test('failed usage refresh preserves prior data without exposing raw upstream request details', async () => {
  const view = setup({ getThreadId: () => 'current' });
  await view.account.activate();
  const section = view.host.querySelector('.acct-usage'), oldChart = section.querySelector('.chart-host');
  view.use((method) => method === 'account/read' ? identity('one@example.test') : method === 'account/rateLimits/read' ? quota() : Promise.reject(Object.assign(new Error('HTTP 500 Internal Server Error https://example.test?token=PRIVATE'), { code: -32603 })));
  await view.account.refresh();
  assert.equal(section.querySelector('.chart-host'), oldChart);
  assert.match(section.textContent, /刷新失败，显示上次读取结果.*HTTP 500/);
  assert.doesNotMatch(section.textContent, /PRIVATE|https/);
});

test('a late failed thread usage request is not attributed to a different selected conversation', async () => {
  let threadId = 'old';
  const view = setup({ getThreadId: () => threadId }), wait = deferred();
  view.use((method, params) => method === 'account/read' ? identity('one@example.test') : method === 'account/rateLimits/read' ? quota() : params.threadId ? wait.promise : usage);
  const pending = view.account.activate(); await Promise.resolve(); threadId = 'new';
  wait.reject(Object.assign(new Error('HTTP 500 Internal Server Error'), { code: -32603 })); await pending;
  assert.doesNotMatch(view.host.querySelector('.acct-usage').textContent, /HTTP 500|当前对话.*失败|尚未提供当前对话/);
});
