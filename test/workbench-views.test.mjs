import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument } from './mini-dom.mjs';
import { pastedFiles, classifyPaste, isImageFile } from '../public/ui/paste.js';
import { artifactCandidates, markdownImageRefs, mountArtifacts } from '../public/ui/artifacts.js';
import { nativeAgents, agentLifecycle, renderNativeAgent } from '../public/ui/agents.js';
import { pillChanges } from '../public/ui/live-changes.js';
import { mountStatistics, statisticsQuery, costCoverage } from '../public/ui/stats-view.js';
import { quotaBuckets, windowView, mountAccount } from '../public/ui/account-view.js';
import { buildTurns, TurnLedger } from '../public/state.js';
import { niceMax, barChart, chartLayout, labelStep } from '../public/ui/chart.js';

// ---------- Paste (synthetic DataTransfer objects; does not exercise the OS clipboard) ----------
const file = (name, type, size = 10, lastModified = 1) => ({ name, type, size, lastModified });
test('paste prefers items, falls back to files, keeps distinct same-metadata files, ignores strings', () => {
  const shot = file('image.png', 'image/png', 100);
  const data = { files: [shot], items: [{ kind: 'file', getAsFile: () => shot }, { kind: 'string', type: 'text/html', getAsFile: () => null }, { kind: 'file', getAsFile: () => file('a.pdf', 'application/pdf') }] };
  assert.deepEqual(pastedFiles(data).map(f => f.name), ['image.png', 'a.pdf'], 'items win; files are not added again');
  assert.deepEqual(pastedFiles({ files: [shot], items: [] }).map(f => f.name), ['image.png'], 'files fallback when items expose none');
  const twinA = file('same.txt', 'text/plain', 5, 1), twinB = file('same.txt', 'text/plain', 5, 1);
  assert.equal(pastedFiles({ items: [{ kind: 'file', getAsFile: () => twinA }, { kind: 'file', getAsFile: () => twinB }] }).length, 2, 'two real files with identical metadata are both kept');
  assert.deepEqual(pastedFiles({ files: [], items: [{ kind: 'string', type: 'text/plain' }] }), [], 'text-only paste yields nothing → native paste');
  assert.deepEqual(pastedFiles(null), []);
});
test('paste batch is validated as a whole: mixed classes, empty MIME, zero size, unsupported image, limit', () => {
  const now = new Date('2026-11-12T06:00:00Z');
  const ok = classifyPaste([file('image.png', 'image/png'), file('note.txt', 'text/plain'), file('拍照.JPG', '')], 0, now);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.images.map(r => r.name), ['粘贴的图片-2026-11-12060000-1.png', '拍照.JPG']);
  assert.deepEqual(ok.files.map(r => r.name), ['note.txt']);
  assert.equal(isImageFile(file('x.webp', '')), true); assert.equal(isImageFile(file('x.bmp', '')), false);
  assert.match(classifyPaste([file('empty.png', 'image/png', 0)], 0).errors[0], /为空/);
  assert.match(classifyPaste([file('x.tiff', 'image/tiff')], 0).errors[0], /不支持的图片格式/);
  assert.match(classifyPaste([file('big.png', 'image/png', 11 * 1024 * 1024)], 0).errors[0], /10 MiB/);
  const over = classifyPaste([file('a.png', 'image/png'), file('b.txt', 'text/plain')], 4);
  assert.match(over.errors[0], /合计最多 5 个/, 'limit counts existing attachments and the whole batch');
});

// ---------- Artifacts ----------
test('artifact candidates come only from typed fields; prose and remote URLs are ignored', () => {
  assert.deepEqual(artifactCandidates({ id: 'g', type: 'imageGeneration', status: 'completed', result: 'iVBOR...', savedPath: 'C:/p/out/icon.png', revisedPrompt: 'a flat icon' }).map(c => [c.kind, c.path, c.status]), [['generated', 'C:/p/out/icon.png', 'done']]);
  const noPath = artifactCandidates({ id: 'g2', type: 'imageGeneration', status: 'completed', result: 'abc' })[0];
  assert.equal(noPath.path, null); assert.match(noPath.reason, /没有提供本地保存路径/, 'result is never assumed to be a path or base64');
  assert.equal(artifactCandidates({ id: 'g3', type: 'imageGeneration', status: 'failed', failure: { message: 'x' }, savedPath: 'a.png' })[0].status, 'failed');
  assert.deepEqual(artifactCandidates({ id: 'v', type: 'imageView', path: 'assets/中文 图标.svg' }).map(c => c.path), ['assets/中文 图标.svg']);
  const mcp = artifactCandidates({ id: 'm', type: 'mcpToolCall', result: { content: [{ type: 'text', text: 'saved to C:/p/x.png' }], structuredContent: { output: { imagePath: 'C:/p/y.png' }, url: 'https://evil.example/z.png', path: 'https://cdn/x.png' } } });
  assert.deepEqual(mcp.map(c => c.path), ['C:/p/y.png']);
  assert.deepEqual(artifactCandidates({ id: 'a', type: 'agentMessage', text: '![x](a.png)' }), []);
  assert.deepEqual(markdownImageRefs('![图标](assets/icon.svg) ![r](https://x/y.png) ![d](data:image/png;base64,AAA) ![t](<docs/图 1.png>) [not](a.png)').map(r => r.path), ['assets/icon.svg', 'docs/图 1.png']);
});
test('artifact cards render <img> from blob URLs, show honest failure, open the viewer, and revoke on clear', async () => {
  const document = createDocument(); const created = []; const revoked = [];
  globalThis.URL.createObjectURL = blob => { const url = 'blob:test/' + created.length; created.push(blob); return url; };
  globalThis.URL.revokeObjectURL = url => revoked.push(url);
  const opened = [];
  const view = mountArtifacts({ document, fetchPreview: async path => { if (path.includes('outside')) throw new Error('文件不在项目目录内'); return { blob: { path }, width: 64, height: 32 }; }, onOpen: v => opened.push(v) });
  const strip = view.strip([{ key: 'a', kind: 'generated', path: 'out/icon.svg', status: 'done', caption: '图标' }, { key: 'b', kind: 'viewed', path: 'C:/outside/a.png', status: 'done' }, { key: 'c', kind: 'generated', path: null, status: 'done', reason: '生成结果没有提供本地保存路径' }]);
  await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0));
  const cards = strip.querySelectorAll('.artifact');
  const img = cards[0].querySelector('img'); assert.ok(img); assert.equal(img.src, 'blob:test/0'); assert.equal(cards[0].querySelector('.artifact-meta').textContent, '64×32');
  assert.equal(cards[0].querySelectorAll('svg').length, 0, 'SVG artifacts are never inlined');
  assert.equal(cards[1].dataset.state, 'unavailable'); assert.match(cards[1].textContent, /不在项目目录内/);
  assert.equal(cards[2].dataset.state, 'unavailable'); assert.equal(cards[2].querySelectorAll('img').length, 0);
  cards[0].querySelector('.artifact-frame').click(); assert.equal(opened[0].url, 'blob:test/0'); assert.equal(opened[0].name, 'icon.svg');
  view.clear(); assert.deepEqual(revoked, ['blob:test/0']); assert.equal(view.size(), 0);
});

// ---------- Native subagents ----------
test('native agent lifecycle uses typed agent state; a completed tool call is not a completed agent', () => {
  const spawn = { id: 'c1', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', senderThreadId: 'p', receiverThreadIds: ['a1'], agentsStates: { a1: { status: 'running', message: null } }, prompt: '写测试', model: 'gpt-x', reasoningEffort: 'high', _completedAtMs: 1000 };
  let [agent] = nativeAgents([spawn]);
  assert.equal(agentLifecycle(agent).label, '运行中'); assert.equal(agent.requestedModel, 'gpt-x'); assert.equal(agent.requestedEffort, 'high');
  const wait = { id: 'c2', type: 'collabAgentToolCall', tool: 'wait', status: 'completed', receiverThreadIds: ['a1'], agentsStates: { a1: { status: 'completed', message: '已完成：3 个测试' } } };
  [agent] = nativeAgents([spawn, wait]); assert.equal(agentLifecycle(agent).label, '已完成'); assert.equal(agent.message, '已完成：3 个测试');
  const unknown = nativeAgents([{ id: 'c3', type: 'collabAgentToolCall', tool: 'sendInput', status: 'completed', receiverThreadIds: ['b'], agentsStates: {} }])[0];
  assert.equal(agentLifecycle(unknown).label, '状态未知', 'tool status completed does not imply agent completion');
  assert.equal(unknown.requestedModel, null, 'model is never inherited');
  const activity = nativeAgents([{ id: 's', type: 'subAgentActivity', agentThreadId: 'z', agentPath: 'reviewer', kind: 'interacted' }])[0];
  assert.equal(agentLifecycle(activity).label, '有交互'); assert.equal(activity.path, 'reviewer');
  // Chronological folding: a newer typed activity beats an older snapshot; interacted never overrides.
  const seq = items => agentLifecycle(nativeAgents(items)[0]).label;
  const running = { ...spawn, agentsStates: { a1: { status: 'running' } } };
  const act = kind => ({ id: 'act-' + kind, type: 'subAgentActivity', agentThreadId: 'a1', agentPath: 'w', kind });
  assert.equal(seq([running, act('completed')]), '已完成');
  assert.equal(seq([running, act('interrupted')]), '已中断');
  assert.equal(seq([running, act('completed'), act('interacted')]), '已完成', 'interacted does not resume a finished agent');
  assert.equal(seq([act('completed'), running]), '运行中', 'a newer running snapshot wins over older completion');
  assert.equal(seq([act('interacted')]), '有交互');
  const card = renderNativeAgent(createDocument(), agent, { now: 61000 });
  assert.match(card.textContent, /请求模型gpt-x/); assert.match(card.textContent, /1 分钟前/); assert.equal(card.dataset.tone, 'ok');
});
test('conversation renders native agents and artifacts outside the collapsed process', async () => {
  const { mountConversation } = await import('../public/activity-feed.js');
  const document = createDocument(); const host = document.createElement('div');
  const artifacts = mountArtifacts({ document, fetchPreview: async () => ({ blob: {}, width: 1, height: 1 }), onOpen() {} });
  const opened=[];const view = mountConversation(host, { artifacts,onOpenAgent:(...args)=>opened.push(args) });
  const ledger = new TurnLedger(); ledger.merge({ id: 't', status: 'completed', durationMs: 5000 });
  const items = [{ id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'x' }], _turnId: 't' },
    { id: 'c', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', receiverThreadIds: ['a'], agentsStates: { a: { status: 'running' } }, _turnId: 't', _complete: true },
    { id: 'g', type: 'imageGeneration', status: 'completed', savedPath: 'out/a.png', result: '', _turnId: 't', _complete: true },
    { id: 'f', type: 'agentMessage', phase: 'final_answer', text: '完成 ![预览](out/b.png)', _turnId: 't', _complete: true }];
  view.render(buildTurns(items, ledger));
  const process = host.querySelector('.turn-process'); assert.equal(process.open, false);
  const agentStep=process.querySelector('.step');agentStep.querySelector('summary').click();assert.deepEqual(opened,[['a','native']]);
  const strip = host.querySelector('.artifact-strip');
  assert.equal(host.querySelector('.agent-list'),null,'no duplicate agent cards outside operation group');assert.ok(strip && !process.contains(strip));
  assert.equal(strip.querySelectorAll('.artifact').length, 2);
});

// ---------- Live pill: one turn's authoritative summary ----------
test('pill uses the running/latest edited turn and never sums or cancels across turn baselines', () => {
  const ledger = new TurnLedger();
  ledger.merge({ id: 't1', status: 'completed' }); ledger.merge({ id: 't2', status: 'completed' });
  ledger.setDiff('t1', 'diff --git a/a.txt b/a.txt\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1,3 @@\n+1\n+2\n+3\n');
  ledger.setDiff('t2', ''); // turn 2 edited a.txt and restored it to turn 2's own starting state
  const items = [{ id: 'u1', type: 'userMessage', content: [], _turnId: 't1' }, { id: 'e1', type: 'fileChange', status: 'completed', changes: [{ path: 'C:/p/a.txt', kind: { type: 'add' }, diff: '1\n2\n3\n' }], _turnId: 't1' },
    { id: 'u2', type: 'userMessage', content: [], _turnId: 't2' }, { id: 'e2', type: 'fileChange', status: 'completed', changes: [{ path: 'C:/p/a.txt', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-1\n+x\n' }], _turnId: 't2' }];
  const turns = buildTurns(items, ledger, { cwd: 'C:/p' });
  assert.equal(turns[0].files.count, 1, 'turn 1 card keeps its own +3');
  const pill = pillChanges(turns);
  assert.equal(pill.turnId, null); assert.equal(pill.count, 0, 'terminal changes remain solely in the transcript summary');
  ledger.merge({ id: 't3', status: 'inProgress' });
  const running = buildTurns([...items, { id: 'u3', type: 'userMessage', content: [], _turnId: 't3' }, { id: 'e3', type: 'fileChange', status: 'inProgress', changes: [{ path: 'C:/p/b.md', kind: { type: 'add' }, diff: 'a\n' }], _turnId: 't3' }], ledger, { activeTurnId: 't3', cwd: 'C:/p' });
  const live = pillChanges(running); assert.equal(live.turnId, 't3'); assert.equal(live.running, true); assert.equal(live.count, 1); assert.equal(live.added, 1);
});

// ---------- Statistics view ----------
function statsHarness(responses) {
  const document = createDocument(); const host = document.createElement('div'); const calls = [];
  const api = async (path, body) => { calls.push({ path, body: structuredClone(body) }); const next = responses.shift(); if (next instanceof Error) throw next; return next; };
  const view = mountStatistics(host, { api });
  return { document, host, view, calls };
}
const page = (rows, nextCursor, total) => ({ scope: 'light', generatedAt: '2026-11-12T00:00:00Z', totals: { totalTokens: 1000, inputTokens: 800, outputTokens: 200, cachedInputTokens: 400, cacheHitRate: .5, turnCount: 3, submissionCount: 4, successRate: 1, completedCount: 3, failedCount: 0, interruptedCount: 0, estimatedCost: { usd: null, pricedRows: 0, totalRows: 3, complete: false }, performance: { firstTextLatencyMs: { count: 2, p50: 1200, p95: 3000 }, durationMs: { count: 0 }, textCharsPerSecond: { count: 5, p50: 900, p95: 1200 }, turnOutputTokensPerSecond: { count: 2, p50: 12.5, p95: 40 }, ttftMs: null, outputTokensPerSecond: null } }, trend: [{ start: '2026-11-11T00:00:00Z', totalTokens: 1000, turnCount: 3 }], models: [{ model: 'm1', turnCount: 3 }], providers: [{ provider: 'openai' }], details: { data: rows, nextCursor, total }, coverage: { notes: [] }, pricing: { available: false }, dsh: { available: false, reason: '无遥测' } });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
test('statistics pager enables Next after load and keeps one frozen time window across pages', async () => {
  const row = id => ({ id, status: 'completed', model: 'm1', tokens: { inputTokens: 1, outputTokens: 1 }, performance: {}, estimatedCost: {} });
  const h = statsHarness([page([row('a')], 'c1', 65), page([row('b')], null, 65), page([row('a')], 'c1', 65)]);
  h.view.activate(); await settle();
  const next = () => h.host.querySelector('.table-pager').querySelectorAll('button')[1];
  assert.equal(next().disabled, false, 'Next is enabled once loading finished');
  next().click(); await settle();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].body.cursor, 'c1');
  assert.equal(h.calls[1].body.from, h.calls[0].body.from, 'page 2 sends the identical time window');
  assert.equal(h.calls[1].body.to, h.calls[0].body.to);
  assert.equal(next().disabled, true, 'no further cursor');
  h.host.querySelector('.page-controls').querySelectorAll('button').at(-1).click(); await settle();
  assert.equal(h.calls[2].body.cursor, undefined, 'refresh starts a fresh first page');
  assert.match(h.host.textContent, /首次可见输出等待/);
  const metrics = h.host.querySelector('.perf-strip').textContent + h.host.querySelector('.kpi-row').textContent;
  assert.doesNotMatch(metrics, /TTFT|API 请求|字\/秒|字\/s/, 'no character-rate or API-request metrics in the primary strip');
  assert.match(metrics, /回合平均输出12.5 tok\/s/); assert.doesNotMatch(metrics, /900/, 'the character-rate number is never relabelled as tok/s');
  assert.match(h.host.querySelector('.perf-strip').innerTitle ?? h.host.querySelector('.perf-strip').children[2].title, /整轮耗时/);
  assert.match(h.host.textContent, /已计价 0 · 未计价 3/);
});
test('statistics query anchors time, and cost coverage is honest', () => {
  const q = statisticsQuery({ scope: 'local', range: '24h', anchor: Date.parse('2026-11-12T00:00:00Z'), model: 'm', cursor: 'x' });
  assert.deepEqual(q, { scope: 'local', bucket: 'hour', limit: 30, from: '2026-11-11T00:00:00.000Z', to: '2026-11-12T00:01:00.000Z', model: 'm', cursor: 'x' });
  assert.equal(statisticsQuery({ range: 'all' }).from, undefined);
  assert.equal(costCoverage({ pricedRows: 3, totalRows: 3, complete: true }), '已计价 3 · 未计价 0'); assert.equal(costCoverage(null), '价格覆盖未知');
});
test('chart draws null as a gap, never fabricates zero bars, and lays out at real pixel width', () => {
  const document = createDocument();
  const wrap = barChart(document, [{ label: 'a', value: 10 }, { label: 'b', value: null }, { label: 'c', value: 0 }]);
  assert.equal(wrap.querySelectorAll('rect.bar').length, 2); assert.equal(niceMax(7300), 10000); assert.equal(niceMax(0), 1);
  const svg = wrap.querySelector('svg'); assert.equal(svg.getAttribute('viewBox'), '0 0 640 200', 'viewBox equals the drawn pixel width: text is not squashed');
  assert.equal(svg.getAttribute('preserveAspectRatio'), null);
  // A 390px phone (≈330px plot) shows at most one label per ~56px.
  assert.equal(labelStep(24, 330), 5); assert.equal(labelStep(7, 900), 1);
  const phone = chartLayout(Array(24).fill(5), 330, 160); assert.ok(phone.bar >= 2 && phone.bar <= 40); assert.ok(phone.bars.every(bar => bar.x + bar.w <= 330));
  wrap.querySelectorAll('rect.hit')[0].click(); const readout = wrap.querySelector('.chart-readout'); assert.equal(readout.hidden, false); assert.match(readout.textContent, /a · 10/);
});

// ---------- Account ----------
test('account quota uses the id map OR the fallback, remaining is a percent of its own window', () => {
  assert.deepEqual(quotaBuckets({ rateLimitsByLimitId: { codex: { limitName: 'Codex' } }, rateLimits: { limitId: 'x' } }).map(b => b.id), ['codex']);
  assert.deepEqual(quotaBuckets({ rateLimits: { limitId: 'x' } }).map(b => b.id), ['x']);
  const w = windowView({ usedPercent: 37.5, windowDurationMins: 300, resetsAt: 7200 }, 3600 * 1000);
  assert.equal(w.remaining, 62.5); assert.equal(w.label, '5 小时窗口'); assert.equal(w.reset, '1 小时 0 分后重置');
  assert.equal(windowView({ windowDurationMins: 10080 }).remaining, null);
});
test('account page renders identity, quota and usage without inventing balance', async () => {
  const document = createDocument(); const host = document.createElement('div');
  const rpc = async method => ({ 'account/read': { account: { type: 'chatgpt', email: 'me@example.com', planType: 'pro' } }, 'account/rateLimits/read': { rateLimitsByLimitId: { codex: { limitName: 'Codex', primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: null }, credits: { hasCredits: true, unlimited: false, balance: null } } } }, 'account/usage/read': { summary: { lifetimeTokens: 123456 }, dailyUsageBuckets: [{ startDate: '2026-11-10', tokens: 10 }] } })[method];
  const view = mountAccount(host, { rpc }); view.activate(); await settle(); await settle();
  const text = host.textContent;
  assert.match(text, /me@example.com/); assert.match(text, /Pro/); assert.match(text, /剩余 80%/); assert.match(text, /余额未提供/); assert.match(text, /12.3万/);
  const facts = host.querySelector('.acct-grid').textContent;
  assert.doesNotMatch(facts, /\$\d|到期|账单/, 'no invented balance, bill or expiry in identity/quota');
});

// ---------- Bounded typed image storage (real ItemStore pipeline) ----------
test('large MCP image survives ItemStore under its own budget; text projection keeps no base64', async () => {
  const { ItemStore, IMAGE_LIMITS } = await import('../public/store.js');
  const data = 'A'.repeat(301216); // valid base64 alphabet, 301216 chars like the reviewed 256×256 PNG
  const store = new ItemStore(300);
  store.upsert({ id: 'mcp', type: 'mcpToolCall', tool: 'make_image', status: 'completed', result: { content: [{ type: 'text', text: 'ok' }, { type: 'image', mimeType: 'image/png', data }] } });
  const projected = store.items.get('mcp');
  assert.equal(JSON.stringify(projected).includes(data.slice(0, 100)), false, 'display projection holds no image bytes');
  assert.equal(projected.result.content[1].imageRef, 0);
  assert.equal(store.image('mcp', 0).data.length, 301216, 'bytes are intact, not truncated to 32768');
  const [candidate] = artifactCandidates(projected);
  assert.equal(candidate.status, 'done'); assert.equal(candidate.inline.slot, 0);
  const document = createDocument();
  globalThis.URL.createObjectURL = () => 'blob:mcp'; globalThis.URL.revokeObjectURL = () => {};
  globalThis.atob = globalThis.atob || (value => Buffer.from(value, 'base64').toString('binary'));
  const view = mountArtifacts({ document, fetchPreview: async () => { throw new Error('not used'); }, onOpen() {}, resolveImage: (id, slot) => store.image(id, slot) });
  const strip = view.strip([candidate]); await settle(); await settle();
  assert.equal(strip.querySelector('img')?.src, 'blob:mcp');
  // Oversized / non-raster blocks keep a reason instead of bytes.
  store.upsert({ id: 'big', type: 'mcpToolCall', result: { content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(IMAGE_LIMITS.perImageBase64 + 4) }, { type: 'image', mimeType: 'image/svg+xml', data: 'PHN2Zz4=' }] } });
  assert.deepEqual(artifactCandidates(store.items.get('big')).map(c => c.reason), ['图片数据超过 6 MiB', '不支持的图片类型 image/svg+xml']);
  assert.equal(store.image('big', 0), null);
  // Trimming the item drops its bytes too.
  const small = new ItemStore(1); small.upsert({ id: 'a', type: 'mcpToolCall', result: { content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }] } }); small.upsert({ id: 'b', type: 'agentMessage', text: 'x' });
  assert.equal(small.image('a', 0), null); assert.equal(small.imageChars, 0);
});
test('artifact cache is keyed by item revision and released cards revoke their blob after ttl', async () => {
  const document = createDocument(); const revoked = []; let n = 0; const fetched = [];
  globalThis.URL.createObjectURL = () => 'blob:' + (n++); globalThis.URL.revokeObjectURL = url => revoked.push(url);
  const view = mountArtifacts({ document, ttlMs: 0, fetchPreview: async path => { fetched.push(path); return { blob: {}, width: 1, height: 1 }; }, onOpen() {} });
  const first = view.strip([{ key: 'gen1:gen', kind: 'generated', path: 'out/icon.svg', status: 'done' }]); await settle();
  const second = view.strip([{ key: 'gen2:gen', kind: 'generated', path: 'out/icon.svg', status: 'done' }]); await settle();
  assert.deepEqual(fetched, ['out/icon.svg', 'out/icon.svg'], 'a new item writing the same path is read again');
  first.release(); await settle();
  assert.deepEqual(revoked, ['blob:0'], 'released card revokes its blob');
  second.release(); await settle(); assert.equal(view.size(), 0);
});

// ---------- Slash menu module (real module, minimal DOM) ----------
test('slash menu opens after ordinary text, skips disabled rows, and replaces only its token', async () => {
  const { createSlashMenu } = await import('../public/ui/slash-menu.js');
  const document = createDocument(); const prompt = document.createElement('textarea'); const menu = document.createElement('div'); menu.className = 'hidden';
  prompt.setSelectionRange = (a) => { prompt.selectionStart = a; };
  const ran = []; let ctx = { thread: false, busy: false, sending: false, connected: true, cwd: '' };
  const slash = createSlashMenu({ document, prompt, menu, el: (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }, rpc: async () => ({ data: [] }), context: () => ctx, commands: { new: () => ran.push('new'), model: () => ran.push('model') }, onDraftChange: () => {} });
  prompt.value = '修改文件的时候会有这个小标吗 /'; prompt.selectionStart = prompt.value.length; slash.update();
  assert.equal(slash.isOpen(), true); assert.equal(menu.classList.contains('hidden'), false);
  const selected = () => menu.querySelector('[aria-selected="true"]').querySelector('.slash-label').textContent;
  assert.equal(selected(), '/new');
  const key = k => { const e = { key: k, shiftKey: false, preventDefault() { e.prevented = true; }, stopPropagation() {} }; return [slash.handleKey(e), e]; };
  key('ArrowDown'); assert.notEqual(selected(), '/compact', 'disabled /compact (no thread) is skipped');
  // Escape closes and keeps the draft.
  key('Escape'); assert.equal(slash.isOpen(), false); assert.equal(prompt.value, '修改文件的时候会有这个小标吗 /');
  // Choosing /model runs the command and removes only the token.
  prompt.value = '前面 /mod 后面'; prompt.selectionStart = 7; slash.update();
  const [consumed] = key('Enter'); assert.equal(consumed, true);
  assert.deepEqual(ran, ['model']); assert.equal(prompt.value, '前面 后面', 'surrounding draft preserved, nothing sent');
  // Inside a word or URL: no menu.
  prompt.value = 'http://x'; prompt.selectionStart = 8; slash.update(); assert.equal(slash.isOpen(), false);
});

// ---------- Composer controller (real module, injected ports) ----------
async function composerHarness({ mutation } = {}) {
  const { createComposer } = await import('../public/ui/composer.js');
  const { FollowUpQueue } = await import('../public/state.js');
  const { ItemStore } = await import('../public/store.js');
  const document = createDocument(); const nodes = new Map();
  const $ = id => { if (!nodes.has(id)) { const n = document.createElement('div'); n.id = id; n.className = 'hidden'; nodes.set(id, n); } return nodes.get(id); };
  $('prompt').value = '';
  const calls = [];
  const state = { thread: { id: 't', cwd: '/p' }, cwd: '/p', busy: true, turnId: 'turn-1', connected: true, serverInstance: 'a'.repeat(32), sending: false, loadingThread: false, uploadingImages: false, store: new ItemStore(), ledger: { activate() {}, merge() {} }, activeTurns: new Map(), terminalTurns: new Set(), openGeneration: 1, reasoning: {}, models: [], dshReadErrors: new Map(), dshOpenDetails: new Set() };
  const followUps = new FollowUpQueue();
  const empty = { values: () => [], ids: () => [], remove() {} };
  const composer = createComposer({ document,
    session: { state, followUps,sessionControls:{snapshot:()=>({permission:null,serviceTier:null}),params:()=>({})}, sessionFor: id => id === 't' && state.busy ? { activeTurnId: state.turnId } : null },
    drafts: { attachmentDraft: empty, fileAttachmentDraft: empty, attachmentPreviews: new Map(), queuedPreviews: new Map(), clearSubmittedDraft: env => { if ($('prompt').value.trim() === env.params.input[0].text) $('prompt').value = ''; }, renderAttachments() {}, autosizePrompt() {} },
    ledger: { performMutation: async (method, params) => { calls.push([method, structuredClone(params)]); return mutation ? mutation(method, params) : method === 'turn/steer' ? { turnId: 'turn-1' } : { turn: { id: 'turn-2', status: 'inProgress' } }; }, pendingMutations: { storageError: null }, scopedPending: () => [], currentSendAvailability: () => ({ disabled: false }), renderPendingMutations() {} },
    thread: { restoreThreadReasoning() {}, loadThreads: async () => {}, syncStatus: async () => {}, resetThreadDsh() {} },
    view: { $, el: (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }, notice: (...a) => calls.push(['notice', ...a]), activity() {}, confirm: () => true, updateControls() {}, renderMessages() {}, scheduleRender() {}, scrollBottom() {}, renderContext() {}, openProjectDialog() {}, openInlineCwd() {} } });
  return { composer, state, followUps, calls, $ };
}
test('steer sends only threadId/expectedTurnId/input and clears the draft after acknowledgement', async () => {
  const h = await composerHarness();
  h.$('prompt').value = '顺便更新 README'; await h.composer.send();
  assert.deepEqual(h.calls[0], ['turn/steer', { threadId: 't', expectedTurnId: 'turn-1', input: [{ type: 'text', text: '顺便更新 README', text_elements: [] }] }]);
  assert.equal(h.$('prompt').value, '');
  const failing = await composerHarness({ mutation: () => { throw Object.assign(new Error('changed'), { code: 'ACTIVE_TURN_MISMATCH', outcome: 'notExecuted' }); } });
  failing.$('prompt').value = 'keep me'; await failing.composer.send();
  assert.equal(failing.$('prompt').value, 'keep me', 'draft kept when the steer was not executed');
  assert.equal(failing.calls.filter(c => c[0] === 'turn/start').length, 0, 'no automatic fallback to turn/start');
});
test('queue sends nothing while busy, drains exactly once after completion, and pauses on unknown outcome', async () => {
  const h = await composerHarness();
  h.$('prompt').value = '下一条'; h.composer.queueDraft();
  assert.equal(h.followUps.size('t'), 1); assert.equal(h.calls.length, 0); assert.equal(h.$('prompt').value, '');
  await h.composer.drainQueue('t'); assert.equal(h.calls.length, 0, 'busy thread does not drain');
  h.state.busy = false; h.state.turnId = null;
  await Promise.all([h.composer.drainQueue('t'), h.composer.drainQueue('t')]);
  assert.deepEqual(h.calls.map(c => c[0]), ['turn/start'], 'concurrent drains submit once'); assert.equal(h.followUps.size('t'), 0);
  const u = await composerHarness({ mutation: () => { throw Object.assign(new Error('timeout'), { outcome: 'unknown' }); } });
  u.$('prompt').value = 'a'; u.composer.queueDraft(); u.$('prompt').value = 'b'; u.composer.queueDraft();
  u.state.busy = false; u.state.turnId = null; await u.composer.drainQueue('t'); await u.composer.drainQueue('t');
  assert.equal(u.calls.filter(c => c[0] === 'turn/start').length, 1, 'unknown outcome is never resubmitted');
  assert.equal(u.followUps.list('t')[0].status, 'unknown'); assert.match(u.followUps.pausedReason('t'), /结果未知/);
});

// ---------- Image pool lifecycle ----------
test('image pool: replacement releases bytes, per-item budget holds, history prepend keeps loaded images', async () => {
  const { ItemStore, IMAGE_LIMITS } = await import('../public/store.js');
  const img = (id, data = 'QUJDRA==') => ({ id, type: 'mcpToolCall', status: 'completed', result: { content: [{ type: 'image', mimeType: 'image/png', data }] } });
  const s = new ItemStore();
  s.upsert(img('x')); s.upsert({ id: 'x', type: 'mcpToolCall', result: { content: [{ type: 'text', text: 'replacement' }] } });
  assert.equal(s.imageChars, 0); assert.equal(s.image('x', 0), null);
  s.upsert(img('y')); s.upsert({ id: 'y', status: 'completed' });
  assert.ok(s.image('y', 0), 'status-only partial update keeps the image');
  const big = 'A'.repeat(IMAGE_LIMITS.perImageBase64);
  s.upsert({ id: 'four', type: 'mcpToolCall', result: { content: [1, 2, 3, 4].map(() => ({ type: 'image', mimeType: 'image/png', data: big })) } });
  assert.ok(s.imageChars <= IMAGE_LIMITS.totalBase64, 'one item cannot exceed the total pool');
  assert.match(s.items.get('four').result.content.at(-1).imageError, /预算/);
  // Same slot, new bytes → new revision → new candidate key.
  const r = new ItemStore(); r.upsert(img('z', 'QUJDRA==')); const first = artifactCandidates(r.items.get('z'))[0].key;
  r.upsert(img('z', 'RUZHSA==')); const second = artifactCandidates(r.items.get('z'))[0].key;
  assert.notEqual(first, second); assert.equal(r.image('z', 0).data, 'RUZHSA==');
  // loadItems(earlier) path: values() → merge older → replaceWindow keeps loaded image bytes.
  const h = new ItemStore(); h.upsert(img('loaded'));
  const merged = [{ id: 'older', type: 'agentMessage', text: 'older' }, ...h.values()];
  h.replaceWindow(merged);
  assert.equal(h.image('loaded', 0)?.data, 'QUJDRA=='); assert.equal(artifactCandidates(h.items.get('loaded'))[0].status, 'done');
  h.replaceWindow([{ id: 'older', type: 'agentMessage', text: 'older' }]); assert.equal(h.imageChars, 0, 'items leaving the window release their bytes');
});
