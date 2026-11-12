import test from 'node:test';
import assert from 'node:assert/strict';
import { mountConversation, describeItem, itemState } from '../public/activity-feed.js';
import { TurnLedger, buildTurns } from '../public/state.js';
import { createDocument, visibleText } from './mini-dom.mjs';

const user = (id, turnId, text) => ({ id, type: 'userMessage', content: [{ type: 'text', text }], _turnId: turnId, _complete: true });
const agent = (id, turnId, text, phase = null, complete = true) => ({ id, type: 'agentMessage', text, phase, _turnId: turnId, _complete: complete });
const cmd = (id, turnId, extra = {}) => ({ id, type: 'commandExecution', command: 'npm test', status: 'completed', exitCode: 0, aggregatedOutput: 'ok', _turnId: turnId, _complete: true, ...extra });
const change = (id, turnId, path, diff, status = 'completed') => ({ id, type: 'fileChange', status, changes: [{ path, kind: { type: 'update', move_path: null }, diff }], _turnId: turnId, _complete: status !== 'inProgress' });

function mount() {
  const document = createDocument(); const host = document.createElement('div');
  const links = []; const view = mountConversation(host, { onLocalLink: ref => links.push(ref), getCwd: () => 'C:\\proj' });
  return { document, host, view, links };
}
const q = (host, selector) => host.querySelectorAll(selector);

test('completed turn collapses commentary/reasoning/tools behind exact duration; final answer stays outside', () => {
  const ledger = new TurnLedger(); ledger.merge({ id: 't1', status: 'completed', durationMs: 18000 });
  const items = [user('u1', 't1', '整理文档'), agent('c1', 't1', '我先看一下文件。', 'commentary'), { id: 'r1', type: 'reasoning', summary: ['检查结构'], _turnId: 't1', _complete: true }, cmd('x1', 't1'), agent('f1', 't1', '已完成 **整理**。', 'final_answer')];
  const { host, view } = mount(); view.render(buildTurns(items, ledger));
  const process = q(host, '.turn-process')[0];
  assert.equal(process.open, false, 'finished process collapses by default');
  assert.equal(process.querySelector('.turn-process-label').textContent, '用时 18s');
  const answers = q(host, '.agentMessage').filter(node => !node.classList.contains('process-note'));
  assert.equal(answers.length, 1); assert.equal(answers[0].dataset.itemId, 'f1');
  assert.ok(!process.contains(answers[0]), 'final answer is outside the collapsed process');
  assert.ok(process.contains(q(host, '.process-note')[0]), 'commentary lives inside process');
  assert.equal(q(host, '.step').length, 2, 'reasoning + command are steps');
  assert.equal(answers[0].querySelector('strong').textContent, '整理');
});

test('running turn shows live elapsed time, keeps steps open and does not treat partial commentary as final', () => {
  const ledger = new TurnLedger(); ledger.merge({ id: 't2', status: 'inProgress', startedAt: 1000 });
  const items = [user('u', 't2', '跑测试'), agent('c', 't2', '先运行', 'commentary'), cmd('x', 't2', { status: 'inProgress', exitCode: null, _complete: false })];
  const { host, view } = mount(); view.render(buildTurns(items, ledger, { activeTurnId: 't2' }), { now: 1000 * 1000 + 65000 });
  const process = q(host, '.turn-process')[0];
  assert.equal(process.open, true); assert.equal(process.dataset.running, 'true');
  assert.equal(process.querySelector('.turn-process-label').textContent, '正在工作 · 1m 05s');
  view.tick(1000 * 1000 + 70000);
  assert.equal(process.querySelector('.turn-process-label').textContent, '正在工作 · 1m 10s');
  assert.equal(q(host, '.step')[0].querySelector('.step-state').textContent, '进行中');
});

test('user choice to expand survives re-render; completion collapses only untouched turns', () => {
  const ledger = new TurnLedger(); ledger.merge({ id: 'a', status: 'inProgress' }); ledger.merge({ id: 'b', status: 'inProgress' });
  const items = [user('ua', 'a', '1'), cmd('xa', 'a'), agent('fa', 'a', 'A', 'final_answer'), user('ub', 'b', '2'), cmd('xb', 'b'), agent('fb', 'b', 'B', 'final_answer')];
  const { host, view } = mount();
  view.render(buildTurns(items, ledger, {}));
  const [pa, pb] = q(host, '.turn-process');
  pa.open = false; // user explicitly collapses turn a while it runs
  ledger.merge({ id: 'a', status: 'completed', durationMs: 4000 }); ledger.merge({ id: 'b', status: 'completed', durationMs: 5000 });
  view.render(buildTurns(items, ledger));
  assert.equal(pa.open, false); assert.equal(pb.open, false, 'untouched running turn collapses on completion');
  pb.open = true; view.render(buildTurns(items, ledger));
  assert.equal(pb.open, true, 'user expansion of a finished turn is kept');
});

test('history without server duration uses item timestamps as approximate, and unknown stays unknown (not 0s)', () => {
  const ledger = new TurnLedger(); ledger.merge({ id: 'h', status: 'completed' });
  const approx = [user('u', 'h', 'x'), { ...cmd('c', 'h'), _startedAtMs: 1000, _completedAtMs: 13000 }, agent('f', 'h', 'done')];
  let { host, view } = mount(); view.render(buildTurns(approx, ledger));
  assert.equal(q(host, '.turn-process-label')[0].textContent, '用时约 12s');
  ({ host, view } = mount()); view.render(buildTurns([user('u', 'h', 'x'), cmd('c', 'h'), agent('f', 'h', 'done')], ledger));
  const label = q(host, '.turn-process-label')[0].textContent;
  assert.doesNotMatch(label, /0s/); assert.equal(label, '已处理 1 步');
});

test('legacy messages without phase: last agent message of a finished turn is the answer; running turn has none', () => {
  const ledger = new TurnLedger(); ledger.merge({ id: 'l', status: 'completed', durationMs: 2000 });
  const items = [user('u', 'l', 'x'), agent('a1', 'l', '中间说明'), cmd('c', 'l'), agent('a2', 'l', '结论')];
  const turns = buildTurns(items, ledger);
  assert.deepEqual(turns[0].segments[0].answers.map(item => item.id), ['a2']);
  assert.deepEqual(turns[0].segments[0].process.map(item => item.id), ['a1', 'c']);
  ledger.merge({ id: 'l', status: 'inProgress' });
  assert.deepEqual(buildTurns(items, ledger, { activeTurnId: 'l' })[0].segments[0].answers, []);
});

test('steered user messages stay attributed to the running turn and are marked', () => {
  const ledger = new TurnLedger(); ledger.merge({ id: 's', status: 'inProgress' });
  const items = [user('u1', 's', '开始'), cmd('c1', 's'), user('u2', 's', '顺便更新 README'), cmd('c2', 's')];
  const { host, view } = mount(); view.render(buildTurns(items, ledger, { activeTurnId: 's' }));
  assert.equal(q(host, '.turn').length, 1);
  const steer = q(host, '.userMessage').find(node => node.dataset.itemId === 'u2');
  assert.ok(steer.classList.contains('steer')); assert.match(steer.textContent, /运行中补充/);
  assert.equal(q(host, '.turn-process').length, 2);
});

test('interrupted and failed turns show their real status', () => {
  const ledger = new TurnLedger(); ledger.merge({ id: 'i', status: 'interrupted' }); ledger.merge({ id: 'f', status: 'failed', error: { message: 'quota' } });
  const { host, view } = mount(); view.render(buildTurns([user('u', 'i', 'a'), cmd('c', 'i'), user('v', 'f', 'b')], ledger));
  assert.deepEqual(q(host, '.turn-footer').map(node => node.textContent), ['已停止', '任务失败：quota']);
});

test('edited files card: count, +/- totals, first three then expand, real diff view', () => {
  const ledger = new TurnLedger(); ledger.merge({ id: 'd', status: 'completed', durationMs: 1000 });
  const items = [user('u', 'd', 'edit')];
  for (let i = 0; i < 5; i++) items.push(change('f' + i, 'd', `C:\\proj\\src\\file${i}.js`, `@@ -1 +1,2 @@\n-a\n+b\n+c\n`));
  items.push(change('dup', 'd', 'C:/proj/src/file0.js', '@@ -2 +2 @@\n-c\n+d\n'));
  const { host, view } = mount(); view.render(buildTurns(items, ledger, { cwd: 'C:\\proj' }));
  const card = q(host, '.files-card')[0];
  assert.equal(card.querySelector('.files-title').textContent, '已编辑 5 个文件');
  assert.equal(card.querySelector('.files-stats').textContent, '+11-6');
  assert.equal(q(card, '.file-row').length, 3);
  assert.equal(q(card, '.file-row')[0].querySelector('.file-name').textContent, 'src/file0.js');
  const more = card.querySelector('.files-more'); assert.equal(more.hidden, false); assert.match(more.textContent, /再显示 2 个文件/);
  more.click(); assert.equal(q(card, '.file-row').length, 5);
  q(card, '.file-row-head')[1].click();
  const diff = q(card, '.diff-view')[0]; assert.ok(diff); assert.equal(q(diff, '.diff-add').length, 2); assert.equal(q(diff, '.diff-del').length, 1);
  assert.equal(q(card, 'button').some(node => /撤销|Undo/.test(node.textContent)), false, 'no unsupported undo');
});

test('turn diff is authoritative and deduplicates; unknown per-file stats are shown as unknown', () => {
  const ledger = new TurnLedger(); ledger.merge({ id: 'g', status: 'completed', durationMs: 1 });
  ledger.setDiff('g', 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1,2 +1,2 @@\n-x\n+y\n z\ndiff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n');
  const items = [user('u', 'g', 'x'), change('c1', 'g', 'C:/proj/src/a.js', '@@ -1 +1 @@\n-x\n+q\n'), change('c2', 'g', 'C:/proj/src/a.js', '@@ -1 +1 @@\n-q\n+y\n')];
  const turn = buildTurns(items, ledger, { cwd: 'C:/proj' })[0];
  assert.equal(turn.files.count, 2);
  assert.deepEqual(turn.files.rows.map(row => [row.path, row.added, row.removed]), [['src/a.js', 1, 1], ['img.png', null, null]]);
  assert.equal(turn.files.added, null, 'aggregate is unknown when any file is unknown');
  const { host, view } = mount(); view.render([turn]);
  assert.match(q(host, '.files-stats')[0].textContent, /行数未知/);
});

test('live edits show 正在编辑 while the turn runs', () => {
  const ledger = new TurnLedger(); ledger.merge({ id: 'r', status: 'inProgress' });
  const turns = buildTurns([user('u', 'r', 'x'), change('c', 'r', 'C:/proj/a.md', '@@ -0,0 +1 @@\n+hi\n', 'inProgress')], ledger, { activeTurnId: 'r', cwd: 'C:/proj' });
  const { host, view } = mount(); view.render(turns);
  assert.equal(q(host, '.files-title')[0].textContent, '正在编辑 1 个文件');
});

test('streaming and completed agent text render the same safe Markdown with local file controls', () => {
  const ledger = new TurnLedger(); ledger.merge({ id: 'm', status: 'inProgress' });
  const md = '见 [sample.md](C:/Users/TestUser/demo-project/sample.md) <img src=x onerror=alert(1)>';
  const { host, view, links } = mount();
  view.render(buildTurns([user('u', 'm', 'x'), agent('a', 'm', md, 'final_answer', false)], ledger, { activeTurnId: 'm' }));
  let button = q(host, '.md-file-link')[0];
  assert.ok(button, 'streaming text already renders the file control');
  assert.equal(q(host, 'img').length + q(host, 'a').length, 0);
  ledger.merge({ id: 'm', status: 'completed', durationMs: 1 });
  view.render(buildTurns([user('u', 'm', 'x'), agent('a', 'm', md, 'final_answer', true)], ledger));
  button = q(host, '.md-file-link')[0];
  assert.equal(button.textContent, 'sample.md');
  assert.equal(button.getAttribute('data-path'), 'C:/Users/TestUser/demo-project/sample.md');
  button.click(); assert.equal(links.length, 1);
  assert.doesNotMatch(visibleText(host), /\]\(C:/, 'no literal markdown link syntax left');
});

test('step descriptions are concise and failures are explicit', () => {
  assert.deepEqual(describeItem({ type: 'commandExecution', command: 'git status', status: 'completed' }).verb, '已运行');
  assert.equal(describeItem({ type: 'commandExecution', command: 'cat a', commandActions: [{ type: 'read', path: 'C:/a/b.md', name: 'b.md' }], status: 'completed' }).target, 'b.md');
  assert.equal(itemState({ type: 'commandExecution', exitCode: 2, status: 'completed' }), 'failed');
  assert.equal(itemState({ type: 'mcpToolCall', status: 'inProgress' }), 'running');
});

test('rendering is keyed: re-render keeps nodes and never uses innerHTML', () => {
  const ledger = new TurnLedger(); ledger.merge({ id: 'k', status: 'completed', durationMs: 1 });
  const items = [user('u', 'k', 'x'), cmd('c', 'k'), agent('a', 'k', 'y', 'final_answer')];
  const { host, view } = mount(); view.render(buildTurns(items, ledger));
  const first = q(host, '.turn')[0]; const step = q(host, '.step')[0];
  view.render(buildTurns(items, ledger));
  assert.equal(q(host, '.turn')[0], first); assert.equal(q(host, '.step')[0], step);
  view.clear(); assert.equal(host.children.length, 0);
});
