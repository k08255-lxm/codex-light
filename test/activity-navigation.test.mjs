import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createDocument} from './mini-dom.mjs';

const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const source=app.slice(app.indexOf('function showDetails('),app.indexOf("$('refresh-dsh').addEventListener"));
function setup(currentRoute='chat') {
  const document=createDocument(),nodes=new Map(),calls=[];
  for(const id of ['details','toggle-details','tools-panel','dsh-panel','details-title','tab-tools','tab-dsh','close-details','rail-dsh']) {
    const node=document.createElement('button');node.id=id;document.body.append(node);nodes.set(id,node);
  }
  const $=id=>{assert.ok(nodes.has(id),`unexpected element: ${id}`);return nodes.get(id);};
  $('details').classList.add('hidden');
  const state={detailsTab:'tools'};
  const dependencies={state,$,route:name=>calls.push(['route',name]),syncDshLiveContext:()=>calls.push(['sync']),renderDshConnection:()=>calls.push(['connection']),renderDshTasks:()=>calls.push(['agents']),renderTools:()=>calls.push(['tools']),currentRoute};
  const keys=Object.keys(dependencies);
  const api=new Function(...keys,source+'\nreturn {showDetails};')(...keys.map(key=>dependencies[key]));
  return {state,$,calls,...api};
}

test('chat toolbar has one Activity entry and retains the tool and agent tabs plus the rail shortcut',()=>{
  const toolbar=html.match(/<div class="stage-actions">[\s\S]*?<\/div>/)[0];
  assert.match(toolbar,/id="toggle-details"[\s\S]*?data-icon="panel"[\s\S]*?>活动<\/span>/);
  assert.doesNotMatch(html,/id="open-dsh"/);assert.doesNotMatch(app,/\$\('open-dsh'\)/);
  for(const id of ['tab-tools','tab-dsh','rail-dsh'])assert.match(html,new RegExp(`id="${id}"`));
});

test('Activity toggles the remembered tab, tabs stay open, and closing preserves the choice',()=>{
  const h=setup();h.$('toggle-details').click();
  assert.equal(h.$('details').classList.contains('hidden'),false);assert.equal(h.$('toggle-details').getAttribute('aria-pressed'),'true');
  assert.equal(h.state.detailsTab,'tools');assert.ok(h.calls.some(([kind])=>kind==='tools'));
  h.$('tab-dsh').click();
  assert.equal(h.state.detailsTab,'dsh');assert.equal(h.$('details').classList.contains('hidden'),false);
  assert.equal(h.$('tools-panel').classList.contains('hidden'),true);assert.equal(h.$('dsh-panel').classList.contains('hidden'),false);
  assert.equal(h.$('toggle-details').getAttribute('aria-pressed'),'true');
  h.$('toggle-details').click();assert.equal(h.$('details').classList.contains('hidden'),true);assert.equal(h.$('toggle-details').getAttribute('aria-pressed'),'false');
  h.$('toggle-details').click();assert.equal(h.state.detailsTab,'dsh');assert.equal(h.$('details').classList.contains('hidden'),false);
  h.$('close-details').click();assert.equal(h.state.detailsTab,'dsh');assert.equal(h.$('toggle-details').getAttribute('aria-pressed'),'false');
  h.$('toggle-details').click();h.$('tab-tools').click();h.$('close-details').click();h.$('toggle-details').click();
  assert.equal(h.state.detailsTab,'tools');assert.equal(h.$('tools-panel').classList.contains('hidden'),false);
});

test('conversation agent records and the rail still open agents directly while Activity reflects either tab',()=>{
  const h=setup('settings'),opened=[];
  const callback=app.match(/onOpenAgent:(\(id,kind\)=>\{showDetails\('dsh',true\);dshView.openAgent\(id,kind\);\})/)[1];
  const open=new Function('showDetails','dshView','return '+callback)(h.showDetails,{openAgent:(...args)=>opened.push(args)});
  open('child-thread','native');
  assert.deepEqual(opened,[['child-thread','native']]);assert.equal(h.state.detailsTab,'dsh');assert.equal(h.$('details').classList.contains('hidden'),false);
  assert.equal(h.$('toggle-details').getAttribute('aria-pressed'),'true');assert.ok(h.calls.some(([kind,name])=>kind==='route'&&name==='chat'));
  h.$('close-details').click();
  const binding=app.match(/\$\('rail-dsh'\)\.addEventListener\('click', \(\) => showDetails\('dsh', true\)\);/)[0];
  new Function('$','showDetails',binding)(h.$,h.showDetails);h.$('rail-dsh').click();
  assert.equal(h.state.detailsTab,'dsh');assert.equal(h.$('details').classList.contains('hidden'),false);
});
