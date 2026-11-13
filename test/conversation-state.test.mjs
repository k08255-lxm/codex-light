import test from 'node:test';
import assert from 'node:assert/strict';
import { FollowUpQueue, steerParams, contextSnapshot, contextView, slashQuery, replaceSlashToken, slashEntries, skillsFromResponse, parseUnifiedDiff, changeStats, fileSummary, formatDuration, turnTiming, SLASH_COMMANDS } from '../public/state.js';

test('steer params carry only threadId, expectedTurnId and input', () => {
  const params = steerParams('t', 'turn-1', '补充');
  assert.deepEqual(Object.keys(params).sort(), ['expectedTurnId', 'input', 'threadId']);
  assert.deepEqual(params.input, [{ type: 'text', text: '补充', text_elements: [] }]);
  assert.throws(() => steerParams('t', null, 'x'), /运行任务/);
});

test('queue is ordered per thread, drains only a queued head, and never mixes threads', () => {
  const q = new FollowUpQueue();
  const a1 = q.add('A', { text: 'a1', images: [{ id: 'img' }] }); const a2 = q.add('A', { text: 'a2' }); q.add('B', { text: 'b1' });
  assert.deepEqual(q.list('A').map(row => row.text), ['a1', 'a2']);
  assert.equal(q.next('A').id, a1.id); assert.equal(q.next('B').text, 'b1');
  assert.deepEqual(q.list('A')[0].images, [{ id: 'img' }], 'attachments travel with the item');
  q.update('A', a1.id, { status: 'sending' });
  assert.equal(q.next('A'), null, 'no second item while head is sending');
  assert.equal(q.remove('A', a1.id), null, 'cannot remove an item mid-send');
  q.update('A', a1.id, { status: 'unknown', error: 'timeout' });
  assert.equal(q.next('A'), null, 'unknown outcome blocks: no automatic duplicate submission');
  q.update('A', a1.id, { text: 'edited' }); assert.equal(q.list('A')[0].text, 'edited');
  assert.equal(q.remove('A', a1.id).id, a1.id); assert.equal(q.next('A').id, a2.id);
});

test('pause blocks draining for one thread or all threads until resumed', () => {
  const q = new FollowUpQueue(); q.add('A', { text: 'x' }); q.add('B', { text: 'y' });
  q.pause('A', '任务已停止'); assert.equal(q.next('A'), null); assert.equal(q.pausedReason('A'), '任务已停止'); assert.ok(q.next('B'));
  q.pauseAll('连接已断开'); assert.equal(q.next('B'), null);
  q.resume('A'); q.resume('B'); assert.ok(q.next('A')); assert.ok(q.next('B'));
  const empty = new FollowUpQueue(); empty.pause('Z'); assert.equal(empty.pausedReason('Z'), '', 'empty queue is not marked paused');
});

test('context uses the latest request snapshot and the real window, not cumulative totals', () => {
  const snapshot = contextSnapshot({ threadId: 't', turnId: 'u', tokenUsage: { total: { totalTokens: 900000 }, last: { totalTokens: 64000 }, modelContextWindow: 256000 } });
  assert.deepEqual(snapshot, { threadId: 't', turnId: 'u', used: 64000, window: 256000 });
  const view = contextView(snapshot); assert.equal(view.known, true); assert.equal(view.percentLeft, 75); assert.equal(view.label, '25%'); assert.equal(view.percentUsed,25);
  const unknownWindow = contextView(contextSnapshot({ threadId: 't', tokenUsage: { last: { totalTokens: 10 }, total: { totalTokens: 10 }, modelContextWindow: null } }));
  assert.equal(unknownWindow.known, false); assert.doesNotMatch(unknownWindow.label, /%/);
  assert.equal(contextView(null).known, false);
  assert.equal(contextView({ used: 300, window: 200 }).percentLeft, 0, 'over-full clamps to 0');
});

test('slash query is caret-local: start of draft or after whitespace, never inside words or URLs', () => {
  assert.deepEqual(slashQuery('/comp', 5), { query: 'comp', start: 0, end: 5 });
  assert.equal(slashQuery('/compact now', 12), null, 'caret after the token closes the menu');
  assert.deepEqual(slashQuery('hello /x'), { query: 'x', start: 6, end: 8 });
  assert.deepEqual(slashQuery('修改文件的时候会有这个小标吗 /'), { query: '', start: 15, end: 16 });
  assert.deepEqual(slashQuery('前面 /co 后面', 6), { query: 'co', start: 3, end: 6 });
  assert.deepEqual(slashQuery('前面 /co 后面', 5), { query: 'co', start: 3, end: 6 }, 'token extends past the caret to its end');
  for (const [text, caret] of [['a/b', 3], ['http://x', 8], ['', 0], ['C:/p', 4]]) assert.equal(slashQuery(text, caret), null, text);
});

test('replacing a slash token preserves the surrounding draft exactly', () => {
  const draft = '修改文件的时候会有这个小标吗 /';
  assert.deepEqual(replaceSlashToken(draft, slashQuery(draft), ''), { value: '修改文件的时候会有这个小标吗 ', caret: 15 });
  assert.deepEqual(replaceSlashToken(draft, slashQuery(draft), '$pdf'), { value: '修改文件的时候会有这个小标吗 $pdf ', caret: 20 });
  const middle = '前面 /co 后面';
  assert.deepEqual(replaceSlashToken(middle, slashQuery(middle, 6), ''), { value: '前面 后面', caret: 3 });
  assert.deepEqual(replaceSlashToken(middle, slashQuery(middle, 6), '$x'), { value: '前面 $x 后面', caret: 5 });
});

test('slash entries list only implemented commands and real enabled skills with honest availability', () => {
  const skills = skillsFromResponse({ data: [{ cwd: '/p', errors: [], skills: [{ name: 'pdf', description: 'PDF tools', enabled: true, path: '/s', scope: 'user', interface: { displayName: 'PDF', shortDescription: '处理 PDF' } }, { name: 'off', description: '', enabled: false, path: '/o', scope: 'user' }, { name: 'pdf', description: 'dup', enabled: true, path: '/d', scope: 'repo' }] }] });
  assert.deepEqual(skills.map(skill => skill.name), ['pdf', 'off']);
  const draft = slashEntries('', skills, { thread: false, busy: false, sending: false, connected: true });
  assert.deepEqual(draft.filter(e => e.kind === 'command').map(e => e.id), SLASH_COMMANDS.map(c => c.id));
  assert.equal(draft.find(e => e.id === 'compact').enabled, false, 'compact needs an existing thread');
  assert.deepEqual(draft.filter(e => e.kind === 'skill').map(e => e.label), ['$pdf']);
  const running = slashEntries('', skills, { thread: true, busy: true, sending: false, connected: true });
  assert.equal(running.find(e => e.id === 'compact').enabled, false); assert.equal(running.find(e => e.id === 'new').enabled, true);
  const idle = slashEntries('comp', [], { thread: true, busy: false, sending: false, connected: true });
  assert.deepEqual(idle.map(e => [e.id, e.enabled]), [['compact', true]]);
});

test('unified diff parsing handles headers, dashes inside hunks, new files and binaries', () => {
  const files = parseUnifiedDiff('diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n keep\n--- removed\n+++ added\n tail\ndiff --git a/new 文件.md b/new 文件.md\n--- /dev/null\n+++ b/new 文件.md\n@@ -0,0 +1,2 @@\n+x\n+y\ndiff --git a/b.bin b/b.bin\nBinary files a/b.bin and b/b.bin differ\n');
  assert.deepEqual(files.map(f => [f.path, f.added, f.removed]), [['a.txt', 1, 1], ['new 文件.md', 2, 0], ['b.bin', null, null]]);
  assert.deepEqual(changeStats({ kind: { type: 'add' }, diff: 'a\nb\n' }), { added: 2, removed: 0 });
  assert.deepEqual(changeStats({ kind: { type: 'delete' }, diff: 'a\n' }), { added: 0, removed: 1 });
  assert.deepEqual(changeStats({ kind: { type: 'update' }, diff: '' }), { added: null, removed: null });
});

test('file summary deduplicates the same file across items by normalized path and skips declined patches', () => {
  const s = fileSummary([
    { type: 'fileChange', status: 'completed', changes: [{ path: 'C:\\p\\A.js', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b\n' }] },
    { type: 'fileChange', status: 'completed', changes: [{ path: 'c:/p/a.js', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-b\n+c\n' }] },
    { type: 'fileChange', status: 'declined', changes: [{ path: 'C:/p/z.js', kind: { type: 'add' }, diff: 'z\n' }] },
  ], undefined, { cwd: 'C:\\p' });
  assert.equal(s.count, 1); assert.equal(s.rows[0].path, 'A.js'); assert.equal(s.added, 2); assert.equal(s.removed, 2);
});

test('durations are formatted, unknown durations are not zero', () => {
  assert.equal(formatDuration(18000), '18s'); assert.equal(formatDuration(3725000), '1h 02m'); assert.equal(formatDuration(null), '');
  assert.deepEqual(turnTiming({ status: 'completed' }, []), { kind: 'done', durationMs: null, approximate: false });
  assert.equal(turnTiming({ startedAtMs: 1000, completedAtMs: 4000 }, []).durationMs, 3000);
  assert.equal(turnTiming({ observedStartMs: 5 }, [], { running: true }).startMs, 5);
});
