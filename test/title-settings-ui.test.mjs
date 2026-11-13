import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocument} from './mini-dom.mjs';
import {mountTitleSettings} from '../public/ui/title-settings.js';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
test('title UI defaults off, requires explicit model, saves without toast, and refreshes state on reentry',async()=>{
 const document=createDocument(),host=document.createElement('div'),calls=[];let state={enabled:false,model:null,lastError:null},toasts=0;
 const view=mountTitleSettings(host,{notice:()=>toasts++,api:async(route,input)=>{calls.push({route,input});if(route.endsWith('/models'))return {data:[{model:'chosen',displayName:'Chosen'}]};if(route.endsWith('/configure'))return state={...input,lastError:null};return state;}});
 view.activate();await tick();const enabled=host.querySelector('[aria-label="自动总结对话标题"]'),model=host.querySelector('[aria-label="标题总结模型"]'),save=host.querySelectorAll('button').find(row=>row.textContent==='保存标题设置');assert.equal(enabled.checked,false);assert.equal(model.value,'');enabled.checked=true;save.click();await tick();assert.equal(calls.filter(row=>row.route.endsWith('/configure')).length,0);model.value='chosen';save.click();await tick();assert.deepEqual(state,{enabled:true,model:'chosen',lastError:null});assert.equal(toasts,0);assert.ok(host.textContent.includes('已保存'));
 state.lastError='标题总结超时';view.activate();await tick();assert.ok(host.textContent.includes('标题总结超时'));assert.equal(calls.filter(row=>row.route.endsWith('/status')).length,2);
});

test('title settings live under Appearance and only activate there on the local client',async()=>{
 const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
 const pane=html.match(/<section id="settings-appearance"[\s\S]*?<\/section>/)[0];
 assert.match(pane,/id="title-settings-root" class="local-only"/);
 assert.equal((html.match(/id="title-settings-root"/g)||[]).length,1);
 const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
 const source=app.slice(app.indexOf('function selectSettingsSection('),app.indexOf('\nfunction ',app.indexOf('function selectSettingsSection(')+10));
 const noop=()=>{},nodes=new Map(),state={lan:false,connected:false},calls=[];
 const panel={activate:noop,deactivate:noop};
 const context={state,document:{querySelectorAll:()=>[],querySelector:()=>({scrollTop:0})},$:id=>{if(!nodes.has(id))nodes.set(id,{classList:{toggle:noop},scrollIntoView:noop});return nodes.get(id);},route:noop,
  dshConnectionView:panel,dshConfigView:panel,titleSettings:{activate:()=>calls.push(state.settingsPage)},pluginPanel:panel,lanView:panel,aboutView:panel,renderPluginPending:noop,syncRuntimePanelActivity:noop};
 vm.createContext(context);vm.runInContext(source,context);
 context.selectSettingsSection('general');assert.deepEqual(calls,[]);
 context.selectSettingsSection('appearance');assert.deepEqual(calls,['appearance']);
 state.lan=true;context.selectSettingsSection('appearance');assert.deepEqual(calls,['appearance']);
});
