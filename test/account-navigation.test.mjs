import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mountAccountLoginPanel } from '../public/account-login-panel.js';
import { mountAccountQuota } from '../public/account-quota.js';
import { mountAccount } from '../public/ui/account-view.js';
import { createAccountIdentityController } from '../public/account-identity.js';
import { createDocument } from './mini-dom.mjs';

// Exercise the actual app callback with real mounted components: a component-only
// quota test misses reset requests issued by the login panel's activation callback.
const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const loginMount = source.slice(source.indexOf('const accountLoginPanel='), source.indexOf('const statsView ='));
const accountEvents = source.slice(source.indexOf('function onEvent(message) {'), source.indexOf("  if(message.method==='thread/tokenUsage/updated')")) + '\n}';

test('app account navigation does not invalidate account data after a read-only login snapshot', async t => {
  const document = createDocument(), nodes = new Map();
  const $ = id => {
    if (!nodes.has(id)) { const node = document.createElement('div'); node.id = id; document.body.append(node); nodes.set(id, node); }
    return nodes.get(id);
  };
  const limits = { rateLimitsByLimitId: { codex: { primary: { usedPercent: 25, windowDurationMins: 300 } } } };
  let email = 'same@example.test', onEvent;
  const rpc = async method => {
    if (method === 'account/read') {
      // The native engine can emit this summary notification during an ordinary read.
      onEvent?.({ method: 'account/updated', params: { authMode: 'chatgpt', planType: 'plus' } });
      return { account: { type: 'chatgpt', email, planType: 'plus' } };
    }
    return method === 'account/rateLimits/read' ? limits : { summary: { lifetimeTokens: 1000 } };
  };
  const accountQuota = mountAccountQuota($('account-quota'), { rpc }); t.after(() => accountQuota.stop());
  const accountIdentity = createAccountIdentityController({ rpc, onChange: () => resetAccountScopedViews(), onSame: () => accountView.refresh() });
  const accountView = mountAccount($('account-root'), { rpc: (method, params) => method === 'account/read' ? accountIdentity.read() : rpc(method, params), onQuota: result => accountQuota.update(result) });
  let resets = 0, snapshots = 0;
  const resetAccountScopedViews = () => { resets++; accountQuota.reset(); accountView.reset(); };
  const accountApi = async path => { assert.equal(path, '/api/account/snapshot'); snapshots++; return { state: 'idle', loginId: null }; };
  const refreshAccount = () => accountView.refresh();
  const accountLoginPanel = new Function('mountAccountLoginPanel', '$', 'accountApi', 'resetAccountScopedViews', 'refreshAccount', 'currentRoute', loginMount + '\nreturn accountLoginPanel;')(mountAccountLoginPanel, $, accountApi, resetAccountScopedViews, refreshAccount, 'account');
  t.after(() => accountLoginPanel.destroy());
  onEvent = new Function('accountQuota', 'eventSubscribers', 'resetAccountScopedViews', 'accountLoginPanel', 'accountIdentity', accountEvents + '\nreturn onEvent;')(accountQuota, new Set(), resetAccountScopedViews, accountLoginPanel, accountIdentity);
  accountQuota.start(); await accountQuota.refresh();
  const button = $('account-quota').querySelector('button'); button.focus();
  let avatar;
  for (let i = 0; i < 3; i++) {
    await Promise.all([accountView.activate(), accountLoginPanel.activate()]);
    await accountIdentity.verify();
    assert.equal($('account-quota').querySelector('button'), button);
    const shown = $('account-root').querySelector('.acct-avatar');
    if (avatar) assert.equal(shown, avatar); else avatar = shown;
    accountView.deactivate(); accountLoginPanel.deactivate();
  }
  assert.equal(snapshots, 3); assert.equal(resets, 0);

  // Genuine account-change/logout events retain the isolation boundary.
  email = 'changed@example.test';
  await onEvent({ method: 'account/updated', params: { authMode: 'chatgpt', planType: 'plus' } });
  assert.equal(resets, 1); assert.equal($('account-quota').hidden, true);
  assert.doesNotMatch($('account-root').textContent, /same@example/);
  onEvent({ method: 'bridge/accountLogin', params: { state: 'loggedOut', loginId: null } });
  assert.equal(resets, 2);
});
