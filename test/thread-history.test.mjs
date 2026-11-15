import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const source = app.slice(app.indexOf('function rememberThread('), app.indexOf('const CONVERSATION_ITEMS ='));
const thread = { id: 'new', cwd: '/project', preview: '首条消息', turns: [{ id: 'turn', items: [] }] };
function harness() {
  const state = { threads: [], activeTurns: new Map(), searchGeneration: 0, nextThreads: null };
  const unindexedThreads = new Map(), search = { value: '' };
  let list = { data: [], nextCursor: null };
  const ports = { state, unindexedThreads, $: () => search, threadAutoLoad: {reset() {}}, captureHistoryAnchor: () => null, restoreHistoryAnchor() {}, sessionFor: () => null, renderThreads() {}, notice() {}, rpc: async () => list };
  return { state, search, unindexedThreads, setList(value) { list = value; }, ...new Function(...Object.keys(ports), source + ';return {rememberThread,loadThreads};')(...Object.values(ports)) };
}

test('confirmed new threads appear immediately and survive repeated incomplete list refreshes', async () => {
  const h = harness(); h.rememberThread(thread);
  assert.equal(h.state.threads[0].id, thread.id);
  assert.equal(h.unindexedThreads.get(thread.id).turns, undefined, 'sidebar must not retain message history');
  for (let i = 0; i < 3; i++) {
    await h.loadThreads();
    assert.deepEqual(h.state.threads.map(row => row.id), ['new']);
  }
  h.rememberThread({ id: 'ephemeral', ephemeral: true });
  assert.equal(h.state.threads.length, 1);
});

test('running thread metadata follows the native list without duplicates and survives later omissions', async () => {
  const h = harness(); h.rememberThread(thread); h.state.activeTurns.set('new', 'turn');
  h.setList({ data: [{ ...thread, name: '服务端标题' }] }); await h.loadThreads();
  assert.equal(h.state.threads.length, 1);
  h.setList({ data: [] }); await h.loadThreads();
  assert.equal(h.state.threads[0].name, '服务端标题');
  h.state.activeTurns.clear();
  h.setList({ data: [{ ...thread, name: '已完成' }] }); await h.loadThreads();
  assert.equal(h.unindexedThreads.size, 0, 'settled native history becomes authoritative');
  h.setList({ data: [] }); await h.loadThreads();
  assert.equal(h.state.threads.length, 0, 'removed or archived threads do not reappear');
});

test('search filters pending entries without discarding them', async () => {
  const h = harness(); h.rememberThread(thread);
  h.search.value = '不匹配'; await h.loadThreads(); assert.equal(h.state.threads.length, 0);
  h.search.value = '首条'; await h.loadThreads(); assert.equal(h.state.threads[0].id, 'new');
  h.search.value = ''; await h.loadThreads(); assert.equal(h.state.threads.length, 1);
});

test('the sidebar limit preserves new running work while keeping newly loaded older pages', async () => {
  const h = harness(); h.rememberThread(thread); h.state.activeTurns.set('new', 'turn');
  h.setList({ data: Array.from({ length: 300 }, (_, i) => ({ id: 'old-' + i, cwd: '/project' })), nextCursor: 'next' });
  await h.loadThreads(); assert.equal(h.state.threads.length, 300); assert.equal(h.state.threads[0].id, 'new');
  h.setList({ data: [{ id: 'old-299' }, ...Array.from({length:30},(_,i)=>({id:'older-'+i}))], nextCursor: null });
  await h.loadThreads(true); assert.equal(h.state.threads.length, 300);
  assert.equal(h.state.threads[0].id,'new');
  assert.equal(h.state.threads.at(-1).id,'older-29','the older page must stay visible as its cursor advances');
  assert.equal(h.state.threads.filter(row => row.id === 'old-299').length, 1);
  assert.equal(h.state.threads.some(row=>row.id==='old-0'),false);
});

test('without protected rows the sidebar retains the native history tail window at 300 entries',async()=>{
  const h=harness();
  h.setList({data:Array.from({length:300},(_,i)=>({id:'old-'+i})),nextCursor:'page-2'});await h.loadThreads();
  h.setList({data:Array.from({length:30},(_,i)=>({id:'older-'+i})),nextCursor:'page-3'});await h.loadThreads(true);
  assert.equal(h.state.threads.length,300);assert.equal(h.state.nextThreads,'page-3');
  assert.equal(h.state.threads[0].id,'old-30');assert.equal(h.state.threads.at(-1).id,'older-29');
});

test('an older list response cannot overwrite a newer search', async () => {
  const h = harness(); let resolve;
  h.setList(new Promise(done => { resolve = done; }));
  const older = h.loadThreads();
  h.setList({ data: [{ id: 'current' }] }); await h.loadThreads();
  resolve({ data: [{ id: 'stale' }] }); await older;
  assert.deepEqual(h.state.threads.map(row => row.id), ['current']);
});
