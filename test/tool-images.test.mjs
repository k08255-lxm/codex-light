import test from 'node:test';
import assert from 'node:assert/strict';
import { ItemStore } from '../public/store.js';
import { artifactCandidates, mountArtifacts } from '../public/ui/artifacts.js';
import { mountConversation, describeItem } from '../public/activity-feed.js';
import { createAgentInspector } from '../public/ui/agent-inspector.js';
import { TurnLedger, buildTurns } from '../public/state.js';
import { createDocument } from './mini-dom.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII=';
const image = () => ({ type: 'input_image', image_url: 'data:image/png;base64,' + png });
const output = (count = 3) => ({ id: 'view-output', type: 'functionCallOutput', name: 'functions', output: Array.from({ length: count }, image), _turnId: 'turn', _complete: true });
const settle = () => new Promise(resolve => setImmediate(resolve));

test('only an intersecting card requests the historical bytes and an unmounted card stays unloaded', async () => {
  const document=createDocument(), observed=new Set(), calls=[];
  let notify;
  document.defaultView.IntersectionObserver=class {
    constructor(callback){notify=callback;}
    observe(node){observed.add(node);}
    unobserve(node){observed.delete(node);}
    disconnect(){observed.clear();}
  };
  const artifacts=mountArtifacts({document, getScope:()=>'thread', onOpen(){},
    fetchPreview:async(path,scope,workspaceOnly,handle)=>{calls.push([scope,handle]);return {blob:new Blob()};}});
  const tag={key:'a'.repeat(64),itemId:'gen',slot:0};
  const candidate={key:'gen',kind:'generated',status:'done',historyImage:tag};
  const source=artifacts.strip([candidate]), gallery=artifacts.strip([candidate]);
  assert.equal(observed.size,2);assert.deepEqual(calls,[]);
  notify([{target:gallery.firstChild,isIntersecting:true}]);await settle();
  assert.deepEqual(calls,[['thread',tag]]);assert.ok(gallery.querySelector('img'));
  source.release();assert.equal(observed.size,0);gallery.release();artifacts.clear();
});

test('live images stay in chronological order and completed turns keep both the gallery and original positions', async t => {
  const document = createDocument(), host = document.createElement('div');
  const reads = [], opened = [];
  const artifacts = mountArtifacts({document, onOpen: value => opened.push(value.path), fetchPreview: async path => {
    reads.push(path); return {blob: new Blob(), width: 1, height: 1};
  }});
  const view = mountConversation(host, {artifacts, getCwd: () => 'C:/project'});
  t.after(() => view.clear());
  const ledger = new TurnLedger();
  ledger.merge({id: 't', status: 'inProgress'});
  const gen = n => ({id: 'g' + n, type: 'imageGeneration', savedPath: 'out/' + n + '.png', status: 'completed', _turnId: 't', _complete: true});
  const say = (id, text, phase) => ({id, type: 'agentMessage', text, phase, _turnId: 't', _complete: true});
  const mid = say('mid', '制作中\n\n![参考图](out/ref.png)\n\n这是发图后的回复', 'commentary');
  const final = say('last', '成品说明 ![第一张](</C:/project/out/1.png>) 和 ![成品](out/final.png)', 'final_answer');
  const items = [gen(1), mid, ...Array.from({length: 12}, (_, index) => gen(index + 2)), final];
  const render = () => view.render(buildTurns(items, ledger));
  render(); await settle();
  const turn = host.querySelector('.turn'), original = turn.querySelector('.artifact-strip');
  const message = turn.querySelector('[data-item-id="mid"]'), reply = turn.querySelector('[data-item-id="last"]');
  assert.equal(turn.querySelector('.turn-image-gallery'), null);
  assert.ok(turn.children.indexOf(original) < turn.children.indexOf(message));
  assert.equal(turn.children.at(-2), reply, 'only the working indicator follows the latest text');
  const paragraphs = message.querySelectorAll('p');
  assert.ok(paragraphs[1].querySelector('img')); assert.match(paragraphs[2].textContent, /发图后的回复/);
  const readCount = reads.length;
  ledger.merge({id: 't', status: 'completed'}); render(); await settle();
  const gallery = turn.querySelector('.turn-image-gallery'), work = turn.querySelector('.turn-work');
  assert.equal(turn.children.at(-1), gallery); assert.equal(work.open, false);
  assert.deepEqual(gallery.querySelectorAll('.artifact').map(card => card.title),
    ['out/1.png', 'out/ref.png', ...items.slice(2, -1).map(item => item.savedPath), 'out/final.png']);
  assert.equal(reads.length, readCount, 'the summary reuses previews from the live turn');
  assert.equal(reply.querySelector('img'), null, 'the folded final answer keeps the file link and a single visible preview in the gallery');
  work.open = true; await settle();
  const body = work.querySelector('.turn-work-body');
  assert.ok(body.children.indexOf(original) < body.children.indexOf(message));
  assert.equal(body.querySelectorAll('.artifact').length, 14);
  assert.equal(reply.querySelectorAll('img').length, 2);
  body.querySelector('.step').open = true;
  assert.equal(body.querySelectorAll('.artifact').length, 14, 'opening image generation metadata does not add another thumbnail');
  original.querySelector('.artifact-frame').click(); gallery.querySelectorAll('.artifact-frame').at(-1).click();
  assert.deepEqual(opened, ['out/1.png', 'out/final.png']);
  render(); assert.equal(work.open, true); assert.equal(turn.children.at(-1), gallery);
  view.clear(); render(); await settle();
  assert.equal(host.querySelector('.turn-work').open, false);
  assert.equal(host.querySelector('.turn-image-gallery').querySelectorAll('.artifact').length, 15);
});

test('streamed Markdown inserts, corrects and removes images at the source without loading examples or remote URLs', async t => {
  const document = createDocument(), host = document.createElement('div'), reads = [];
  const artifacts = mountArtifacts({document, onOpen() {}, fetchPreview: async path => {reads.push(path); return {blob: new Blob()};}});
  const view = mountConversation(host, {artifacts});
  t.after(() => view.clear());
  const ledger = new TurnLedger();
  ledger.merge({id: 't', status: 'inProgress'});
  const item = {id: 'a', type: 'agentMessage', phase: 'partial_answer', _turnId: 't', _complete: false, text: '见下图 ![图](out/a'};
  view.render(buildTurns([item], ledger));
  assert.equal(host.querySelector('.artifact'), null);
  const withImage = {...item, text: item.text + '.png)\n\n下文'};
  assert.ok(view.updateStreamingAnswer(withImage)); await settle();
  const card = host.querySelector('.artifact');
  assert.equal(card.title, 'out/a.png'); assert.match(host.querySelector('.agentMessage').querySelectorAll('p').at(-1).textContent, /下文/);
  assert.ok(view.updateStreamingAnswer({...withImage, text: withImage.text + '还在继续'}));
  assert.equal(host.querySelector('.artifact'), card);
  const correction = {...item, text: '示例 `![代码](code.png)`\n\n~~~md\n![示例](example.png)\n~~~\n\n![远程](https://example.org/x.png)\n\n![修正](<out/b (v2).png>)'};
  assert.ok(view.updateStreamingAnswer(correction)); await settle();
  assert.deepEqual(reads, ['out/a.png', 'out/b (v2).png']);
  assert.equal(host.querySelectorAll('.artifact').length, 1);
  assert.ok(view.updateStreamingAnswer({...item, text: '已撤回图片'}));
  assert.equal(host.querySelector('.artifact'), null);
  for (const status of ['interrupted', 'failed']) {
    ledger.merge({id: 't', status});
    view.render(buildTurns([{...correction, _complete: true}], ledger));
    assert.equal(host.querySelector('.turn-image-gallery').querySelectorAll('.artifact').length, 1);
    assert.ok(host.querySelector('.turn-work-body').querySelector('.md-image-source'));
    view.render(buildTurns([{...item, text: '已更正', _complete: true}], ledger));
    assert.equal(host.querySelector('.artifact-strip'), null, 'a corrected completed snapshot releases both copies');
  }
  ledger.merge({id:'t',status:'interrupted'});
  view.render(buildTurns([{id:'stopped',type:'imageGeneration',status:'inProgress',_turnId:'t',_complete:false}],ledger));
  assert.match(host.querySelector('.turn-image-gallery').textContent,/图片生成已停止/);
  assert.equal(host.querySelector('.turn-image-gallery').querySelector('.artifact-spinner'),null);
});

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
