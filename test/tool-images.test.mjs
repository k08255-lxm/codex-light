import test from 'node:test';
import assert from 'node:assert/strict';
import { ItemStore } from '../public/store.js';
import { artifactCandidates, mountArtifacts } from '../public/ui/artifacts.js';
import { mountConversation, describeItem } from '../public/activity-feed.js';
import { createAgentInspector } from '../public/ui/agent-inspector.js';
import { mountToolActivity } from '../public/ui/tool-activity.js';
import { TurnLedger, buildTurns } from '../public/state.js';
import { createDocument } from './mini-dom.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII=';
const image = () => ({ type: 'input_image', image_url: 'data:image/png;base64,' + png });
const output = (count = 3) => ({ id: 'view-output', type: 'functionCallOutput', name: 'functions', output: Array.from({ length: count }, image), _turnId: 'turn', _complete: true });
const settle = () => new Promise(resolve => setImmediate(resolve));

test('native function output images survive the actual ItemStore projection intact and render as three viewed images', () => {
  const store = new ItemStore(); store.upsert(output());
  const item = store.items.get('view-output'), candidates = artifactCandidates(item);
  assert.equal(candidates.length, 3); assert.equal(describeItem(item).target, '3 张图像'); assert.equal(describeItem(item).verb, '已查看');
  assert.ok(!JSON.stringify(item).includes(png));
  assert.deepEqual(candidates.map(candidate => store.image(candidate.inline.itemId, candidate.inline.slot).data), [png, png, png]);
  const big = 'A'.repeat(40000); store.upsert({ id: 'large', type: 'functionCallOutput', output: [{ type: 'input_image', image_url: 'data:image/png;base64,' + big }] });
  assert.equal(store.image('large', 0).data.length, 40000, 'image bytes do not pass through the 32768-character text bound');
  assert.equal(JSON.stringify(store.items.get('large')).includes(big.slice(0, 200)), false);
});

test('typed local function image paths remain previewable while file IDs and remote URLs never invent content', () => {
  const [local, remote, file] = artifactCandidates({ ...output(0), output: [{ type: 'input_image', image_url: 'file:///C:/images/x.png' }, { type: 'input_image', image_url: 'https://example.invalid/x.png' }, { type: 'input_image', file_id: 'file-only' }] });
  assert.equal(local.path, 'file:///C:/images/x.png'); assert.equal(local.status, 'done');
  assert.equal(remote.path, null); assert.equal(remote.inline, null); assert.equal(remote.status, 'failed');
  assert.equal(file.inline, null); assert.match(file.reason, /文件标识/);
  assert.deepEqual(artifactCandidates({ ...output(0), output: [{ type: 'input_text', text: 'C:/not-evidence.png' }] }), []);
});

test('native image generation without a saved path uses validated raster bytes from its own pool', () => {
  const store = new ItemStore(); store.upsert({ id: 'gen', type: 'imageGeneration', status: 'completed', result: png });
  const item = store.items.get('gen'), [candidate] = artifactCandidates(item);
  assert.equal(item.result, ''); assert.equal(candidate.status, 'done'); assert.equal(candidate.path, null);
  assert.equal(candidate.inline.mime, 'image/png'); assert.equal(store.image('gen', candidate.inline.slot).data, png);
  assert.match(artifactCandidates({ id: 'not-image', type: 'imageGeneration', status: 'completed', result: 'ordinary text' })[0].reason, /没有提供本地保存路径/);
  assert.equal(artifactCandidates({ id: 'gen-running', type: 'imageGeneration', status: 'in_progress', result: '' })[0].status, 'running');
  assert.equal(artifactCandidates({ id: 'dynamic', type: 'dynamicToolCall', contentItems: [{ type: 'inputImage', imageUrl: 'data:image/png;base64,' + png }] })[0].inline.data, png);
});

test('expanding a conversation tool result shows three clickable thumbnails with historical metadata retained', async t => {
  const document = createDocument(), host = document.createElement('div'); document.body.append(host);
  const store = new ItemStore(); store.upsert(output()); const opened = [];
  const artifacts = mountArtifacts({ document, resolveImage: (id, slot) => store.image(id, slot), fetchPreview: async () => { throw new Error('inline image must not read a path'); }, onOpen: value => opened.push(value) });
  t.after(() => artifacts.clear());
  const view = mountConversation(host, { artifacts }); const ledger = new TurnLedger(); ledger.merge({ id: 'turn', status: 'completed' });
  view.render(buildTurns(store.values(), ledger));
  assert.equal(host.querySelector('.artifact-strip'), null, 'collapsed operations do not eagerly decode image previews');
  host.querySelector('.step').open = true; await settle();
  const frames = host.querySelectorAll('.artifact-frame'); assert.equal(frames.length, 3); assert.ok(frames.every(frame => !frame.disabled && frame.querySelector('img')));
  assert.equal(host.querySelectorAll('.artifact-caption').length, 3, 'historical cards retain names and metadata');
  frames[1].click(); assert.equal(opened.length, 1); assert.match(opened[0].url, /^blob:/);
});

test('subagent image previews use its own thread and image pool for tool output and local view_image paths', async t => {
  const document = createDocument(), host = document.createElement('div'); document.body.append(host);
  const el = (tag, className, text) => { const node = document.createElement(tag); node.className = className; if (text != null) node.textContent = text; return node; };
  const state = { connected: true, thread: { id: 'parent' }, store: { values: () => [{ id: 'spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['child'], agentsStates: { child: { status: 'completed' } } }] } };
  const scopes = [], opened = [], views = [];
  t.after(() => views.forEach(view => view.clear()));
  const inspector = createAgentInspector({ document, state, host, el, dshTasks: { values: () => [] }, dshLive: { selectAgent() {} },
    rpc: async () => ({ thread: { id: 'child', cwd: 'C:/child', turns: [{ id: 'turn', status: 'completed', items: [output(), { id: 'local-view', type: 'imageView', path: 'C:/child/local.png' }] }] } }),
    artifactFactory: ({ threadId, resolveImage }) => { assert.equal(threadId, 'child'); const view = mountArtifacts({ document, resolveImage, getScope: () => threadId, fetchPreview: async (path, scope) => { scopes.push({ path, scope }); return { blob: new Blob([Uint8Array.of(1)]), width: 1, height: 1 }; }, onOpen: value => opened.push(value) }); views.push(view); return view; }
  });
  inspector.render(); inspector.open('child', 'native'); await settle();
  for (const record of host.querySelectorAll('.agent-tool-record')) record.open = true;
  await settle();
  assert.equal(host.querySelectorAll('.artifact-frame').length, 4);
  assert.ok(host.querySelectorAll('.artifact-frame').every(frame => !frame.disabled));
  assert.deepEqual(scopes, [{ path: 'C:/child/local.png', scope: 'child' }]);
  host.querySelector('.artifact-frame').click(); assert.equal(opened.length, 1);
});

test('tool tab exposes function output images, keeps compaction standalone, and releases removed previews once', () => {
  const document = createDocument(), host = document.createElement('div'); document.body.append(host); let releases = 0;
  const artifacts = { strip(candidates) { assert.equal(candidates.length, 3); const node = document.createElement('div'); node.className = 'artifact-strip'; node.release = () => releases++; return node; } };
  const view = mountToolActivity(host, { artifacts });
  view.render([output(), { id: 'compact', type: 'contextCompaction' }], 'thread');
  host.querySelector('.agent-tool-record').open = true;
  assert.ok(host.querySelector('.artifact-strip'));
  assert.equal(host.querySelector('.compaction-record').closest('details'), null);
  view.render([], 'thread'); assert.equal(releases, 1);
  view.render([], 'other-thread'); assert.equal(releases, 1);
});
