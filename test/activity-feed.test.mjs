import test from 'node:test';
import assert from 'node:assert/strict';
import { mountConversation, describeItem, itemState, renderActivityRecord } from '../public/activity-feed.js';
import { TurnLedger, buildTurns } from '../public/state.js';
import { createDocument, visibleText } from './mini-dom.mjs';
import { createAgentInspector } from '../public/ui/agent-inspector.js';

const user = (id, turnId, text) => ({ id, type: 'userMessage', content: [{ type: 'text', text }], _turnId: turnId, _complete: true });
const agent = (id, turnId, text, phase = null, complete = true) => ({ id, type: 'agentMessage', text, phase, _turnId: turnId, _complete: complete });
const cmd = (id, turnId, extra = {}) => ({ id, type: 'commandExecution', command: 'npm test', status: 'completed', exitCode: 0, aggregatedOutput: 'ok', _turnId: turnId, _complete: true, ...extra });
const change = (id, turnId, path, diff, status = 'completed') => ({ id, type: 'fileChange', status, changes: [{ path, kind: { type: 'update', move_path: null }, diff }], _turnId: turnId, _complete: status !== 'inProgress' });

test('open file-operation diffs survive unrelated progress and preserve both axes when their text changes', () => {
  const { host, view } = mount(), ledger = new TurnLedger(); ledger.merge({ id: 'diff-running', status: 'inProgress' });
  const file = change('patch-live', 'diff-running', 'src/file.js', '@@ -1 +1 @@\n-old\n+new', 'inProgress');
  const render = () => view.render(buildTurns([user('u-live', 'diff-running', 'edit'), file], ledger, { activeTurnId: 'diff-running' }));
  render(); const process = host.querySelector('.turn-process'); process.open = true; const step = host.querySelector('.step'); step.open = true;
  const diff = step.querySelector('.diff-view'); diff.scrollTop = 240; diff.scrollLeft = 120;
  render(); assert.equal(step.querySelector('.diff-view'), diff); assert.equal(diff.scrollTop, 240); assert.equal(diff.scrollLeft, 120);
  file.changes = [{ ...file.changes[0], diff: file.changes[0].diff + '\n+additional line' }]; render();
  assert.equal(step.querySelector('.diff-view'), diff); assert.equal(diff.scrollTop, 240); assert.equal(diff.scrollLeft, 120); assert.match(diff.textContent, /additional line/);
});

test('completed file-summary diff keeps its node and scroll offsets after a corrected diff arrives', () => {
  const { host, view } = mount(), ledger = new TurnLedger(); ledger.merge({ id: 'diff-finished', status: 'completed' });
  const file = change('patch-finished', 'diff-finished', 'src/file.js', '@@ -1 +1 @@\n-old\n+new');
  const render = () => view.render(buildTurns([user('u-finished', 'diff-finished', 'edit'), file, agent('a-finished', 'diff-finished', 'done', 'final_answer')], ledger));
  render(); host.querySelector('.file-row-head').click(); const diff = host.querySelector('.files-card').querySelector('.diff-view'); diff.scrollTop = 180; diff.scrollLeft = 90;
  file.changes = [{ ...file.changes[0], diff: file.changes[0].diff + '\n+corrected line' }]; render();
  assert.equal(host.querySelector('.files-card').querySelector('.diff-view'), diff); assert.equal(diff.scrollTop, 180); assert.equal(diff.scrollLeft, 90); assert.match(diff.textContent, /corrected line/);
});

function mount() {
  const document = createDocument(); const host = document.createElement('div');
  const links = []; const view = mountConversation(host, { onLocalLink: ref => links.push(ref), getCwd: () => 'C:\\proj' });
  return { document, host, view, links };
}
const q = (host, selector) => host.querySelectorAll(selector);

test('live agent events, attributed results, partial replies and questions fold in order with the completed turn', () => {
  const {host,view}=mount(),ledger=new TurnLedger();
  ledger.merge({id:'t',status:'inProgress'});
  const event=(id,kind)=>({id,type:'subAgentActivity',agentThreadId:'child',agentPath:'/root/reviewer',kind,_turnId:'t'});
  const waited={id:'wait',type:'collabAgentToolCall',tool:'wait',status:'completed',receiverThreadIds:['child'],agentsStates:{child:{status:'completed',message:'**检查完毕**'}},_turnId:'t'};
  const question={...agent('question','t','说明','final_answer'),delivery:'async',questions:[{title:'是否继续？'}]};
  const items=[user('ask','t','审阅'),event('start','started'),agent('partial','t','进展','partial_answer'),question,
    user('steer','t','继续'),waited,{...waited,id:'poll'},event('end','completed'),agent('final','t','最终结论','final_answer')];
  view.render(buildTurns(items,ledger,{activeTurnId:'t'}));
  assert.equal(host.querySelectorAll('.agent-reply').length,1);assert.match(host.querySelector('.agent-reply').textContent,/reviewer 的回答.*检查完毕/);
  const turn=host.querySelector('.turn'),reply=host.querySelector('.agent-reply');assert.ok(turn.children.includes(reply));
  ledger.merge({id:'t',status:'completed'});view.render(buildTurns(items,ledger));
  const work=host.querySelector('.turn-work'),body=host.querySelector('.turn-work-body');
  assert.equal(work.open,false);
  assert.deepEqual(body.children.filter(child=>child.dataset.itemId).map(child=>child===reply?'agent result':child.dataset.itemId),['start','partial','question','steer','agent result','end']);
  assert.deepEqual(turn.children.filter(child=>child.dataset.itemId).map(child=>child.dataset.itemId),['ask','final']);
  assert.ok(body.contains(host.querySelector('.async-input-card')));
});

test('repeated DSH status reads show one reply per task and keep it on the reporting turn', () => {
  const {host,view}=mount(),ledger=new TurnLedger();ledger.merge({id:'t',status:'completed'});
  const call=(id,tool,status,answer)=>({id,type:'mcpToolCall',server:'dsh_subagent',tool,status:'completed',_turnId:'t',
    arguments:{agent_id:'child'},result:{structuredContent:{agent_id:'child',name:'helper',status,answer}}});
  const started=call('start','dsh_start','running');
  const end=call('end','dsh_wait','completed','本次任务已检查');
  const next=call('continue','dsh_followup','running');
  const wrong={...end,id:'wrong',arguments:{agent_id:'other'}};
  view.render(buildTurns([user('u','t','检查'),started,end,{...end,id:'polled'},next,wrong,{...end,id:'end2'},agent('a','t','整理完毕','final_answer')],ledger));
  const work=host.querySelector('.turn-work-body');
  assert.equal(work.querySelectorAll('.agent-reply').length,2);assert.equal(work.querySelectorAll('.agent-lifecycle-event').length,4);
  assert.deepEqual(work.querySelectorAll('.agent-reply').map(node=>node.dataset.itemId),['reply:["end","child"]','reply:["end2","child"]']);
});

test('whole-turn feedback spans waiting, thinking and streaming and stops on terminal states', () => {
  const ledger = new TurnLedger(); ledger.merge({ id: 't', status: 'inProgress' }, { observedStartMs: 1000 });
  const { host, view } = mount();
  view.render(buildTurns([], ledger, { activeTurnId: 't' }), { now: 3000 });
  assert.ok(host.querySelector('.turn-working'), 'waiting before the first item still shows running feedback');
  const items = [user('u', 't', '任务')];
  for (const item of [null, { id: 'r', type: 'reasoning', _turnId: 't', _complete: true }, agent('a', 't', '正在回复', 'final_answer', false)]) {
    if (item) items.push(item);
    view.render(buildTurns(items, ledger, { activeTurnId: 't' }), { now: 3000 });
    const feedback = host.querySelector('.turn-working');
    assert.ok(feedback, 'model work must remain visible without a running tool');
    assert.equal(feedback.dataset.running, 'true'); assert.match(feedback.textContent, /正在工作.*2s/);
    assert.equal(view.hasRunningClock(), true); view.tick(4000); assert.match(feedback.textContent, /3s/);
  }
  for (const status of ['completed', 'failed', 'interrupted']) {
    ledger.merge({ id: 't', status, completedAtMs: 5000 }); view.render(buildTurns(items, ledger));
    assert.equal(host.querySelector('.turn-working'), null); assert.equal(view.hasRunningClock(), false);
  }
});

test('context compaction stays visible in chronology between independently collapsed operation groups', () => {
  const ledger = new TurnLedger(); ledger.merge({ id: 't', status: 'inProgress' });
  const compact = { id: 'compact', type: 'contextCompaction', _turnId: 't', _complete: false };
  const items = [user('u', 't', '任务'), cmd('before', 't'), compact, cmd('after', 't')];
  const { host, view } = mount(); view.render(buildTurns(items, ledger, { activeTurnId: 't' }));
  const row = host.querySelector('.compaction-record');
  assert.ok(row); assert.equal(row.tag, 'section'); assert.equal(row.closest('details'), null);
  assert.match(row.textContent, /正在压缩上下文/);
  const turn = host.querySelector('.turn');
  assert.ok(turn.children.indexOf(q(host, '.turn-process')[0]) < turn.children.indexOf(row));
  assert.ok(turn.children.indexOf(row) < turn.children.indexOf(q(host, '.turn-process')[1]));
  assert.ok(q(host, '.turn-process').every(group => !group.open));
  view.render(buildTurns(items.map(item => item.id === 'compact' ? { ...item, _complete: true } : item), ledger));
  assert.equal(host.querySelector('.compaction-record'), row); assert.match(row.textContent, /上下文已压缩/);
  view.render(buildTurns(items.map(item => item.id === 'compact' ? { ...item, _complete: true, status:'failed' } : item), ledger));
  assert.match(row.textContent,/上下文压缩失败/);assert.equal(row.closest('details'),null);
});

test('a collapse is never undone by a render that runs before the queued toggle event',()=>{
  const ledger=new TurnLedger();ledger.merge({id:'t',status:'completed',durationMs:1000});
  const items=[user('u','t','任务'),cmd('c1','t'),change('f','t','src/a.js','@@\n-a\n+b'),agent('a','t','完成','final_answer')];
  const {host,view}=mount();view.render(buildTurns(items,ledger));
  const group=host.querySelector('.turn-process'),summary=group.querySelector('.turn-process-summary');
  summary.dispatch('click');group.open=true;assert.equal(group.open,true);
  const row=group.querySelector('.file-step');row.open=true;row.open=false;
  // Browser order under scroll clamping: click → default action closes → render → toggle event.
  summary.dispatch('click');group._open=false;
  view.render(buildTurns(items,ledger));
  assert.equal(group.open,false,'render must not re-open a group the user just collapsed');
  for(let i=0;i<3;i++){summary.dispatch('click');group._open=!group._open;view.render(buildTurns(items,ledger));}
  assert.equal(group.open,true,'later toggles keep following the user');
});

test('each visible model utterance closes the preceding operation group and keyed open choice survives streaming',()=>{
  const ledger=new TurnLedger();ledger.merge({id:'t',status:'inProgress'});
  const items=[user('u','t','任务'),agent('a','t','先检查。','commentary'),cmd('c1','t'),agent('b','t','继续修改。','commentary'),cmd('c2','t',{status:'inProgress',_complete:false})];
  const {host,view}=mount();view.render(buildTurns(items,ledger,{activeTurnId:'t'}));
  const groups=q(host,'.turn-process');assert.equal(groups.length,2);assert.ok(groups.every(group=>!group.open));
  assert.equal(groups[0].dataset.running,'false');assert.equal(groups[1].dataset.running,'true');
  assert.deepEqual(q(host,'.agentMessage').map(node=>node.dataset.itemId),['a','b']);
  groups[0].open=true;
  view.render(buildTurns([...items.slice(0,-1),{...items.at(-1),aggregatedOutput:'new output'}],ledger,{activeTurnId:'t'}));
  assert.equal(q(host,'.turn-process')[0],groups[0]);assert.equal(groups[0].open,true);
});

test('reasoning durations use a real start and tick text without opening its operation group',()=>{
  const ledger=new TurnLedger();ledger.merge({id:'t',status:'inProgress'});
  const reasoning={id:'r',type:'reasoning',_turnId:'t',_complete:false};
  const {host,view}=mount();view.render(buildTurns([user('u','t','x'),reasoning],ledger,{activeTurnId:'t'}));
  assert.equal(q(host,'.step-target')[0].textContent,'');
  view.render(buildTurns([user('u','t','x'),{...reasoning,_startedAtMs:1000}],ledger,{activeTurnId:'t'}));
  const group=q(host,'.turn-process')[0];view.tick(4000);
  assert.equal(q(host,'.step-verb')[0].textContent,'思考中');assert.equal(q(host,'.step-target')[0].textContent,'3 秒');
  assert.equal(group.open,false);assert.match(group.querySelector('.turn-process-latest').textContent,/3 秒/);
});

test('completed turn collapses intermediate work beneath timing above final answer', () => {
  const ledger = new TurnLedger(); ledger.merge({ id: 't1', status: 'completed', durationMs: 18000 });
  const items = [user('u1', 't1', '整理文档'), agent('c1', 't1', '我先看一下文件。', 'commentary'), { id: 'r1', type: 'reasoning', summary: ['检查结构'], _turnId: 't1', _complete: true }, cmd('x1', 't1'), agent('f1', 't1', '已完成 **整理**。', 'final_answer')];
  const { host, view } = mount(); view.render(buildTurns(items, ledger));
  const process = q(host, '.turn-process')[0];
  assert.equal(process.open, false, 'finished process collapses by default');
  assert.equal(process.querySelector('.turn-process-label').textContent, '2 项操作');
  assert.equal(q(host,'.turn-work-label')[0].textContent,'用时 18s');
  const answers = q(host, '.agentMessage').filter(node => !node.classList.contains('process-note'));
  assert.equal(answers.length, 2); assert.equal(answers[1].dataset.itemId, 'f1');
  assert.ok(!process.contains(answers[0]), 'final answer is outside the collapsed process');
  const work=host.querySelector('.turn-work'); assert.equal(work.open,false); assert.ok(work.contains(answers[0]), 'commentary folds into work'); assert.ok(!work.contains(answers[1]), 'final stays visible'); assert.ok(host.querySelector('.turn').children.indexOf(work)<host.querySelector('.turn').children.indexOf(answers[1])); work.open=true; view.render(buildTurns(items,ledger)); assert.equal(work.open,true,'manual expansion survives rendering');
  assert.equal(q(host, '.step').length, 2, 'reasoning + command are steps');
  assert.equal(answers[1].querySelector('strong').textContent, '整理');
});

test('running operations stay collapsed while commentary remains visible', () => {
  const ledger = new TurnLedger(); ledger.merge({ id: 't2', status: 'inProgress', startedAt: 1000 });
  const items = [user('u', 't2', '跑测试'), agent('c', 't2', '先运行', 'commentary'), cmd('x', 't2', { status: 'inProgress', exitCode: null, _complete: false })];
  const { host, view } = mount(); view.render(buildTurns(items, ledger, { activeTurnId: 't2' }), { now: 1000 * 1000 + 65000 });
  const process = q(host, '.turn-process')[0];
  assert.equal(process.open, false); assert.equal(process.dataset.running, 'true');
  assert.equal(process.querySelector('.turn-process-label').textContent, '1 项操作 · 运行中');
  view.tick(1000 * 1000 + 70000);
  assert.equal(process.querySelector('.turn-process-label').textContent, '1 项操作 · 运行中');
  assert.equal(q(host, '.step')[0].querySelector('.step-state').textContent, '进行中');
});

test('running operation headers stop their feedback on terminal items and terminal turns', () => {
  const ledger = new TurnLedger(); ledger.merge({ id:'live', status:'inProgress' });
  const live = cmd('operation', 'live', { status:'inProgress', exitCode:null, _complete:false });
  const {host,view} = mount();
  const render = item => view.render(buildTurns([user('u','live','检查'),item],ledger,{activeTurnId:'live'}));
  render(live);
  const group = host.querySelector('.turn-process'), row = host.querySelector('.step');
  assert.equal(group.dataset.running,'true'); assert.equal(row.dataset.running,'true');
  assert.equal(group.open,false);
  for (const status of ['completed','failed','interrupted']) {
    render({...live,status});
    assert.equal(host.querySelector('.step'),row);
    assert.equal(row.dataset.running,'false'); assert.equal(group.dataset.running,'false');
  }
  render(live);
  for (const status of ['completed','failed','interrupted']) {
    ledger.merge({id:'live',status}); view.render(buildTurns([user('u','live','检查'),live],ledger));
    assert.equal(group.dataset.running,'false'); assert.equal(row.dataset.running,'false','stale running item cannot revive terminal turn feedback');
  }
});


test('native and DSH inspector operations stop feedback when the parent task settles', async () => {
  for (const native of [true,false]) {
    const document=createDocument(),host=document.createElement('div');document.body.append(host);
    const el=(tag,cls,text)=>{const node=document.createElement(tag);node.className=cls;if(text!=null)node.textContent=text;return node;};
    let status='inProgress';
    const row={threadId:'parent',agentId:'child',status:'running'};
    const state={connected:true,thread:{id:'parent'},dshReadErrors:new Map(),store:{values:()=>native?[{id:'spawn',type:'collabAgentToolCall',tool:'spawnAgent',receiverThreadIds:['child'],agentsStates:{child:{status:'running'}}}]:[]}};
    const live={selectedAgentId:'child',selected:{events:[{seq:1,type:'command/start',details:{command:'npm test',status:'inProgress'}}]}};
    const inspector=createAgentInspector({document,state,host,el,dshTasks:{values:()=>native?[]:[row]},dshLive:{selectAgent(){},snapshot:()=>live},readDshTask:async()=>{},
      rpc:async()=>({thread:{id:'child',turns:[{id:'t',status,items:[cmd('c','t',{status:'inProgress',exitCode:null,_complete:false})]}]}})});
    inspector.render();assert.equal(inspector.open('child',native?'native':'dsh'),true);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(host.querySelector('.agent-operation-group').dataset.running,'true');
    assert.equal(host.querySelector('.step').dataset.running,'true');
    for(const settled of ['completed','interrupted','failed']) {
      status=settled;row.status=settled==='failed'?'error':settled;
      if(native){inspector.refresh();await new Promise(resolve=>setImmediate(resolve));}else inspector.render();
      assert.equal(host.querySelector('.agent-operation-group').dataset.running,'false');
      assert.equal(host.querySelector('.step').dataset.running,'false');
    }
  }
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
  assert.equal(q(host, '.turn-work-label')[0].textContent, '用时约 12s');
  ({ host, view } = mount()); view.render(buildTurns([user('u', 'h', 'x'), cmd('c', 'h'), agent('f', 'h', 'done')], ledger));
  const label = q(host, '.turn-process-label')[0].textContent;
  assert.doesNotMatch(label, /0s/); assert.equal(label, '1 项操作');assert.equal(q(host,'.turn-footer').length,0);
});

test('legacy messages without phase: last agent message of a finished turn is the answer; running turn has none', () => {
  const ledger = new TurnLedger(); ledger.merge({ id: 'l', status: 'completed', durationMs: 2000 });
  const items = [user('u', 'l', 'x'), agent('a1', 'l', '中间说明'), cmd('c', 'l'), agent('a2', 'l', '结论')];
  const turns = buildTurns(items, ledger);
  assert.deepEqual(turns[0].segments[0].answers.map(item => item.id), ['a2']);
  assert.deepEqual(turns[0].segments[0].process.map(item => item.id), ['a1', 'c']);
  const runningLedger = new TurnLedger(); runningLedger.merge({ id: 'l', status: 'inProgress' });
  assert.deepEqual(buildTurns(items, runningLedger, { activeTurnId: 'l' })[0].segments[0].answers, []);
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
  assert.deepEqual([...q(host, '.turn-work-label'), ...q(host, '.turn-footer')].map(node => node.textContent), ['已停止', '任务失败：quota']);
});

test('completed edits list every path with its own collapsed diff', () => {
  const ledger = new TurnLedger(); ledger.merge({ id: 'd', status: 'completed', durationMs: 1000 });
  const items = [user('u', 'd', 'edit')];
  for (let i = 0; i < 5; i++) items.push(change('f' + i, 'd', `C:\\proj\\src\\file${i}.js`, `@@ -1 +1,2 @@\n-a\n+b\n+c\n`));
  items.push(change('dup', 'd', 'C:/proj/src/file0.js', '@@ -2 +2 @@\n-c\n+d\n'));
  const { host, view } = mount(); view.render(buildTurns(items, ledger, { cwd: 'C:\\proj' }));
  const card = q(host, '.files-card')[0];
  assert.equal(card.querySelector('.files-title').textContent,'已编辑 5 个文件');
  const batch=card.querySelector('.file-batch');assert.equal(batch.open,false);batch.open=true;
  assert.ok(q(card,'.file-row-head').every(button=>button.getAttribute('aria-expanded')==='false'));
  assert.equal(q(card, '.diff-view').length, 0);
  assert.equal(q(card, '.file-row').length, 5);
  assert.equal(q(card, '.file-stats')[0].textContent, '+3-2');
  assert.equal(q(card, '.file-row')[0].querySelector('.file-name').textContent, 'src/file0.js');
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
  assert.equal(turn.files.added, 1, 'known totals survive an unknown binary file');
  assert.equal(turn.files.unknownCount,1);assert.equal(turn.files.complete,false);
  const { host, view } = mount(); view.render([turn]);
  assert.equal(q(host,'.file-stats')[0].textContent,'+1-1');
  assert.match(q(host,'.file-stats')[1].textContent,/二进制/);
});

test('live edits remain inspectable without showing a premature terminal file summary', () => {
  const ledger = new TurnLedger(); ledger.merge({ id: 'r', status: 'inProgress' });
  const turns = buildTurns([user('u', 'r', 'x'), change('c', 'r', 'C:/proj/a.md', '@@ -0,0 +1 @@\n+hi\n', 'inProgress')], ledger, { activeTurnId: 'r', cwd: 'C:/proj' });
  const { host, view } = mount(); view.render(turns);
  assert.equal(q(host,'.files-card').length,0,'running work has no terminal file summary');
  assert.equal(q(host,'.step-verb')[0].textContent,'编辑');
});

test('collapsed file steps show real added and removed counts in chat and agent activity',()=>{
 const ledger=new TurnLedger();ledger.merge({id:'stats',status:'inProgress'});
 const item=change('file','stats','C:/proj/a.js','@@ -1 +1,2 @@\n-old\n+new\n+second\n');
 const {host,view}=mount();view.render(buildTurns([user('ask','stats','change'),item],ledger,{activeTurnId:'stats',cwd:'C:/proj'}));
 assert.match(q(host,'.step-change-stats')[0].textContent,/\+2-1/);
 const record=renderActivityRecord(host.ownerDocument,item);assert.match(record.querySelector('.step-change-stats').textContent,/\+2-1/);
 item.changes.push({path:'C:/proj/b.js',kind:'add',diff:'created\n'});
 const render=()=>view.render(buildTurns([user('ask','stats','change'),cmd('before','stats'),item,cmd('after','stats')],ledger,{activeTurnId:'stats',cwd:'C:/proj'}));
 render();
 const group=host.querySelector('.turn-process'); group.open=true;
 const batch=group.querySelector('.file-batch');assert.equal(batch.open,false);
 assert.equal(batch.querySelector('.files-title').textContent,'已编辑 2 个文件');
 batch.open=true;assert.ok(q(batch,'.file-step').every(record=>!record.open));
 const rows=q(group,'.step'), file=rows[1], created=rows[2];
 assert.deepEqual(rows.map(row=>row.querySelector('.step-verb').textContent),['已运行','已编辑','已创建','已运行']);
 assert.equal(file.parentElement,created.parentElement);
 assert.equal(q(group,'.diff-view').length,0);
 assert.equal(created.querySelector('.step-change-stats').textContent,'+1-0');
 created.open=true;assert.match(created.querySelector('.diff-view').textContent,/created/);
 item.changes[0].diff=null;render();
 assert.equal(q(group,'.file-step')[1],created);assert.equal(created.open,true);
 assert.equal(file.open,false);assert.match(file.querySelector('.step-change-stats').textContent,/行数未知/);
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

test('streaming preserves closed Markdown blocks, updates the projected turn and reparses an unfinished fence', () => {
  const ledger = new TurnLedger(); ledger.merge({id:'t',status:'inProgress'});
  const {host,view} = mount();
  const item = agent('a','t','参见 [a.md](C:/tmp/a.md)\n\n~~~js\nconst','final_answer',false);
  const turns = buildTurns([item],ledger,{activeTurnId:'t'});
  view.render(turns);
  const link = q(host,'.md-file-link')[0];
  assert.ok(link);
  const updated = {...item,text:item.text+' n = 1;\n\nstill code\n~~~\n\n**end**'};
  assert.ok(view.updateStreamingAnswer(updated));
  assert.equal(q(host,'.md-file-link')[0],link);
  assert.equal(q(host,'strong').at(-1).textContent,'end');
  assert.match(q(host,'code').at(-1).textContent,/\n\nstill code/);
  assert.equal(turns[0].items[0],updated);
  assert.equal(turns[0].segments[0].answers[0],updated);
  view.render(turns); // A scroll-driven viewport render must not bring back the old text.
  assert.match(visibleText(host),/end/);
  assert.equal(view.updateStreamingAnswer({...updated,text:updated.text+' ![image](C:/tmp/img.png)'}),true);
  assert.equal(host.querySelector('.md-image-source').getAttribute('data-path'),'C:/tmp/img.png');
  assert.equal(view.updateStreamingAnswer({...updated,delivery:'async',questions:[{title:'Proceed?'}]}),false);
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

test('virtual unmount preserves a long message reading segment without retaining its DOM',()=>{
 const {host,view}=mount();const ledger=new TurnLedger();ledger.merge({id:'long-turn',status:'completed'});
 const list=buildTurns([agent('long-answer','long-turn','paragraph '.repeat(16000),'final_answer')],ledger);
 view.render(list);const buttons=q(host,'button');const next=buttons.find(n=>n.textContent==='下一段');assert.ok(next);next.click();
 const position=host.querySelector('.long-text-position').textContent;
 view.render([]);assert.equal(q(host,'.message').length,0);view.render(list);
 assert.equal(host.querySelector('.long-text-position').textContent,position);
 view.clear();view.render(list);assert.notEqual(host.querySelector('.long-text-position').textContent,position);
});
test('live render anchors visible message, not only turn top when an earlier sibling changes height',()=>{
 const document=createDocument(),scroller=document.createElement('section'),host=document.createElement('div');scroller.id='conversation';scroller.append(host);
 Object.assign(scroller,{scrollTop:100,scrollHeight:2000,clientHeight:500});scroller.getBoundingClientRect=()=>({top:0,bottom:500,height:500});host.getBoundingClientRect=()=>({top:-scroller.scrollTop,bottom:1900,height:2000});
 const view=mountConversation(host),ledger=new TurnLedger();ledger.merge({id:'t',status:'completed'});
 const data=text=>buildTurns([user('u','t',text),agent('a','t','reading','final_answer')],ledger);
 view.render(data('short'));const turn=host.querySelector('.turn'),u=host.querySelector('[data-item-id="u"]'),a=host.querySelector('[data-item-id="a"]');
 turn.getBoundingClientRect=()=>({top:-scroller.scrollTop,bottom:1000-scroller.scrollTop,height:1000});u.getBoundingClientRect=()=>({top:-scroller.scrollTop,bottom:50-scroller.scrollTop,height:50});
 a.getBoundingClientRect=()=>{const top=120+(u.textContent.includes('longer')?102:0)-scroller.scrollTop;return {top,bottom:top+50,height:50};};
 const before=a.getBoundingClientRect().top;view.render(data('longer'));assert.equal(a.getBoundingClientRect().top,before);assert.equal(scroller.scrollTop,202);
});
