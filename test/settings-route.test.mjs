import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createDocument} from './mini-dom.mjs';

const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const router=app.slice(app.indexOf('const STAGES ='),app.indexOf('function openSettings('));
const sections=app.slice(app.indexOf("function selectSettingsSection("),app.indexOf('function rowsNode('));

function setup(){
  const document=createDocument(),nodes=new Map(),calls=[];
  const $=id=>{if(!nodes.has(id)){const node=document.createElement('div');node.id=id;document.body.append(node);nodes.set(id,node);}return nodes.get(id);};
  for(const name of ['general','archived','remote','plugins','appearance','notifications','shortcuts','configuration','lan','about']){
    $('settings-'+name);
    const button=document.createElement('button');button.dataset.settingsSection=name;document.body.append(button);
  }
  const content=document.createElement('div');content.className='settings-content';document.body.append(content);
  const query=document.querySelector.bind(document);
  document.querySelector=selector=>selector.startsWith('#')&&selector.includes(' ')?null:query(selector);
  const view=name=>({activate(){calls.push([name,'activate']);},deactivate(){calls.push([name,'deactivate']);},setActive(){},reset(){}});
  const noop=()=>{};
  const state={cwd:'/project',lan:false,connected:false};
  const dependencies={document,$,state,closeWindowMenu:noop,closeThreadMenu:noop,
    sidebarController:{setRoute:value=>calls.push(['sidebar',value]),open:()=>calls.push(['sidebar','open']),closeForNavigation:noop},
    statsView:view('stats'),accountView:view('account'),accountLoginPanel:view('login'),pluginPanel:view('plugins'),aboutView:view('about'),storageView:view('storage'),
    runtimePanel:null,prReviewPanel:null,dshConnectionView:view('dsh'),dshConfigView:view('dsh-config'),lanView:view('lan'),
    renderDshConnection:noop,workbench:{label:()=>'/project'},terminalControls:noop,syncDshLiveContext:noop,syncDelegationMonitor:noop,syncRuntimePanelActivity:noop,
    loadArchived:async()=>{},notice:noop,renderPluginPending:noop,refreshRemote:noop,remoteReset:noop};
  const names=Object.keys(dependencies);
  const create=new Function(...names,router+'\n'+sections+'\nreturn {route,selectSettingsSection};');
  return {...create(...names.map(key=>dependencies[key])),state,calls,$};
}

test('settings about is a real exclusive section and opens its dedicated sidebar',()=>{
  const h=setup();h.route('settings',{section:'about'});
  assert.equal(h.state.settingsPage,'about');
  assert.equal(h.$('settings-about').classList.contains('hidden'),false);
  assert.equal(h.$('settings-general').classList.contains('hidden'),true);
  assert.equal(h.$('chat-sidebar').classList.contains('hidden'),true);
  assert.equal(h.$('settings-sidebar').classList.contains('hidden'),false);
  assert.ok(h.calls.some(([view,action])=>view==='about'&&action==='activate'));
  assert.ok(h.calls.some(([view,action])=>view==='sidebar'&&action==='open'));
  h.route('usage');
  assert.equal(h.$('chat-sidebar').classList.contains('hidden'),false);
  assert.equal(h.$('settings-sidebar').classList.contains('hidden'),true);
  assert.ok(h.calls.some(([view,action])=>view==='about'&&action==='deactivate'));
  h.route('chat');assert.equal(h.$('chat-sidebar').classList.contains('hidden'),false);
});

test('LAN settings cannot expose local-only About content',()=>{
  const h=setup();h.state.lan=true;h.route('settings',{section:'about'});
  assert.equal(h.state.settingsPage,'general');
  assert.equal(h.$('settings-about').classList.contains('hidden'),true);
  assert.ok(!h.calls.some(([view,action])=>view==='about'&&action==='activate'));
});

test('leaving the conversation closes Activity without forgetting its selected tab',()=>{
  const h=setup();h.state.detailsTab='dsh';
  h.$('details').classList.remove('hidden');h.$('toggle-details').setAttribute('aria-pressed','true');
  h.route('usage');
  assert.equal(h.$('details').classList.contains('hidden'),true);
  assert.equal(h.$('toggle-details').getAttribute('aria-pressed'),'false');
  assert.equal(h.state.detailsTab,'dsh');
});

test('storage settings is local-only and activates its own view',()=>{const x=setup();x.selectSettingsSection('storage');assert.equal(x.state.settingsPage,'storage');assert.ok(x.calls.some(c=>c[0]==='storage'&&c[1]==='activate'));x.state.lan=true;x.selectSettingsSection('storage');assert.equal(x.state.settingsPage,'general');assert.equal(x.$('settings-storage').classList.contains('hidden'),true);});
