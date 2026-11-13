import test from 'node:test';
import assert from 'node:assert/strict';
import { mountAccountQuota, sidebarQuotaWindows, windowView } from '../public/account-quota.js';
import { createDocument } from './mini-dom.mjs';

const limits = (used = 24) => ({ rateLimitsByLimitId: { codex: {
  primary: { usedPercent: used, windowDurationMins: 300 },
  secondary: { usedPercent: 81, windowDurationMins: 10080 }
} } });
function setup() {
  const document = createDocument(), host = document.createElement('div'), calls = [];
  document.body.append(host);
  const quota = mountAccountQuota(host, { rpc: async () => limits(), onOpen: () => calls.push('open') });
  return { host, calls, ...quota };
}

test('sidebar quota arcs, visible percentages, tooltip and meter all describe remaining allowance', () => {
  const view = setup(); view.update(limits());
  assert.equal(view.host.hidden, false);
  const button = view.host.querySelector('button'), rows = view.host.querySelectorAll('.account-quota-row');
  assert.equal(rows.length, 2);
  assert.match(button.title, /剩余 76%/);
  assert.match(button.getAttribute('aria-label'), /剩余 76%/);
  for (const [index, remaining] of [76, 19].entries()) {
    const row = rows[index];
    assert.equal(row.getAttribute('aria-valuenow'), String(remaining));
    assert.match(row.getAttribute('aria-label'), /剩余额度/);
    assert.match(row.getAttribute('aria-valuetext'), new RegExp(`剩余 ${remaining}%`));
    assert.equal(row.querySelector('.account-quota-value').textContent, `${remaining}%`);
    assert.equal(row.querySelector('.account-quota-ring-track').getAttribute('stroke-dasharray'), '75 25');
    assert.equal(row.querySelector('.account-quota-ring-fill').getAttribute('stroke-dasharray'), `${remaining * .75} ${100 - remaining * .75}`);
  }
  assert.equal(rows[0].querySelector('.account-quota-period').textContent, '5h');
  assert.equal(rows[1].querySelector('.account-quota-period').textContent, '周');
  button.click(); assert.deepEqual(view.calls, ['open']);
});

test('missing, nonnumeric and ambiguous quota data is hidden instead of inventing percentages', () => {
  const view = setup();
  for (const data of [null, {}, { rateLimits: { primary: { windowDurationMins: 300 } } }, { rateLimits: { primary: { usedPercent: NaN, windowDurationMins: 300 } } }, { rateLimitsByLimitId: { one: { primary: { usedPercent: 0, windowDurationMins: 300 } }, two: {} } }]) {
    view.update(data); assert.equal(view.host.hidden, true); assert.equal(view.host.children.length, 0);
  }
  assert.equal(sidebarQuotaWindows({ rateLimits: { primary: { usedPercent: 3, windowDurationMins: 30 } } }).length, 0);
});

test('full and empty remaining allowance retain the opening and distinguish actual zero', () => {
  const view = setup(); view.update(limits(100));
  let row = view.host.querySelector('.account-quota-row');
  assert.equal(row.getAttribute('aria-valuenow'), '0');
  assert.equal(row.querySelector('.account-quota-value').textContent, '0%');
  assert.equal(row.querySelector('.account-quota-ring-fill').getAttribute('visibility'), 'hidden');
  assert.equal(row.dataset.level, 'high');
  view.update(limits(0)); row = view.host.querySelector('.account-quota-row');
  assert.equal(row.querySelector('.account-quota-ring-fill').getAttribute('stroke-dasharray'), '75 25');
  assert.equal(row.querySelector('.account-quota-value').textContent, '100%');
  assert.equal(windowView({ usedPercent: 24 }).used, 24, 'shared usage values keep their original used semantics');
});

test('quota refresh and account-page callbacks preserve button, keyed rings, focus and one click handler', () => {
  const view = setup(); view.update(limits());
  const button = view.host.querySelector('button'), row = view.host.querySelector('.account-quota-row'), ring = row.firstChild;
  button.focus(); view.update(limits()); view.update(limits(45));
  assert.equal(view.host.querySelector('button'), button);
  assert.equal(view.host.querySelector('.account-quota-row'), row);
  assert.equal(row.firstChild, ring);
  assert.equal(view.host.ownerDocument.activeElement, button);
  assert.equal(row.querySelector('.account-quota-value').textContent, '55%');
  button.click(); assert.deepEqual(view.calls, ['open']);
});

test('background failure keeps the last quota visibly stale, while account reset rejects late reads', async t => {
  const document = createDocument(), host = document.createElement('div'); document.body.append(host);
  let fail = false, resolve;
  const view = mountAccountQuota(host, { rpc: () => fail ? Promise.reject(new Error('offline')) : new Promise(done => { resolve = done; }) });
  t.after(() => view.stop());
  view.start(); view.update(limits()); const button = host.querySelector('button');
  resolve(limits()); await view.refresh();
  fail = true; await view.refresh();
  assert.equal(host.querySelector('button'), button); assert.equal(host.hidden, false);
  assert.match(button.getAttribute('aria-label'), /刷新失败/);
  fail = false; const stale = view.refresh(); view.reset(); resolve(limits(99)); await stale;
  assert.equal(host.children.length, 0); assert.equal(host.hidden, true);
});
