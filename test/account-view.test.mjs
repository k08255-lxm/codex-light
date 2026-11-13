import test from 'node:test';
import assert from 'node:assert/strict';
import { mountAccount } from '../public/ui/account-view.js';
import { createDocument } from './mini-dom.mjs';

const identity = email => ({ account: { type: 'chatgpt', email, planType: 'plus' }, requiresOpenaiAuth: true });
const quota = (used = 24) => ({ rateLimitsByLimitId: { codex: { primary: { usedPercent: used, windowDurationMins: 300 } }, extra: { primary: { usedPercent: 50, windowDurationMins: 300 } } }, rateLimitResetCredits: { availableCount: 1, credits: [{ id: 'one', title: '测试卡', status: 'available', resetType: 'codexRateLimits', grantedAt: 1 }] } });
const usage = { summary: { lifetimeTokens: 1200 }, dailyUsageBuckets: [{ startDate: '2026-11-12', tokens: 1200 }] };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function setup() {
  const document = createDocument(), host = document.createElement('main'); document.body.append(host);
  let read = method => method === 'account/read' ? identity('one@example.test') : method === 'account/rateLimits/read' ? quota() : usage;
  const calls = [], callbacks = [];
  const account = mountAccount(host, { rpc: (method, params) => { calls.push([method, params]); return read(method, params); }, onQuota: value => callbacks.push(value) });
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
  credits.querySelector('details').open = true;
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

test('identical results retain DOM, native disclosure state and focus; reads are coalesced', async () => {
  const view = setup(); await view.account.activate();
  const head = view.host.querySelector('.acct-head'), selector = view.host.querySelector('select'), details = view.host.querySelector('.acct-reset-credits').querySelector('details');
  details.open = true; selector.focus();
  const first = view.account.refresh(), second = view.account.refresh(); assert.equal(first, second);
  await first;
  assert.equal(view.calls.length, 6); assert.equal(view.callbacks.length, 1);
  assert.equal(view.host.querySelector('.acct-head'), head); assert.equal(view.host.querySelector('select'), selector);
  assert.equal(view.document.activeElement, selector); assert.equal(details.open, true);
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
