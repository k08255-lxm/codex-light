import test from 'node:test';
import assert from 'node:assert/strict';
import { accountIdentityKey, createAccountIdentityController } from '../public/account-identity.js';

const account = (email = 'one@example.test', planType = 'plus', id = null) => ({ account: { type: 'chatgpt', email, planType }, ...(id ? { workspaceRouting: { chatgptAccountId: id, backendOrigin: 'https://chatgpt.com' } } : {}) });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('identity uses protocol account ID/email, never auth mode or plan as proof', () => {
  assert.equal(accountIdentityKey(account()), accountIdentityKey(account('ONE@example.test', 'prolite')));
  assert.notEqual(accountIdentityKey(account()), accountIdentityKey(account('two@example.test')));
  assert.notEqual(accountIdentityKey(account('one@example.test', 'plus', 'workspace-one')), accountIdentityKey(account('one@example.test', 'plus', 'workspace-two')));
  assert.equal(accountIdentityKey(account('old@example.test', 'plus', 'workspace-one')), accountIdentityKey(account('new@example.test', 'pro', 'workspace-one')));
  assert.ok(accountIdentityKey(account(null, 'plus', 'workspace-one')));
  for (const value of [{}, { account: null }, { account: { type: 'apiKey' } }, { account: { type: 'amazonBedrock' } }, account(null), { authMode: 'chatgpt', planType: 'plus' }]) assert.equal(accountIdentityKey(value), null);
});

test('same-account plan notifications refresh without invalidation; different email/workspace reset', async () => {
  let result = account(), resets = 0, refreshes = 0;
  const view = createAccountIdentityController({ rpc: async () => result, onChange: () => resets++, onSame: () => refreshes++ });
  await view.read(); result = account('one@example.test', 'prolite'); await view.verify();
  assert.equal(resets, 0); assert.equal(refreshes, 1);
  result = account('two@example.test', 'prolite'); await view.verify(); assert.equal(resets, 1);
  result = account('two@example.test', 'prolite', 'workspace-one'); await view.verify(); assert.equal(resets, 2);
  result = account('two@example.test', 'prolite', 'workspace-two'); await view.verify(); assert.equal(resets, 3);
});

test('a notification emitted by the first native identity read shares that read without resetting', async () => {
  const result = deferred(); let reads = 0, resets = 0, checks;
  const view = createAccountIdentityController({ rpc: () => { reads++; checks = view.verify(); return result.promise; }, onChange: () => resets++ });
  const initial = view.read(); await Promise.resolve();
  assert.equal(view.verify(), checks);
  result.resolve(account()); await Promise.all([initial, checks]);
  assert.equal(reads, 1); assert.equal(resets, 0);
});

test('unknown identity and failed verification safely clear old scopes and expose read errors', async () => {
  let result = account(), resets = 0, errors = 0;
  const view = createAccountIdentityController({ rpc: async () => { if (result instanceof Error) throw result; return result; }, onChange: () => resets++, onError: () => errors++ });
  await view.read(); result = { account: { type: 'apiKey' } }; await view.verify(); assert.equal(resets, 1);
  result = account(null); await view.verify(); assert.equal(resets, 2);
  result = new Error('offline'); await view.verify(); assert.equal(resets, 3); assert.equal(errors, 1);
});

test('reset invalidates stale verification and stale reads cannot replace the new identity', async () => {
  let result = account(), resets = 0;
  const view = createAccountIdentityController({ rpc: () => result, onChange: () => resets++ });
  await view.read(); const old = deferred(); result = old.promise;
  const stale = view.verify(); await Promise.resolve(); await Promise.resolve();
  view.reset(); result = account('new@example.test'); await view.read();
  old.resolve(account('stale@example.test')); await stale;
  await view.verify(); assert.equal(resets, 0);
});

test('duplicate notifications coalesce through the content refresh and do not recurse', async () => {
  let reads = 0, resets = 0, nested;
  const content = deferred();
  const view = createAccountIdentityController({ rpc: async () => { reads++; nested = view.verify(); return account(); }, onChange: () => resets++, onSame: () => content.promise });
  const first = view.verify(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(nested, first); assert.equal(view.verify(), first);
  content.resolve(); await first;
  assert.equal(reads, 1); assert.equal(resets, 0);
});
