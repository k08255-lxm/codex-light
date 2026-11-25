import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaskMonitor,mountTaskNotifications} from '../public/ui/task-notifications.js';
import {createDocument} from './mini-dom.mjs';
function fixture(){
 const sent=[];let waits=false;
 const monitor=createTaskMonitor({post:data=>sent.push(data),title:()=> '任务\n标题',waiting:()=>waits});
 return {monitor,sent,setWaiting:value=>{waits=value;},event:(method,id='turn1',status)=>monitor.observe({method,params:{threadId:'thread1',turn:{id,status}}})};
}
test('task notifications require opt-in and report only confirmed turn results',()=>{
 const f=fixture();f.event('turn/started');assert.equal(f.sent.length,0);
 f.monitor.setEnabled(true);assert.equal(f.sent.at(-1).state,'running');assert.equal(f.sent.at(-1).title,'任务 标题');
 f.setWaiting(true);f.monitor.refresh();assert.equal(f.sent.at(-1).state,'waiting');
 f.setWaiting(false);f.monitor.refresh();assert.equal(f.sent.at(-1).state,'running');
 f.event('turn/completed','turn1','completed');assert.equal(f.sent.at(-1).state,'completed');
 const count=f.sent.length;f.monitor.refresh();f.event('turn/completed','turn1','completed');assert.equal(f.sent.length,count);
 f.monitor.reconcile([{threadId:'thread1',activeTurnId:'turn1'}],true);assert.equal(f.sent.length,count);
});
test('old results never replace a newer task; failed and interrupted remain distinct',()=>{
 const f=fixture();f.monitor.setEnabled(true);f.event('turn/started');f.event('turn/started','turn2');
 const count=f.sent.length;f.event('turn/completed','turn1','completed');assert.equal(f.sent.length,count);
 f.event('turn/completed','turn2','failed');assert.equal(f.sent.at(-1).state,'failed');
 f.event('turn/started','turn3');f.event('turn/completed','turn3','interrupted');assert.equal(f.sent.at(-1).state,'interrupted');
});
test('foreground activity reports transitions once and resumes the active phase after a question',()=>{
 const f=fixture();f.monitor.setEnabled(true);f.event('turn/started');
 const event=(method,values)=>f.monitor.observe({method,params:{threadId:'thread1',turnId:'turn1',...values}});
 event('item/started',{item:{id:'thought',type:'reasoning'}});
 event('item/reasoning/summaryTextDelta',{itemId:'thought',delta:'private'});
 assert.deepEqual(f.sent.map(item=>item.phase),['working','thinking']);
 event('item/started',{item:{id:'tool',type:'mcpToolCall'}});
 f.setWaiting('question');f.monitor.refresh();assert.equal(f.sent.at(-1).phase,'question');
 f.setWaiting(false);f.monitor.refresh();assert.equal(f.sent.at(-1).phase,'tool');
 event('item/completed',{item:{id:'tool',type:'mcpToolCall'}});
 assert.equal(f.sent.at(-1).phase,'thinking');
 event('item/agentMessage/delta',{itemId:'text',delta:'private'});assert.equal(f.sent.at(-1).phase,'responding');
 assert.doesNotMatch(JSON.stringify(f.sent),/private/);
});
test('disconnect stops live heartbeats until an authoritative snapshot resumes work',()=>{
 const f=fixture();f.monitor.setEnabled(true);f.event('turn/started');f.monitor.disconnected();
 assert.equal(f.sent.at(-1).state,'disconnected');const count=f.sent.length;f.monitor.refresh();assert.equal(f.sent.length,count);
 f.monitor.reconcile([{threadId:'thread1',activeTurnId:'turn1'}],true);assert.equal(f.sent.at(-1).state,'running');
 f.monitor.reconcile([],true);assert.equal(f.sent.at(-1).state,'disconnected');
 f.event('turn/completed','turn1','completed');assert.equal(f.sent.at(-1).state,'completed','idle session snapshot precedes terminal event in the real server');
});
test('reset clears completed notifications too, and invalid native IDs are rejected',()=>{
 const f=fixture();f.monitor.setEnabled(true);f.event('turn/started','bad\nturn');assert.equal(f.sent.length,0);
 f.event('turn/started');f.event('turn/completed','turn1','completed');f.monitor.reset();
 assert.deepEqual(f.sent.at(-1),{threadId:'thread1',state:'idle'});
});

test('cold notification clicks wait for readiness and acknowledge only the loaded conversation',async()=>{
 const document=createDocument(),window=new EventTarget(),calls=[];let ready=false,finish;
 for(const id of ['mobile-task-notifications','mobile-task-enabled','mobile-task-status','mobile-task-system-settings']){const node=document.createElement('div');node.id=id;document.body.append(node);}
 window.setInterval=()=>0;
 window.CodexLightNative={getTaskNotificationStatus:()=>JSON.stringify({supported:true,enabled:true,reason:'ready'}),setTaskNotificationsEnabled(){},updateTaskNotification(){},openTaskNotificationSettings(){},taskNotificationOpened:id=>calls.push(['ack',id])};
 const controller=mountTaskNotifications({document,window,snapshot:()=>({connected:ready,canOpen:ready,threads:[]}),openThread:id=>{calls.push(['open',id]);return new Promise(resolve=>{finish=resolve;});},notice:()=>assert.fail('unexpected failure')});
 window.CodexLightTaskNotifications.open('thread1');assert.deepEqual(calls,[]);
 ready=true;controller.reconcile();window.CodexLightTaskNotifications.open('thread1');assert.deepEqual(calls,[['open','thread1']]);
 finish();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls,[['open','thread1'],['ack','thread1']]);
});

test('permission toggle awaits native confirmation and stale connection stops heartbeat',()=>{
 const document=createDocument(),window=new EventTarget(),calls=[];let enabled=false,live=true,reads=0,heartbeat;
 for(const id of ['mobile-task-notifications','mobile-task-enabled','mobile-task-status','mobile-task-system-settings']){const node=document.createElement('div');node.id=id;document.body.append(node);}
 window.setInterval=callback=>{heartbeat=callback;};
 window.CodexLightNative={getTaskNotificationStatus:()=>{reads++;return JSON.stringify({supported:true,enabled,reason:enabled?'ready':'disabled'});},setTaskNotificationsEnabled:value=>calls.push(['enable',value]),updateTaskNotification:data=>calls.push(JSON.parse(data)),openTaskNotificationSettings(){}};
 const controller=mountTaskNotifications({document,window,snapshot:()=>({connected:live,canOpen:false,threads:[]}),notice:()=>assert.fail('unexpected failure')});
 const toggle=document.getElementById('mobile-task-enabled');toggle.checked=true;toggle.dispatch('change');assert.equal(reads,1,'no premature native preference read');
 enabled=true;window.dispatchEvent(new Event('codexlight-task-notification-status'));
 controller.observe({method:'turn/started',params:{threadId:'thread1',turn:{id:'turn1'}}});assert.equal(calls.at(-1).state,'running');
 live=false;heartbeat();assert.equal(calls.at(-1).state,'disconnected');heartbeat();assert.equal(calls.at(-1).state,'disconnected');
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
  const controller = mountTaskNotifications({document, window, snapshot: () => ({
    connected: true, threads: [{threadId: 'thread1', activeTurnId: 'turn1'}]
  }), notice: assert.fail});
  const toggle = document.getElementById('mobile-task-enabled');
  document.getElementById('preference-approval').checked = true;
  toggle.checked = true;
  toggle.dispatch('change');
  assert.equal(received.at(-1).state, 'running');
  document.getElementById('preference-approval').checked = false;
  toggle.checked = false;
  toggle.dispatch('change');
  const count = received.length;
  controller.observe({method: 'turn/completed', params: {threadId: 'thread1', turn: {id: 'turn1', status: 'completed'}}});
  assert.equal(received.length, count);
  assert.deepEqual(switches, [[true, true], [false, false]]);
});
