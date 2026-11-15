import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const source=app.slice(app.indexOf('function syncSettingsFolderPicker('),app.indexOf('function setProjectBusy('));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};};
function harness({pick=async()=>({path:'\\\\wsl.localhost\\Ubuntu\\home\\lee\\Project'})}={}){
  const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,{hidden:true,disabled:false,value:'/original'});return nodes.get(id);};
  const state={lan:false,sending:false,settingsPage:'general',cwd:'/original',thread:{id:'original'}};
  const projectsState={canPickFolder:true,busy:false};const calls=[],notices=[];
  const api=async(...args)=>{calls.push(args);return pick(...args);};
  const functions=new Function('$','state','projectsState','api','notice',`let currentRoute='settings';${source};return {syncSettingsFolderPicker,pickSettingsFolder,route(name){currentRoute=name;}};`)($,state,projectsState,api,(...args)=>notices.push(args));
  return {...functions,$,state,projectsState,calls,notices};
}

test('native folder selection fills the settings draft without saving or retargeting work',async()=>{
  const h=harness();h.syncSettingsFolderPicker();assert.equal(h.$('settings-cwd-browse').hidden,false);
  await h.pickSettingsFolder();
  assert.equal(h.$('cwd-input').value,'\\\\wsl.localhost\\Ubuntu\\home\\lee\\Project');
  assert.equal(h.state.cwd,'/original');assert.equal(h.state.thread.id,'original');
  assert.deepEqual(h.calls.map(row=>row[0]),['/api/desktop/pick-folder']);
});

test('cancel preserves input; duplicate clicks share no second native dialog',async()=>{
  const pending=deferred(),h=harness({pick:()=>pending.promise});
  const first=h.pickSettingsFolder();assert.equal(h.$('settings-cwd-browse').disabled,true);
  await h.pickSettingsFolder();assert.equal(h.calls.length,1);
  pending.resolve({path:null});await first;
  assert.equal(h.$('cwd-input').value,'/original');assert.equal(h.$('settings-cwd-browse').disabled,false);
});

test('late results cannot overwrite edited input or another page; errors stay visible',async()=>{
  for(const change of [h=>{h.$('cwd-input').value='/edited';},h=>h.route('chat')]){
    const pending=deferred(),h=harness({pick:()=>pending.promise});const first=h.pickSettingsFolder();
    change(h);pending.resolve({path:'/picked'});await first;assert.notEqual(h.$('cwd-input').value,'/picked');
  }
  const h=harness({pick:async()=>{throw Error('native unavailable');}});await h.pickSettingsFolder();
  assert.match(h.notices[0][0],/native unavailable/);assert.equal(h.notices[0][1],true);
});

test('LAN and windows without the native capability never open a folder picker',async()=>{
  for(const field of ['lan','capability']){
    const h=harness();if(field==='lan')h.state.lan=true;else h.projectsState.canPickFolder=false;
    h.syncSettingsFolderPicker();assert.equal(h.$('settings-cwd-browse').hidden,true);
    await h.pickSettingsFolder();assert.equal(h.calls.length,0);
  }
});

test('WSL leaves Git reads available and disables only the write area',()=>{
  const document={createElement:()=>({classList:{toggle(){}},textContent:''})},nodes=new Map();
  const $=id=>{if(!nodes.has(id))nodes.set(id,{inert:false,disabled:false,classList:{toggle(){}},before(){}});return nodes.get(id);};
  const state={runtimeTarget:'wsl'},deps={state,document:{...document,documentElement:{dataset:{}}},$,el:()=>({classList:{toggle(){}}}),dshConfigView:{deactivate(){}}};
  const runtimeSource=app.slice(app.indexOf('function applyRuntimeTarget('),app.indexOf('function createRuntimePanel('));
  new Function(...Object.keys(deps),runtimeSource+';applyRuntimeTarget();')(...Object.values(deps));
  assert.equal($('terminal-git-workspace').inert,false);assert.equal($('git-write').inert,true);
  assert.equal($('git-diff-read').disabled,false);assert.equal($('git-status-read').disabled,false);
  for(const id of ['git-stage-plan','git-unstage-plan','git-commit-plan','git-push-plan','git-plan-apply'])assert.equal($(id).disabled,true);
});
