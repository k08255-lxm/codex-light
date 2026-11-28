import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createDocument} from './mini-dom.mjs';

const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const source=app.slice(app.indexOf('function showDetails('),app.indexOf("$('refresh-dsh').addEventListener"));
function setup(currentRoute='chat') {
  const document=createDocument(),nodes=new Map(),calls=[];
  for(const id of ['details','toggle-details','close-details']) {
    const node=document.createElement('button');node.id=id;document.body.append(node);nodes.set(id,node);
  }
  const $=id=>{assert.ok(nodes.has(id),`unexpected element: ${id}`);return nodes.get(id);};
  $('details').classList.add('hidden');
  const state={};
  const dependencies={state,$,route:name=>calls.push(['route',name]),syncDshLiveContext:()=>calls.push(['sync']),renderDshConnection:()=>calls.push(['connection']),renderDshTasks:()=>calls.push(['agents']),currentRoute};
  const keys=Object.keys(dependencies);
  const api=new Function(...keys,source+'\nreturn {showDetails};')(...keys.map(key=>dependencies[key]));
  return {state,$,calls,...api};
}

test('conversation toolbar opens the agent inspector directly',()=>{
  assert.match(html,/id="toggle-details"[^>]*aria-label="子代理"/);
  assert.doesNotMatch(html,/id="(?:tools-panel|tool-list|tab-tools|tab-dsh|window-menu|menu-app)"/);
  const h=setup();h.$('toggle-details').click();
  assert.equal(h.$('details').classList.contains('hidden'),false);
  assert.ok(h.calls.some(([kind])=>kind==='agents'));
  h.$('toggle-details').click();assert.equal(h.$('details').classList.contains('hidden'),true);
});

test('conversation agent records open their inspector from another route',()=>{
  const h=setup('settings'),opened=[];
  const callback=app.match(/onOpenAgent:(\(id,kind\)=>\{showDetails\(true\);dshView.openAgent\(id,kind\);\})/)[1];
  const open=new Function('showDetails','dshView','return '+callback)(h.showDetails,{openAgent:(...args)=>opened.push(args)});
  open('child-thread','native');
  assert.deepEqual(opened,[['child-thread','native']]);assert.equal(h.$('details').classList.contains('hidden'),false);
  assert.equal(h.$('toggle-details').getAttribute('aria-pressed'),'true');assert.ok(h.calls.some(([kind,name])=>kind==='route'&&name==='chat'));
  h.$('close-details').click();
  assert.doesNotMatch(html,/id="rail-dsh"/);assert.doesNotMatch(app,/\$\('rail-dsh'\)/);
});
