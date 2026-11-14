import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocument} from './mini-dom.mjs';
import {OptimisticMessages} from '../public/ui/optimistic-messages.js';
async function composerHarness({ mutation } = {}) {
  const { createComposer } = await import('../public/ui/composer.js');
  const { FollowUpQueue } = await import('../public/state.js');
  const { ItemStore } = await import('../public/store.js');
  const document = createDocument(); const nodes = new Map();
  const $ = id => { if (!nodes.has(id)) { const n = document.createElement('div'); n.id = id; n.className = 'hidden'; nodes.set(id, n); } return nodes.get(id); };
  $('prompt').value = '';
  const host=document.createElement('section');host.append($('messages'));document.body.append(host);const calls = [];
  const state = { thread: { id: 't', cwd: '/p' }, cwd: '/p', busy: false, turnId: 'turn-1', connected: true, serverInstance: 'a'.repeat(32), sending: false, loadingThread: false, uploadingImages: false, store: new ItemStore(), ledger: { activate() {}, merge() {} }, activeTurns: new Map(), terminalTurns: new Set(), openGeneration: 1, reasoning: {}, models: [], dshReadErrors: new Map(), dshOpenDetails: new Set() };
  const followUps = new FollowUpQueue();
  const empty = { values: () => [], ids: () => [], remove() {} };
  const composer = createComposer({ document,
    session: { state, followUps,sessionControls:{snapshot:()=>({permission:null,serviceTier:null}),params:()=>({})}, sessionFor: id => id === 't' && state.busy ? { activeTurnId: state.turnId } : null },
    drafts: { attachmentDraft: empty, fileAttachmentDraft: empty, attachmentPreviews: new Map(), queuedPreviews: new Map(), clearSubmittedDraft: env => { if (!env.preserveText && $('prompt').value.trim() === env.params.input[0].text) $('prompt').value = ''; }, renderAttachments() {}, autosizePrompt() {} },
    ledger: { performMutation: async (method, params, extras={}) => { extras.onRequest?.({requestId:'r'+calls.length}); calls.push([method, structuredClone(params)]); return mutation ? mutation(method, params) : method === 'turn/steer' ? { turnId: 'turn-1' } : { turn: { id: 'turn-2', status: 'inProgress' } }; }, pendingMutations: { storageError: null }, scopedPending: () => [], currentSendAvailability: () => ({ disabled: false }), renderPendingMutations() {} },
    thread: { restoreThreadReasoning() {}, loadThreads: async () => {}, syncStatus: async () => {}, resetThreadDsh() {} },
    view: { $, el: (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }, notice: (...a) => calls.push(['notice', ...a]), activity() {}, confirm: () => true, updateControls() {}, renderMessages() {}, scheduleRender() {}, scrollBottom() {}, renderContext() {}, openProjectDialog() {}, openInlineCwd() {} } });
  return { composer, state, followUps, calls, $, host };
}

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}};
const rows=h=>h.host.querySelectorAll('.optimistic-message');
test('send is visible before RPC resolves, double click dispatches once, echo reconciles',async()=>{
 const d=deferred(),h=await composerHarness({mutation:()=>d.promise});h.$('prompt').value='hello';const sending=h.composer.send();
 assert.equal(rows(h).length,1);assert.equal(rows(h)[0].dataset.status,'sending');assert.equal(h.$('prompt').value,'');await h.composer.send();assert.equal(h.calls.length,1);
 h.$('prompt').value='new draft';d.resolve({turn:{id:'turn-2',status:'completed'}});await sending;assert.equal(h.$('prompt').value,'new draft');assert.equal(rows(h)[0].dataset.status,'accepted');
 h.state.store.upsert({id:'echo',type:'userMessage',_turnId:'turn-2',content:[{type:'text',text:'hello'}]});h.composer.renderOptimistic();assert.equal(rows(h).length,0);
});
test('certain failure restores text and enables retry; unknown never offers retry',async()=>{
 for(const outcome of ['notExecuted','unknown','failed']){
  const h=await composerHarness({mutation:()=>{throw Object.assign(new Error('fixture'),{outcome})}});h.$('prompt').value='safe';await h.composer.send();
  assert.equal(rows(h)[0].dataset.status,outcome);const retry=rows(h)[0].querySelectorAll('button').find(x=>x.textContent==='重新发送');
  assert.equal(Boolean(retry),outcome==='notExecuted');if(retry)assert.equal(retry.disabled,false);
  assert.equal(h.$('prompt').value,outcome==='notExecuted'?'safe':'');assert.equal(h.calls.filter(x=>x[0]==='turn/start').length,1);
 }
});
test('thread changes isolate pending bubbles and late acknowledgement preserves new input',async()=>{
 const d=deferred(),h=await composerHarness({mutation:()=>d.promise});h.$('prompt').value='original';const sending=h.composer.send();
 h.state.thread={id:'other'};h.state.openGeneration++;h.$('prompt').value='other draft';h.composer.renderOptimistic();assert.equal(rows(h).length,0);
 d.resolve({turn:{id:'turn-2'}});await sending;assert.equal(h.$('prompt').value,'other draft');assert.equal(rows(h).length,0);
 h.state.thread={id:'t'};h.composer.renderOptimistic();assert.equal(rows(h).length,1);
});
test('empty input sends nothing',async()=>{const h=await composerHarness();await h.composer.send();assert.equal(h.calls.length,0);assert.equal(rows(h).length,0)});
test('operation resolution uses ID and canonical turn, never similar text from another turn',()=>{
 const s=new OptimisticMessages(),r=s.begin({threadId:'t',generation:1,text:'same',images:[{id:'i',name:'a.png',data:'secret'}]});s.patch(r.id,{requestId:'r',status:'unknown'});
 assert.deepEqual(r.images,[{id:'i',name:'a.png'}]);s.resolve('other','succeeded',{turn:{id:'wrong'}});assert.equal(r.status,'unknown');s.resolve('r','succeeded',{turn:{id:'right'}});
 s.reconcile('t',[{id:'a',type:'userMessage',_turnId:'wrong',content:[{type:'text',text:'same'}]}]);assert.equal(s.rows.size,1);
 s.reconcile('t',[{id:'b',type:'userMessage',_turnId:'right',content:[{type:'text',text:'same'}]}]);assert.equal(s.rows.size,0);
});
test('attachment-only echo and late thread creation are scoped without replay',()=>{
 const s=new OptimisticMessages(),r=s.begin({threadId:'t',generation:1,text:'',files:[{id:'f',name:'readme'}]});s.patch(r.id,{status:'accepted',turnId:'turn'});s.reconcile('t',[{id:'a',type:'userMessage',_turnId:'turn',content:[{type:'text',text:'file reference'}]}]);assert.equal(s.rows.size,0);
 const draft=s.begin({generation:2,text:'draft',method:'thread/start'});s.patch(draft.id,{requestId:'r'});s.resolve('r','succeeded',{thread:{id:'new'}});assert.equal(draft.status,'notExecuted');assert.equal(s.visible(null,2).length,0);assert.equal(s.visible('new',3).length,1);
});

test('confirmed nonexecution retry replaces old bubble, not a second duplicate',async()=>{
 let count=0;const h=await composerHarness({mutation:()=>{count++;if(count===1)throw Object.assign(new Error('not sent'),{outcome:'notExecuted'});return new Promise(()=>{})}});h.$('prompt').value='retry';await h.composer.send();
 const button=rows(h)[0].querySelectorAll('button')[0];button.click();button.click();assert.equal(count,2);assert.equal(rows(h).length,1);assert.equal(rows(h)[0].dataset.status,'sending');
});
