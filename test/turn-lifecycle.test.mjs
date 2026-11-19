import test from 'node:test';
import assert from 'node:assert/strict';
import {ItemStore} from '../public/store.js';
import {TurnLedger, buildTurns} from '../public/state.js';

const largeChanges = () => Array.from({length: 4}, (_, index) => ({path: `file-${index}.txt`, kind: {type: 'update'}, diff: '@@ -1 +1 @@\n-a\n+' + 'x'.repeat(33000)}));
const user = (id, turnId) => ({id, type: 'userMessage', content: [{type: 'text', text: id}], _turnId: turnId, _complete: true});

test('a delayed history page restores native order around events already on screen', () => {
  const store = new ItemStore(Infinity), ledger = new TurnLedger();
  ledger.merge({id:'z-old',status:'completed',durationMs:960000});
  ledger.merge({id:'a-now',status:'inProgress'});
  const before = new Map(store.items);
  const steer = user('steer','a-now');
  store.upsert(steer);
  store.delta('activity','live');
  store.upsert({id:'event-only',type:'commandExecution',_turnId:'a-now'});
  store.mergeHistory([
    user('original','z-old'), {id:'answer',type:'agentMessage',_turnId:'z-old',phase:'final_answer',text:'finished'},
    user('next','a-now'), steer, {id:'activity',type:'agentMessage',_turnId:'a-now',text:'stale',_complete:true},
  ], {before});
  const turns = buildTurns(store.values(),ledger,{activeTurnId:'a-now'});
  assert.deepEqual(turns.map(turn=>turn.id),['z-old','a-now']);
  assert.deepEqual(turns[1].items.map(item=>item.id),['next','steer','activity','event-only']);
  assert.deepEqual(turns[1].segments.map(segment=>segment.steer),[false,true]);
  assert.equal(store.items.get('activity').text,'live');
  assert.equal(store.items.get('activity')._complete,false);
});

test('refresh keeps the previously loaded prefix and live suffix around a disjoint newest page', () => {
  const store = new ItemStore(Infinity);
  store.upsert(user('already-loaded','before'));
  const before = new Map(store.items);
  store.upsert(user('arrived-live','after'));
  store.mergeHistory([user('recent-history','middle')],{before,refresh:true});
  assert.deepEqual(store.values().map(item=>item.id),['already-loaded','recent-history','arrived-live']);
});

test('overlapping older history adds rows on both sides of a shared item and retains live data', () => {
  const store=new ItemStore(Infinity);
  const activity={id:'shared',type:'agentMessage',_turnId:'active',text:'current live text',_complete:false};
  store.upsert(activity);store.upsert(user('tail','active'));
  const page=[user('earlier','older'),user('prompt','active'),{...activity,text:'stale'},user('steer','active')];
  store.prependHistory(page);store.prependHistory(page);
  assert.deepEqual(store.values().map(item=>item.id),['earlier','prompt','shared','steer','tail']);
  assert.equal(store.items.get('shared').text,activity.text);
});

test('a bounded window trims from the chronological start after adding older history', () => {
  const store=new ItemStore(2);
  store.upsert(user('current','active'));store.upsert(user('steer','active'));
  store.prependHistory([user('old','before')]);
  assert.deepEqual(store.values().map(item=>item.id),['current','steer']);
});

test('large file edits retain the real turn ID and never create a second 19-second completed-looking turn', () => {
  const store = new ItemStore(Infinity, {preserveBodies: true}), ledger = new TurnLedger();
  ledger.merge({id: 'real-turn', status: 'inProgress', startedAt: 1000});
  store.upsert(user('initial-prompt', 'real-turn'));
  store.upsert({id: 'large-edit', type: 'fileChange', changes: largeChanges(), status: 'completed', _turnId: 'real-turn', _complete: true, _startedAtMs: 1001000, _completedAtMs: 1020000});
  store.upsert(user('steer', 'real-turn'));
  const edit = store.items.get('large-edit');
  assert.equal(edit._turnId, 'real-turn'); assert.equal(edit._complete, true); assert.equal(edit.status, 'completed');
  const turns = buildTurns(store.values(), ledger, {activeTurnId: 'real-turn'});
  assert.equal(turns.length, 1); assert.equal(turns[0].id, 'real-turn'); assert.equal(turns[0].status, 'running');
  assert.equal(turns[0].timing.kind, 'running'); assert.equal(turns[0].timing.startMs, 1000000);
  assert.equal(turns[0].segments.length, 2); assert.equal(turns[0].segments[1].steer, true);
});

test('node budget exhaustion cannot replace item identity, lifecycle primitives or null error', () => {
  const store = new ItemStore();
  const payload = Object.fromEntries(Array.from({length: 35}, (_, index) => ['field-' + index, Array.from({length: 50}, (_, id) => ({id, nested: ['x', 'y', 'z']}))]));
  store.upsert({result: payload, id: 'last-id', type: 'commandExecution', status: 'completed', phase: 'commentary', _turnId: 'real-turn', _complete: true, _startedAtMs: 10, _completedAtMs: 20, durationMs: 10, exitCode: 0, success: true, error: null});
  const item = store.items.get('last-id');
  for (const [key, expected] of Object.entries({id: 'last-id', type: 'commandExecution', status: 'completed', phase: 'commentary', _turnId: 'real-turn', _complete: true, _startedAtMs: 10, _completedAtMs: 20, durationMs: 10, exitCode: 0, success: true, error: null})) assert.equal(item[key], expected, key);
});

test('a large patch update preserves the original turn attribution and its eventual terminal state', () => {
  const store = new ItemStore(), ledger = new TurnLedger();
  ledger.merge({id: 'real-turn', status: 'inProgress'});
  store.upsert({id: 'edit', type: 'fileChange', changes: [], status: 'inProgress', _turnId: 'real-turn', _complete: false});
  store.upsert({id: 'edit', changes: largeChanges(), status: 'completed', _complete: true});
  ledger.merge({id: 'real-turn', status: 'completed', durationMs: 19000});
  const turns = buildTurns(store.values(), ledger);
  assert.equal(turns.length, 1); assert.equal(turns[0].status, 'completed'); assert.equal(turns[0].timing.durationMs, 19000);
});

test('late in-progress history cannot resurrect a terminal turn or reset its duration', () => {
  for (const status of ['completed', 'failed', 'interrupted']) {
    const ledger = new TurnLedger();
    ledger.merge({id: 'settled', status, startedAt: 10, completedAt: 20, durationMs: 10000}, {observedEndMs: 20000});
    ledger.merge({id: 'settled', status: 'inProgress', startedAt: 10, durationMs: 0});
    ledger.activate('settled', 30000);
    const turn = buildTurns([user('prompt', 'settled')], ledger, {activeTurnId: 'settled'})[0];
    assert.equal(turn.meta.status, status); assert.equal(turn.status, status); assert.equal(turn.finished, true); assert.equal(turn.timing.durationMs, 10000);
  }
});

test('distinct native turns and their real concurrent statuses remain independent', () => {
  const ledger = new TurnLedger();
  ledger.merge({id: 'long-running', status: 'inProgress', startedAt: 10});
  ledger.merge({id: 'short-completed', status: 'completed', durationMs: 19000});
  ledger.merge({id: 'other-running', status: 'inProgress', startedAt: 20});
  const turns = buildTurns([user('a', 'long-running'), user('b', 'short-completed'), user('c', 'other-running')], ledger, {activeTurnId: 'other-running'});
  assert.deepEqual(turns.map(turn => [turn.id, turn.status]), [['long-running', 'running'], ['short-completed', 'completed'], ['other-running', 'running']]);
});

test('replayed completion does not inflate a settled turn observed duration', () => {
  const ledger = new TurnLedger();
  ledger.merge({id: 'turn', status: 'inProgress'}, {observedStartMs: 1000});
  ledger.merge({id: 'turn', status: 'completed'}, {observedEndMs: 20000});
  ledger.merge({id: 'turn', status: 'completed'}, {observedEndMs: 2800000});
  assert.equal(buildTurns([user('prompt', 'turn')], ledger)[0].timing.durationMs, 19000);
});
