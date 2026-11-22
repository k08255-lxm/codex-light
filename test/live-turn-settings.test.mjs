import test from 'node:test';
import assert from 'node:assert/strict';
import { DemoClient } from '../src/demo.mjs';
import { MUTATING_METHODS, OperationStore } from '../src/operations.mjs';
import { validateRpc } from '../src/security.mjs';
import { ThreadSessions } from '../src/thread-sessions.mjs';

const method = 'turn/settings/update';
const target = { threadId: 'owned', turnId: 'running' };
const unavailable = { status: 'targetUnavailable' };

test('live settings expose only model, effort and service tier and distinguish unset from explicit clearing', () => {
  assert.ok(MUTATING_METHODS.has(method));
  assert.deepEqual(validateRpc(method, { ...target, model: null, effort: 'ultra', serviceTier: 'fast' }),
    { ...target, effort: 'ultra', serviceTier: 'priority' });
  for (const serviceTier of ['priority', 'default', null]) {
    assert.deepEqual(validateRpc(method, { ...target, serviceTier }), { ...target, serviceTier });
  }
  for (const patch of [{}, { model: null, effort: null }, { serviceTier: 'custom' }, { effort: '/high' },
    { model: 'x'.repeat(257) }, { model: '  ' }, { model: 'model\nname' }, { turnId: '', model: 'm' },
    { threadId: '', model: 'm' }]) assert.throws(() => validateRpc(method, { ...target, ...patch }));
  for (const key of ['approvalsReviewer', 'approvalPolicy', 'sandboxPolicy', 'environments', 'permissions', 'cwd', 'summary', 'input']) {
    assert.throws(() => validateRpc(method, { ...target, model: 'm', [key]: 'extra' }), /不支持参数/);
  }
});

test('only this bridge’s live turn receives a serialized update; replaying its request ID returns the same result', async () => {
  let apply, updates = 0;
  const sessions = new ThreadSessions({ async call(name) {
    if (name === 'turn/start') return { turn: { id: target.turnId, status: 'inProgress' } };
    if (name === method) {
      updates++;
      return new Promise(resolve => { apply = resolve; });
    }
    if (name === 'thread/resume' || name === 'thread/unsubscribe') return {};
    assert.fail(name);
  } });
  const params = { ...target, model: 'demo-five' };
  assert.deepEqual(await sessions.call(method, params), unavailable);
  await sessions.call('turn/start', { threadId: target.threadId });
  assert.deepEqual(await sessions.call(method, { ...params, turnId: 'different' }), unavailable);
  const operations = new OperationStore();
  const id = operations.serverInstance + ':' + Date.now() + ':live-update';
  const submit = () => operations.execute(id, method, params, () => sessions.call(method, params));
  const pending = submit(), replay = submit();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(updates, 1);
  const queued = sessions.call(method, { ...params, effort: 'high' });
  sessions.observe({ method: 'turn/completed', params: target });
  apply({ status: 'applied' });
  assert.deepEqual(await Promise.all([pending, replay, submit()]), Array(3).fill({ status: 'applied' }));
  assert.deepEqual(await queued, unavailable);
  assert.equal(updates, 1);
  await sessions.close();
});

test('native unavailable and unsupported methods stay distinct from unconfirmed replies', async () => {
  let response = unavailable;
  const sessions = new ThreadSessions({ async call(name) {
    if (name === 'turn/start') return { turn: { id: target.turnId } };
    if (name === method && response instanceof Error) throw response;
    return name === method ? response : {};
  } });
  await sessions.call('turn/start', { threadId: target.threadId });
  assert.deepEqual(await sessions.call(method, target), unavailable);
  response = Object.assign(new Error('method not found'), { code: -32601 });
  await assert.rejects(sessions.call(method, target), { code: -32601, outcome: 'notExecuted' });
  response = Object.assign(new Error('turn settings updates require the step_model_switching feature'), { code: -32600 });
  await assert.rejects(sessions.call(method, target), { code: 'TURN_SETTINGS_DISABLED', outcome: 'notExecuted' });
  response = {};
  await assert.rejects(sessions.call(method, target), { code: 'UNCONFIRMED_TURN_SETTINGS', outcome: 'unknown' });
  await sessions.close();
});

test('demo updates just the named live turn and does not create an inference or modify subsequent thread defaults', async t => {
  const demo = new DemoClient();
  t.after(() => demo.close());
  const { thread } = await demo.call('thread/start', { model: 'demo', cwd: process.cwd() });
  const { turn } = await demo.call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'synthetic' }] });
  const ids = { threadId: thread.id, turnId: turn.id };
  assert.deepEqual(await demo.call(method, { ...ids, model: 'demo-six', effort: 'ultra', serviceTier: 'priority' }), { status: 'applied' });
  await demo.call(method, { ...ids, serviceTier: null });
  assert.deepEqual(turn.settings, { model: 'demo-six', effort: 'ultra', serviceTier: null });
  assert.equal(thread.model, 'demo');
  assert.equal(demo.modelTurns.length, 1);
  await demo.call('turn/interrupt', ids);
  assert.deepEqual(await demo.call(method, { ...ids, model: 'demo-five' }), unavailable);
});
