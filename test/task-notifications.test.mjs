import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaskMonitor,mountTaskNotifications} from '../public/ui/task-notifications.js';
import {createDocument} from './mini-dom.mjs';
const active=(turnId='turn1',phase='working')=>({threadId:'thread1',turnId,state:['question','approval'].includes(phase)?'waiting':'running',phase});
const terminal=(turnId='turn1',state='completed')=>({threadId:'thread1',turnId,state});
const view=(running=[],finished=[],baseline=false)=>({connected:true,running,finished,baseline});
function fixture(){
 const sent=[];
 const monitor=createTaskMonitor({post:data=>sent.push(data),title:()=> '任务\n标题'});
 return {monitor,sent};
}
test('task notifications require opt-in and report each authoritative transition once',()=>{
 const {monitor,sent}=fixture();
 monitor.apply(view([active()]));assert.deepEqual(sent,[]);
 monitor.setEnabled(true);assert.equal(sent.at(-1).title,'任务 标题');
 for(const phase of ['thinking','tool','question','tool','responding']){
   const snapshot=view([active('turn1',phase)]);
   monitor.apply(snapshot);monitor.apply(snapshot);
 }
 assert.deepEqual(sent.map(row=>row.phase),['working','thinking','tool','question','tool','responding']);
 monitor.apply(view([],[terminal()]));assert.equal(sent.at(-1).state,'completed');
 const count=sent.length;monitor.refresh();monitor.apply(view([],[terminal()]));assert.equal(sent.length,count);
});
test('past terminal states are silent on cold start and never replace a newer task',()=>{
 const {monitor,sent}=fixture();monitor.setEnabled(true);
 monitor.apply(view([],[terminal('previous')],true));assert.deepEqual(sent,[]);
 monitor.apply(view([active('one')]));
 monitor.apply(view([active('two')],[terminal('one')]));
 monitor.apply(view([],[terminal('one'),terminal('two','failed')]));
 monitor.apply(view([active('three')],[terminal('two','failed')]));
 monitor.apply(view([],[terminal('two','failed'),terminal('three','interrupted')]));
 assert.deepEqual(sent.map(x=>[x.turnId,x.state]),[['one','running'],['two','running'],['two','failed'],['three','running'],['three','interrupted']]);
});
test('reconnect resumes confirmed work, clears disappeared tasks, and reports confirmed offline completion',()=>{
 const {monitor,sent}=fixture();monitor.setEnabled(true);monitor.apply(view([active()]));
 monitor.disconnected();assert.equal(sent.at(-1).state,'disconnected');
 const count=sent.length;monitor.refresh();assert.equal(sent.length,count);
 monitor.apply(view([active()],[],true));assert.equal(sent.at(-1).state,'running');
 monitor.apply(view());assert.deepEqual(sent.at(-1),{threadId:'thread1',state:'idle'});
 monitor.apply(view([active('new')]));monitor.disconnected();monitor.apply(view([],[terminal('new')],true));
 assert.equal(sent.at(-1).state,'completed');
});
test('reset clears completed notifications too, and invalid native IDs are rejected',()=>{
 const {monitor,sent}=fixture();monitor.setEnabled(true);
 monitor.apply(view([active('bad\nturn')]));assert.deepEqual(sent,[]);
 monitor.apply(view([active()]));monitor.apply(view([],[terminal()]));monitor.reset();
 assert.deepEqual(sent.at(-1),{threadId:'thread1',state:'idle'});
});

test('cold notification clicks wait for readiness and acknowledge only the loaded conversation',async()=>{
 const document=createDocument(),window=new EventTarget(),calls=[];let ready=false,finish;
 for(const id of ['mobile-task-notifications','mobile-task-enabled','mobile-task-status','mobile-task-system-settings']){const node=document.createElement('div');node.id=id;document.body.append(node);}
 window.setInterval=()=>0;
 window.CodexLightNative={getTaskNotificationStatus:()=>JSON.stringify({supported:true,enabled:true,reason:'ready'}),setTaskNotificationsEnabled(){},updateTaskNotification(){},openTaskNotificationSettings(){},taskNotificationOpened:id=>calls.push(['ack',id])};
 const controller=mountTaskNotifications({document,window,snapshot:()=>({connected:ready,canOpen:ready}),resolveTarget:async id=>id==='thread1'?'parent':null,openThread:id=>{calls.push(['open',id]);return new Promise(resolve=>{finish=resolve;});},notice:()=>assert.fail('unexpected failure')});
 window.CodexLightTaskNotifications.open('thread1');assert.deepEqual(calls,[]);
 ready=true;controller.reconcile();window.CodexLightTaskNotifications.open('thread1');await Promise.resolve();assert.deepEqual(calls,[['open','parent']]);
 finish();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls,[['open','parent'],['ack','thread1']]);
});

test('permission toggle awaits native confirmation and stale connection stops heartbeat',()=>{
 const document=createDocument(),window=new EventTarget(),calls=[];let enabled=false,live=true,reads=0,heartbeat;
 for(const id of ['mobile-task-notifications','mobile-task-enabled','mobile-task-status','mobile-task-system-settings']){const node=document.createElement('div');node.id=id;document.body.append(node);}
 window.setInterval=callback=>{heartbeat=callback;};
 window.CodexLightNative={getTaskNotificationStatus:()=>{reads++;return JSON.stringify({supported:true,enabled,reason:enabled?'ready':'disabled'});},setTaskNotificationsEnabled:value=>calls.push(['enable',value]),updateTaskNotification:data=>calls.push(JSON.parse(data)),openTaskNotificationSettings(){}};
 const controller=mountTaskNotifications({document,window,snapshot:()=>({connected:live,canOpen:false,threads:[]}),notice:()=>assert.fail('unexpected failure')});
 const toggle=document.getElementById('mobile-task-enabled');toggle.checked=true;toggle.dispatch('change');assert.equal(reads,1,'no premature native preference read');
 enabled=true;window.dispatchEvent(new Event('codexlight-task-notification-status'));
 controller.apply(view([active()]));assert.equal(calls.at(-1).state,'running');
 live=false;heartbeat();assert.equal(calls.at(-1).state,'disconnected');heartbeat();assert.equal(calls.at(-1).state,'disconnected');
});

test('overlapping history load and send release the newest click once without retries from rendering',async()=>{
 const document=createDocument(),window=new EventTarget(),calls=[];let loading=true,sending=true;
 for(const id of ['mobile-task-notifications','mobile-task-enabled','mobile-task-status','mobile-task-system-settings']){
   const node=document.createElement('div');node.id=id;document.body.append(node);
 }
 window.setInterval=()=>0;
 window.CodexLightNative={getTaskNotificationStatus:()=>JSON.stringify({supported:true,enabled:true,reason:'ready'}),
   setTaskNotificationsEnabled(){},updateTaskNotification(){},openTaskNotificationSettings(){},taskNotificationOpened:id=>calls.push(['ack',id])};
 const controller=mountTaskNotifications({document,window,snapshot:()=>({canOpen:!loading&&!sending,connected:true}),
   resolveTarget:async id=>{calls.push(['read',id]);if(id==='offline')throw new Error('disconnected');return id;},
   openThread:async id=>{calls.push(['open',id]);},notice:()=>{}});
 window.CodexLightTaskNotifications.open('first');
 window.CodexLightTaskNotifications.open('newest');
 loading=false;controller.reconcile();assert.deepEqual(calls,[]);
 sending=false;controller.reconcile();controller.reconcile();await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(calls,[['read','newest'],['open','newest'],['ack','newest']]);
 window.CodexLightTaskNotifications.open('offline');await new Promise(resolve=>setImmediate(resolve));
 for(let i=0;i<6;i++)controller.reconcile();
 assert.deepEqual(calls.filter(call=>call[1]==='offline'),[['read','offline']]);
});

test('mobile settings distinguish Android promotion and ordinary delivery', () => {
  const document = createDocument(), window = new EventTarget();
  for (const id of ['mobile-task-notifications', 'mobile-task-enabled', 'mobile-task-status',
    'mobile-task-system-settings', 'mobile-task-promotion-status', 'mobile-task-promotion-settings']) {
    const node = document.createElement('div');
    node.id = id;
    document.body.append(node);
  }
  const result = {supported: true, enabled: true, reason: 'ready', promotion: 'standard', promotedCandidate: true};
  let opened = 0;
  window.setInterval = () => 0;
  window.CodexLightNative = {
    getTaskNotificationStatus: () => JSON.stringify(result),
    setTaskNotificationsEnabled() {}, updateTaskNotification() {}, openTaskNotificationSettings() {},
    openLiveUpdateSettings() { opened++; }
  };
  mountTaskNotifications({document, window, snapshot: () => ({connected: true, threads: []}), notice: assert.fail});
  const text = document.getElementById('mobile-task-promotion-status');
  const settings = document.getElementById('mobile-task-promotion-settings');
  const refresh = () => window.dispatchEvent(new Event('codexlight-task-notification-status'));
  assert.match(text.textContent, /已发到通知栏，系统暂未/);
  settings.dispatch('click');
  assert.equal(opened, 1);

  for (const [promotion, expected] of [
    ['ready', /开始任务后/], ['promoted', /Android 已将/], ['ineligible', /不符合实时通知条件/],
    ['channel_min', /重要性为最低/], ['blocked', /系统暂不允许/]
  ]) {
    result.promotion = promotion;
    refresh();
    assert.match(text.textContent, expected);
  }
  Object.assign(result, {reason: 'permission_required'});
  refresh();
  assert.equal(text.hidden, true);
  Object.assign(result, {reason: 'ready', promotion: 'unsupported', promotedCandidate: false});
  refresh();
  assert.match(text.textContent, /Android 16 以下/);
  assert.equal(settings.hidden, true);
});

test('the Android real-time switch passes the independent question preference and stops task updates when off', () => {
  const document = createDocument(), window = new EventTarget(), received = [], switches = [];
  let enabled = false;
  for (const id of ['mobile-task-notifications', 'mobile-task-enabled', 'mobile-task-status',
    'mobile-task-system-settings', 'preference-approval']) {
    const node = document.createElement('input');
    node.id = id;
    document.body.append(node);
  }
  window.setInterval = () => 0;
  window.CodexLightNative = {
    getTaskNotificationStatus: () => JSON.stringify({supported: true, enabled,
      reason: enabled ? 'ready' : 'disabled', supportsTaskPhase: true}),
    setTaskNotificationsEnabled: () => assert.fail('used legacy bridge'),
    setRealtimeNotifications(on, questions) {
      switches.push([on, questions]);
      enabled = on;
      window.dispatchEvent(new Event('codexlight-task-notification-status'));
    },
    updateTaskNotification: data => received.push(JSON.parse(data)), openTaskNotificationSettings() {}
  };
  const controller = mountTaskNotifications({document, window, snapshot: () => ({connected:true}), notice: assert.fail});
  controller.apply(view([active()]));
  const toggle = document.getElementById('mobile-task-enabled');
  document.getElementById('preference-approval').checked = true;
  toggle.checked = true;
  toggle.dispatch('change');
  assert.equal(received.at(-1).state, 'running');
  document.getElementById('preference-approval').checked = false;
  toggle.checked = false;
  toggle.dispatch('change');
  const count = received.length;
  controller.apply(view([],[terminal()]));
  assert.equal(received.length, count);
  assert.deepEqual(switches, [[true, true], [false, false]]);
});
