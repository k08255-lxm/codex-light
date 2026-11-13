// Functional regressions for long bodies and long-history paging. No timing assertions (performance is measured separately).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ItemStore, TEXT_LIMITS, OMITTED_MARKER, retainBody } from '../public/store.js';
import { mountConversation, splitSegments, segmentSource, LONG_TEXT } from '../public/activity-feed.js';
import { TurnLedger, buildTurns, HistoryPager, historyCapabilities, isUnsupportedMethod } from '../public/state.js';
import { renderMarkdown } from '../public/markdown.js';
import { createDocument } from './mini-dom.mjs';
import { validateRpc } from '../src/security.mjs';

// Distinct markers spread through a synthetic body so order and completeness can be checked.
function body(length, tag = 'M') {
  const parts = []; let size = 0; let n = 0;
  while (size < length) { const p = `${tag}${String(n++).padStart(7, '0')} 段落文本 lorem ipsum ${'x'.repeat(40)}\n\n`; parts.push(p); size += p.length; }
  return parts.join('').slice(0, length - 8) + 'TAIL_END';
}
const walk = node => [node, ...node.children.flatMap(walk)];
const answerTurn = (text, complete = true) => {
  const ledger = new TurnLedger(); ledger.merge({ id: 't', status: complete ? 'completed' : 'inProgress' });
  return buildTurns([{ id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'q' }], _turnId: 't', _complete: true }, { id: 'a', type: 'agentMessage', phase: 'final_answer', text, _turnId: 't', _complete: complete }], ledger, { activeTurnId: complete ? null : 't' });
};
function mount() { const document = createDocument(); const host = document.createElement('div'); const copied = []; const view = mountConversation(host, { onCopy: async text => { copied.push(text); } }); return { document, host, view, copied }; }
const answerNode = host => host.querySelectorAll('.agentMessage').find(node => node.dataset.itemId === 'a');
const navButton = (host, text) => answerNode(host).querySelectorAll('button').find(button => button.textContent === text);

test('a 1,048,588-unit answer is stored whole and later deltas keep extending its tail', () => {
  const store = new ItemStore(300); const text = body(1048588);
  store.upsert({ id: 'a', type: 'agentMessage', text, _complete: true });
  assert.equal(store.items.get('a').text, text, 'nothing cut at the old 32 Ki display limit');
  assert.ok(store.items.get('a').text.endsWith('TAIL_END'));
  store.delta('a', '\nDELTA_ONE'); store.delta('a', '\nDELTA_TWO');
  assert.equal(store.items.get('a').text, text + '\nDELTA_ONE\nDELTA_TWO');
  assert.equal(store.items.get('a')._complete, false);
  assert.equal(store.textChars, text.length + 20);
});

test('a body beyond the per-item ceiling keeps its head and the latest tail, and states the omission exactly', () => {
  const store = new ItemStore(10); const big = body(TEXT_LIMITS.perField + 1000000, 'B');
  store.upsert({ id: 'x', type: 'commandExecution', aggregatedOutput: big, _complete: true });
  const kept = store.items.get('x').aggregatedOutput; const omitted = store.items.get('x')._omitted.aggregatedOutput;
  assert.ok(kept.includes(OMITTED_MARKER), 'explicit in-text marker, not silent loss');
  assert.ok(kept.startsWith(big.slice(0, 1000))); assert.ok(kept.endsWith('TAIL_END'));
  assert.equal(kept.length - OMITTED_MARKER.length + omitted, big.length, 'retained + omitted = received');
  // Streaming continues after the cut: every new delta is retained at the tail and the count stays exact.
  let total = big.length;
  for (let i = 0; i < 40; i++) { const delta = `\nchunk-${i} ` + 'y'.repeat(20000); store.delta('x', delta, 'commandExecution', 'aggregatedOutput'); total += delta.length; }
  const after = store.items.get('x');
  assert.ok(after.aggregatedOutput.endsWith('chunk-39 ' + 'y'.repeat(20000)));
  assert.equal(after.aggregatedOutput.split(OMITTED_MARKER).length, 2, 'one marker, not one per trim');
  assert.equal(after.aggregatedOutput.length - OMITTED_MARKER.length + after._omitted.aggregatedOutput, total);
  assert.ok(after.aggregatedOutput.length <= TEXT_LIMITS.perField + TEXT_LIMITS.slack);
  // A complete value replaces the record.
  store.upsert({ id: 'x', aggregatedOutput: 'done' }); assert.equal(store.items.get('x').aggregatedOutput, 'done'); assert.equal(store.items.get('x')._omitted, undefined);
});

test('retainBody never splits a surrogate pair', () => {
  const emoji = '😀'.repeat(TEXT_LIMITS.perField); const { text } = retainBody(emoji);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text));
});

test('the window text budget releases only older completed bodies, explicitly, and never the streaming one', () => {
  const store = new ItemStore(300); const size = 3 * 1024 * 1024; const per = body(size, 'R');
  for (let i = 0; i < 9; i++) store.upsert({ id: 'old' + i, type: 'agentMessage', text: per, _complete: true });
  store.delta('live', per);
  assert.ok(store.textChars <= TEXT_LIMITS.total);
  assert.equal(store.items.get('live').text, per, 'the streaming body is kept whole');
  assert.equal(store.items.get('old8').text, per, 'the newest completed body is kept whole');
  const released = store.values().filter(item => item._bodyReleased);
  assert.ok(released.length >= 1); assert.equal(released[0].id, 'old0', 'oldest first');
  assert.match(released[0].text, /已从当前窗口释放（原 \d+ 字符）。重新打开对话可再次读取完整内容/);
  // Window trimming and clear release the accounting too.
  store.clear(); assert.equal(store.textChars, 0); assert.equal(store.textSizes.size, 0);
});

test('user message text is retained beyond the old limit; only attachment metadata stays a bounded projection', () => {
  const store = new ItemStore(10); const text = body(200000, 'U');
  store.upsert({ id: 'u', type: 'userMessage', content: [{ type: 'text', text }, { type: 'localImage', path: 'C:/a.png' }], _complete: true });
  assert.equal(store.items.get('u').content[0].text, text); assert.equal(store.items.get('u').content[1].path, 'C:/a.png');
});

test('segments cover the body exactly and in order; streaming re-split equals a fresh split; fences are reopened', () => {
  const text = body(300000) + '\n```js\n' + 'const a = 1;\n'.repeat(4000) + '```\nafter';
  const split = splitSegments(text);
  assert.equal(split.segments[0].start, 0); assert.equal(split.segments.at(-1).end, text.length);
  for (let i = 1; i < split.segments.length; i++) assert.equal(split.segments[i].start, split.segments[i - 1].end);
  assert.ok(split.segments.every(row => row.end - row.start <= 3 * LONG_TEXT.segment));
  const inFence = split.segments.findIndex(row => row.fence);
  assert.ok(inFence > 0); assert.ok(segmentSource(split, inFence).startsWith('```js\n'));
  let incremental = splitSegments('');
  for (let at = 0; at < text.length; at += 7777) incremental = splitSegments(text.slice(0, at + 7777), { previous: incremental });
  assert.deepEqual(incremental.segments, split.segments);
  const oneLine = 'z'.repeat(200000); const lineSplit = splitSegments(oneLine);
  assert.equal(lineSplit.segments.map(row => oneLine.slice(row.start, row.end)).join(''), oneLine);
});

test('a 1 Mi answer renders a bounded window; every segment, including the tail, is reachable in order', async () => {
  const { host, view, copied } = mount(); const text = body(1048588);
  view.render(answerTurn(text));
  const node = answerNode(host);
  const segments = () => node.querySelectorAll('.long-text-segment');
  assert.equal(segments().length, LONG_TEXT.window, 'only a window of segments is in the DOM');
  assert.match(node.textContent, /第 1–3 段 \/ 共 \d+ 段/);
  const total = Number(/共 (\d+) 段/.exec(node.textContent)[1]);
  assert.ok(total > 20);
  // Walk forward through the whole body: markers appear once, in order, ending with the tail.
  const seen = new Set(); const order = [];
  for (let step = 0; step < total; step++) {
    for (const segment of segments()) { const index = Number(segment.dataset.segment); if (seen.has(index)) continue; seen.add(index); order.push(segment.textContent); }
    const next = navButton(host, '下一段'); if (next.disabled) break; next.click();
    assert.ok(segments().length <= LONG_TEXT.window, 'navigation never accumulates segments');
  }
  assert.equal(seen.size, total);
  const joined = order.join('');
  const markers = [...joined.matchAll(/M(\d{7})/g)].map(match => Number(match[1]));
  assert.equal(markers[0], 0); assert.ok(markers.every((value, index) => value === index), 'no gaps or reordering');
  assert.ok(joined.endsWith('TAIL_END'));
  navButton(host, '开头').click(); assert.match(node.textContent, /M0000000/);
  navButton(host, '最新').click(); assert.match(node.textContent, /TAIL_END/);
  await navButton(host, '复制全文').listeners.click[0]();
  assert.equal(copied[0], text, 'copy delivers the full retained body');
});

test('a streaming answer follows its tail; navigating away holds position until the user resumes following', () => {
  const { host, view } = mount(); let text = '';
  for (let i = 0; i < 60; i++) { text += `第${i}批 ` + 'w'.repeat(12000) + `\n\nEND_${i}\n\n`; view.render(answerTurn(text, false)); }
  assert.match(answerNode(host).textContent, /END_59/, 'live tail shown');
  assert.match(answerNode(host).textContent, /跟随最新/);
  navButton(host, '开头').click();
  text += 'NEW_TAIL_A'; view.render(answerTurn(text, false));
  assert.doesNotMatch(answerNode(host).textContent, /NEW_TAIL_A/, 'reading position is kept while text arrives');
  assert.match(answerNode(host).textContent, /第0批/);
  navButton(host, '跟随最新').click();
  text += ' NEW_TAIL_B'; view.render(answerTurn(text, false));
  assert.match(answerNode(host).textContent, /NEW_TAIL_B/);
  view.render(answerTurn(text, true));
  assert.match(answerNode(host).textContent, /NEW_TAIL_B/, 'completion while following stays at the tail');
});

test('short answers keep the plain structure; switching threads releases all rendered segments', () => {
  const { host, view } = mount();
  view.render(answerTurn('**短** 答复'));
  assert.equal(answerNode(host).querySelectorAll('.long-text-bar').length, 0);
  assert.equal(answerNode(host).querySelector('strong').textContent, '短');
  view.render(answerTurn(body(500000)));
  assert.ok(answerNode(host).querySelectorAll('.long-text-segment').length <= LONG_TEXT.window);
  view.clear(); assert.equal(host.children.length, 0);
  view.render([]); assert.equal(walk(host).length, 1);
});

test('command output is browsable in full inside the collapsed process', () => {
  const { host, view } = mount(); const output = body(400000, 'C');
  const ledger = new TurnLedger(); ledger.merge({ id: 't', status: 'completed' });
  view.render(buildTurns([{ id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'run' }], _turnId: 't', _complete: true }, { id: 'c', type: 'commandExecution', command: 'build', status: 'completed', exitCode: 0, aggregatedOutput: output, _turnId: 't', _complete: true }], ledger));
  const step = host.querySelector('details.step'); assert.equal(step.open, false, 'process stays collapsed by default');
  step.open = true;
  const detail = step.querySelector('div.step-command');
  assert.match(detail.textContent, /\$ build/); assert.match(detail.textContent, /M?C0000000/);
  detail.querySelectorAll('button').find(b => b.textContent === '最新').click();
  assert.match(detail.textContent, /TAIL_END/, 'the end of the output is reachable (it used to be cut at 16000)');
});

test('complete markdown mode shows over-limit content as full plain text instead of a truncated prefix', () => {
  const document = createDocument();
  const dense = Array.from({ length: 900 }, (_, i) => `# h${i}`).join('\n\n') + '\nLAST';
  const node = renderMarkdown(document, dense, { complete: true });
  assert.match(walk(node).map(n => n.textContent).join(''), /LAST/);
  assert.doesNotMatch(walk(node).map(n => n._text).join(''), /Markdown 显示已截断/);
  assert.ok(walk(node).some(n => n.tag === 'pre' && n.className === 'md-plain'));
  // Unsafe content stays inert in the plain fallback too.
  const plain = renderMarkdown(document, '[x](javascript:alert(1))\n'.repeat(500) + '# h\n\n'.repeat(500), { complete: true });
  assert.equal(walk(plain).filter(n => n.tag === 'a').length, 0);
});

// ---------- Replacement / edits must render the new content ----------

const answerItem = (text, complete = true) => ({ id: 'answer', type: 'agentMessage', phase: 'final_answer', _turnId: 'synthetic', _complete: complete, text });
function syntheticView() {
  const document = createDocument(); const host = document.createElement('div'); const copied = [];
  const view = mountConversation(host, { onCopy: async text => { copied.push(text); } });
  const ledger = new TurnLedger(); ledger.merge({ id: 'synthetic', status: 'completed' });
  const render = item => view.render(buildTurns([item], ledger));
  const bodyText = () => host.querySelector('.long-text-body').textContent;
  const node = () => host.querySelectorAll('.agentMessage').find(n => n.dataset.itemId === 'answer');
  const button = label => node().querySelectorAll('button').find(b => b.textContent === label);
  return { host, render, bodyText, node, button, copied };
}
const count = (text, char) => text.split(char).length - 1;

test('same-id equal-length replacement renders the new body (root acceptance case, 20 and 120000)', () => {
  for (const size of [20, 120000]) {
    const v = syntheticView();
    v.render(answerItem('A'.repeat(size))); assert.ok(count(v.bodyText(), 'A') > 0);
    v.render(answerItem('B'.repeat(size)));
    assert.equal(count(v.bodyText(), 'A'), 0, `size ${size}: no stale A`);
    assert.ok(count(v.bodyText(), 'B') >= Math.min(size, 3 * 3 * LONG_TEXT.segment), `size ${size}: new B content rendered`);
  }
});

test('non-prefix edits (middle change, deletion, prepend, shrink) re-render every visible segment', () => {
  const v = syntheticView(); const base = body(200000, 'E');
  v.render(answerItem(base));
  const firstMarker = /E0000000/;
  assert.match(v.bodyText(), firstMarker);
  // Same length, one marker changed inside the first visible segment.
  const changed = base.replace('E0000003', 'Z0000003'); assert.equal(changed.length, base.length);
  v.render(answerItem(changed)); assert.match(v.bodyText(), /Z0000003/); assert.doesNotMatch(v.bodyText(), /E0000003/);
  // Deletion in the middle of the visible window.
  const deleted = changed.replace(/E0000005[^\n]*\n\n/, ''); v.render(answerItem(deleted));
  assert.doesNotMatch(v.bodyText(), /E0000005/); assert.match(v.bodyText(), /E0000006/);
  // Prepend: everything shifts.
  v.render(answerItem('PREFIX_NEW\n\n' + deleted)); assert.match(v.bodyText(), /PREFIX_NEW/);
  // Shrink to a short body: plain structure, only the new text.
  v.render(answerItem('短的新答复')); assert.equal(v.bodyText(), '短的新答复');
  assert.equal(v.node().querySelectorAll('.long-text-bar').length, 0);
  // And back to a different long body.
  v.render(answerItem(body(100000, 'Q'))); assert.match(v.bodyText(), /Q0000000/); assert.doesNotMatch(v.bodyText(), /短的新答复|E000/);
});

test('streaming then a non-prefix final value replaces the streamed text; user messages and command output too', () => {
  const v = syntheticView();
  v.render(answerItem('draft '.repeat(5000), false));
  v.render(answerItem('final '.repeat(5000), true));
  assert.doesNotMatch(v.bodyText(), /draft/); assert.match(v.bodyText(), /final/);
  // User message bubble.
  const document = createDocument(); const host = document.createElement('div'); const view = mountConversation(host, {});
  const ledger = new TurnLedger(); ledger.merge({ id: 't', status: 'completed' });
  const user = text => view.render(buildTurns([{ id: 'u', type: 'userMessage', content: [{ type: 'text', text }], _turnId: 't', _complete: true }], ledger));
  user('X'.repeat(30)); user('Y'.repeat(30));
  assert.equal(host.querySelector('.message-bubble').textContent, 'Y'.repeat(30));
  // Command output (open step detail).
  const cmd = output => view.render(buildTurns([{ id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'q' }], _turnId: 't', _complete: true }, { id: 'c', type: 'commandExecution', command: 'x', status: 'completed', exitCode: 0, aggregatedOutput: output, _turnId: 't', _complete: true }], ledger));
  cmd('1'.repeat(50000)); const step = host.querySelector('details.step'); step.open = true;
  cmd('2'.repeat(50000));
  const out = step.querySelector('div.step-command').textContent;
  assert.equal(count(out, '1'), 0); assert.ok(count(out, '2') > 0);
});

test('append-only streaming reuses already rendered earlier segments (bounded re-render), and only the open tail changes', () => {
  const v = syntheticView(); let text = '';
  for (let i = 0; i < 12; i++) text += `S${i} ` + 'w'.repeat(12000) + '\n\n';
  v.render(answerItem(text, false));
  const bySegment = () => new Map(v.node().querySelectorAll('.long-text-segment').map(n => [n.dataset.segment, n]));
  const before = bySegment();
  assert.equal(before.size, LONG_TEXT.window);
  text += 'small tail growth'; v.render(answerItem(text, false));
  const after = bySegment();
  const kept = [...after.keys()].filter(key => before.has(key));
  assert.ok(kept.length >= 1);
  // Segments that were complete before the append keep their node; only the (previously open) last one is rebuilt.
  const lastBefore = String(Math.max(...[...before.keys()].map(Number)));
  for (const key of kept) if (key !== lastBefore) assert.equal(after.get(key), before.get(key), `segment ${key} node reused on append`);
  assert.match([...after.values()].at(-1).textContent, /small tail growth/);
});

test('rolling tail trim beyond the per-item ceiling: newest tail rendered, status and copy say the body is incomplete', async () => {
  const store = new ItemStore(10); const v = syntheticView();
  store.upsert({ id: 'answer', type: 'agentMessage', phase: 'final_answer', _turnId: 'synthetic', text: body(TEXT_LIMITS.perField - 1000, 'H'), _complete: false });
  v.render(store.items.get('answer'));
  for (let i = 0; i < 6; i++) { store.delta('answer', '\n\n' + 'r'.repeat(200000) + ` ROLL_${i}`); v.render(store.items.get('answer')); }
  const item = store.items.get('answer'); assert.ok(item._omitted?.text > 0, 'the store did trim');
  assert.match(v.bodyText(), /ROLL_5/, 'latest tail visible after trims');
  assert.match(v.node().textContent, /未完整保留：中间 [\d,]+ 字符超过单条保留上限，未保留/);
  const copy = v.node().querySelector('.long-text-copy');
  assert.equal(copy.textContent, '复制保留部分'); assert.match(copy.title, /不是原始全文/);
  await copy.listeners.click[0]();
  assert.equal(v.copied[0], item.text, 'copies exactly what is retained'); assert.ok(v.copied[0].includes(OMITTED_MARKER));
  assert.equal(copy.textContent, '已复制保留部分');
  // A complete replacement value restores the complete state.
  store.upsert({ ...item, text: '完整的新正文 '.repeat(3000), _complete: true }); v.render(store.items.get('answer'));
  assert.doesNotMatch(v.node().textContent, /未完整保留/); assert.equal(v.node().querySelector('.long-text-copy'), null, 'short complete body: plain structure');
  assert.match(v.bodyText(), /完整的新正文/); assert.doesNotMatch(v.bodyText(), /ROLL_|HL?\d{7}/);
  // Long and complete again: full-text label returns.
  store.upsert({ ...item, text: body(200000, 'K'), _complete: true }); v.render(store.items.get('answer'));
  assert.equal(v.node().querySelector('.long-text-copy').textContent, '复制全文');
});
test('a short body that is incomplete still shows its status and an honest copy action', () => {
  const v = syntheticView();
  v.render({ ...answerItem('开头保留部分' + RELEASED_SAMPLE), _released: { text: 5000000 }, _bodyReleased: true });
  assert.match(v.node().textContent, /未完整保留：原 5,000,000 字符的正文已从当前窗口释放/);
  assert.equal(v.node().querySelector('.long-text-copy').textContent, '复制保留部分');
  assert.equal(v.node().querySelector('.long-text-position').hidden, true, 'no segment navigator for a single segment');
});
const RELEASED_SAMPLE = '\n\n…〔为控制界面内存，此条较早正文的其余部分已从当前窗口释放〕';

test('a released body states it, labels its copy honestly, and survives a window rebuild with its record', async () => {
  const store = new ItemStore(300); const per = body(3 * 1024 * 1024, 'R');
  for (let i = 0; i < 9; i++) store.upsert({ id: 'old' + i, type: 'agentMessage', text: per, _complete: true });
  const released = store.items.get('old0');
  assert.deepEqual(released._released, { text: per.length });
  store.replaceWindow(store.values()); assert.deepEqual(store.items.get('old0')._released, { text: per.length }, 'record kept through replaceWindow');
  const v = syntheticView();
  v.render({ ...store.items.get('old0'), id: 'answer', phase: 'final_answer', _turnId: 'synthetic' });
  assert.match(v.node().textContent, new RegExp(`原 ${per.length.toLocaleString('zh-CN')} 字符的正文已从当前窗口释放`));
  const copy = v.node().querySelector('.long-text-copy');
  assert.equal(copy.textContent, '复制保留部分'); assert.match(copy.title, /重新打开对话可再次读取/);
  await copy.listeners.click[0](); assert.equal(v.copied[0], store.items.get('old0').text);
  // New full text for that id clears the released record.
  store.upsert({ id: 'old0', text: 'fresh' }); assert.equal(store.items.get('old0')._released, undefined); assert.equal(store.items.get('old0')._bodyReleased, undefined);
});

test('an ordinary 1 Mi body is complete: no incomplete status, copy label/feedback say full text', async () => {
  const v = syntheticView(); const text = body(1048588);
  v.render(answerItem(text));
  assert.doesNotMatch(v.node().textContent, /未完整保留/);
  const copy = v.node().querySelector('.long-text-copy'); assert.equal(copy.textContent, '复制全文'); assert.match(copy.title, /完整正文（1,048,588 字符）/);
  await copy.listeners.click[0](); assert.equal(v.copied[0], text); assert.equal(copy.textContent, '已复制全文');
});

// ---------- History paging ----------

const turnsFixture = count => Array.from({ length: count }, (_, i) => ({ id: 'T' + i, status: i === count - 1 ? 'inProgress' : 'completed', items: [{ id: `u${i}`, type: 'userMessage', content: [{ type: 'text', text: 'q' + i }] }, { id: `a${i}`, type: 'agentMessage', text: 'a' + i }] }));
function cliStub({ items = false, turns = true, read = true, fixture = turnsFixture(45) } = {}) {
  const calls = [];
  const unsupported = method => Object.assign(new Error(`${method} is not supported yet`), { code: -32601 });
  const rpc = async (method, params) => {
    calls.push([method, structuredClone(params)]);
    if (method === 'thread/items/list') { if (!items) throw unsupported(method); const all = fixture.flatMap(t => t.items.map(item => ({ item, turnId: t.id }))).reverse(); const start = Number(params.cursor || 0); return { data: all.slice(start, start + params.limit), nextCursor: start + params.limit < all.length ? String(start + params.limit) : null }; }
    if (method === 'thread/turns/list') {
      if (!turns) throw unsupported(method);
      assert.equal(params.itemsView, 'full'); assert.equal(params.sortDirection, 'desc');
      const all = [...fixture].reverse(); const start = Number(params.cursor || 0);
      return { data: all.slice(start, start + params.limit), nextCursor: start + params.limit < all.length ? String(start + params.limit) : null };
    }
    if (method === 'thread/read') { if (!read) throw unsupported(method); assert.equal(params.includeTurns, true); return { thread: { id: 'th', turns: fixture } }; }
    throw new Error('unexpected ' + method);
  };
  return { rpc, calls };
}
const ids = items => items.map(item => item.id);

test('when thread/items/list is unsupported, history pages through thread/turns/list itemsView:full with its cursor', async () => {
  const { rpc, calls } = cliStub(); const caps = historyCapabilities();
  const pager = new HistoryPager(rpc, 'th', caps);
  const first = await pager.next({ max: 80 });
  assert.equal(first.mode, 'turns');
  assert.deepEqual(calls.map(c => c[0]), ['thread/items/list', 'thread/turns/list'], 'no full thread/read');
  assert.equal(first.items.length, 80); assert.equal(first.items.at(-1).id, 'a44', 'newest last');
  assert.deepEqual(ids(first.items).slice(0, 2), ['u5', 'a5']);
  assert.ok(first.items.every(item => item._turnId === 'T' + item.id.slice(1) && item._complete === true));
  assert.equal(first.activeTurnId, 'T44'); assert.equal(first.hasMore, true);
  assert.ok(first.turns.some(turn => turn.id === 'T44'), 'turn metadata comes with the page');
  const older = await pager.next({ max: 80 });
  assert.deepEqual(ids(older.items), ['u0', 'a0', 'u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u4', 'a4'], 'buffered + older, nothing dropped or repeated');
  assert.equal(older.hasMore, false);
  assert.ok(calls.filter(c => c[0] === 'thread/turns/list').every((c, i) => i === 0 ? c[1].cursor === undefined : typeof c[1].cursor === 'string'));
  // The capability is remembered: the next thread skips the unsupported method.
  calls.length = 0; await new HistoryPager(rpc, 'th', caps).next();
  assert.equal(calls[0][0], 'thread/turns/list');
});

test('thread/items/list stays the first choice when supported', async () => {
  const { rpc, calls } = cliStub({ items: true });
  const pager = new HistoryPager(rpc, 'th');
  const page = await pager.next({ max: 80 });
  assert.equal(page.mode, 'items'); assert.deepEqual(calls.map(c => c[0]), ['thread/items/list']);
  assert.equal(page.items.length, 80); assert.equal(page.items.at(-1).id, 'a44'); assert.equal(page.hasMore, true);
  const next = await pager.next({ max: 80 }); assert.equal(next.items.length, 10); assert.equal(calls[1][1].cursor, '80');
});

test('default history shows 300 items through safe API pages and preserves the older cursor', async () => {
  const fixture = turnsFixture(220), { rpc, calls } = cliStub({ items: true, fixture });
  const pager = new HistoryPager(rpc, 'th');
  const first = await pager.next();
  assert.equal(first.items.length, 300);
  assert.equal(first.items[0].id, 'u70'); assert.equal(first.items.at(-1).id, 'a219');
  assert.deepEqual(calls.map(([, params]) => [params.cursor, params.limit]), [[undefined,100],['100',100],['200',100]]);
  assert.equal(first.hasMore, true);
  const older = await pager.next();
  assert.equal(older.items.length, 140); assert.equal(older.hasMore, false);
  const loaded = [...older.items, ...first.items];
  assert.deepEqual(ids(loaded), fixture.flatMap(turn => turn.items.map(item => item.id)));
  assert.equal(new Set(ids(loaded)).size, 440);
  for (const [method, params] of calls) assert.doesNotThrow(()=>validateRpc(method,params));
});

test('history stops after four API pages even when the server returns fewer items than requested', async () => {
  let count = 0;
  const pager = new HistoryPager(async (_method, params) => {
    assert.ok(params.limit <= 100);
    return { data: [{ item: { id: `i${++count}`, type:'agentMessage', text:'history' }, turnId:'t' }], nextCursor:String(count) };
  }, 'th');
  const page = await pager.next();
  assert.equal(count, 4); assert.equal(page.items.length, 4); assert.equal(page.hasMore, true);
});

test('without any paging method, one explicit full read shows the newest turns and later pages state they re-read', async () => {
  const { rpc, calls } = cliStub({ turns: false });
  const pager = new HistoryPager(rpc, 'th');
  const first = await pager.next({ max: 80 });
  assert.equal(first.mode, 'read'); assert.equal(first.fullRead, true);
  assert.deepEqual(first.read, { totalTurns: 45, shownTurns: 40 });
  assert.equal(calls.filter(c => c[0] === 'thread/read').length, 1);
  assert.equal(first.items[0].id, 'u5'); assert.equal(first.items.at(-1).id, 'a44');
  assert.equal(first.turns.length, 45, 'all turn metadata'); assert.ok(first.turns.every(turn => turn.items === undefined), 'older items are not kept');
  assert.equal(first.hasMore, true); assert.equal(pager.nextNeedsFullRead, true);
  const second = await pager.next({ max: 80 });
  assert.equal(second.fullRead, true); assert.equal(second.items[0].id, 'u0'); assert.equal(second.items.at(-1).id, 'a4');
  assert.equal(second.hasMore, false);
  assert.equal(calls.filter(c => c[0] === 'thread/read').length, 2, 'one full read per explicit request, never more');
});

test('other history errors are surfaced, not converted into a full read', async () => {
  const rpc = async method => { throw Object.assign(new Error('Codex 尚未连接'), { code: 'NOT_CONNECTED' }); };
  await assert.rejects(new HistoryPager(rpc, 'th').next(), /尚未连接/);
  assert.equal(isUnsupportedMethod({ code: -32601 }), true);
  assert.equal(isUnsupportedMethod({ code: -32602, message: 'unknown variant `full`, expected `notLoaded`' }), true);
  assert.equal(isUnsupportedMethod({ code: -32602, message: 'cursor invalid' }), false);
  // A turns/list that ignores itemsView (no items array) is treated as unsupported, not as an empty history.
  const calls = [];
  const ignoring = async (method, params) => { calls.push(method); if (method === 'thread/items/list') throw Object.assign(new Error('x'), { code: -32601 }); if (method === 'thread/turns/list') return { data: [{ id: 'T0', status: 'completed' }], nextCursor: null }; return { thread: { turns: turnsFixture(2) } }; };
  const page = await new HistoryPager(ignoring, 'th').next();
  assert.equal(page.mode, 'read'); assert.equal(page.items.length, 4);
});
