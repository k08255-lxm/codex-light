import test from 'node:test';import assert from 'node:assert/strict';import {mountConfigSettingsPanel} from '../public/config-settings-panel.js';
class El{constructor(tag,doc){this.tag=tag;this.ownerDocument=doc;this.children=[];this.listeners={};this.textContent='';this.value='';this.checked=false;this.classList={add(){}};}append(...x){this.children.push(...x);}replaceChildren(...x){this.children=x;}setAttribute(){}addEventListener(k,f){this.listeners[k]=f;}focus(){}set innerHTML(_){throw Error('HTML forbidden');}}
const doc={createElement:t=>new El(t,doc)},all=e=>[e,...e.children.flatMap(all)],text=e=>all(e).map(n=>n.textContent).join(' '),button=(e,s)=>all(e).find(n=>n.tag==='button'&&n.textContent===s);
const view=()=>({fields:Object.fromEntries(['model','model_reasoning_effort','web_search','approval_policy','sandbox_mode'].map(k=>[k,{value:'old',label:'old',source:'用户层',readonly:false,options:['old','new']}]))});

test('per-model window controls display, save and clear the chosen model independently',async()=>{
 const edits=[],sizes={old:120000};
 const {root,panel}=setup({
  read:async()=>({...view(),models:[{model:'old'},{model:'new'}],contextWindows:{...sizes},windowCatalog:{status:'ready',models:{old:{size:272000,max:872000}}}}),
  readWindowCatalog:async()=>({status:'ready',models:{old:{size:272000,max:872000},new:{size:500000}}}),
  setContextWindow:async(model,size)=>{edits.push([model,size]);if(size===null)delete sizes[model];else sizes[model]=size;return {contextWindows:{...sizes}};}
 });
 await panel.activate();
 const section=all(root).find(n=>n.tag==='section');
 const select=all(section).find(n=>n.tag==='select'),input=all(section).find(n=>n.tag==='input');
 assert.equal(input.value,'120000');
 assert.match(text(section),/当前使用自定义窗口/);assert.match(text(section),/标称窗口 272,000/);
 select.value='new';select.listeners.change();assert.equal(input.value,'');
 assert.match(text(section),/当前跟随引擎默认/);assert.match(text(section),/未提供此模型/);
 await button(section,'重新读取模型目录').listeners.click();assert.match(text(section),/标称窗口 500,000/);
 input.value='-100';await button(section,'保存窗口大小').listeners.click();assert.equal(edits.length,0);
 input.value='98304';await button(section,'保存窗口大小').listeners.click();
 assert.deepEqual(sizes,{old:120000,new:98304});
 await button(section,'恢复引擎默认').listeners.click();assert.deepEqual(edits,[['new',98304],['new',null]]);
 assert.match(text(section),/当前跟随引擎默认/);
 await panel.activate();assert.equal(input.value,'');assert.match(text(section),/当前跟随引擎默认/);
 select.value='old';select.listeners.change();assert.equal(input.value,'120000');
});
function setup(overrides={}){const root=new El('div',doc),calls=[];const panel=mountConfigSettingsPanel(root,{clock:()=>0,read:async()=>{calls.push(['read']);return view();},plan:async edits=>{calls.push(['plan',edits]);return {planId:'p',expiresAt:120000,diff:[{key:'model',from:'old',to:'new',source:'用户层'}],warnings:['安全警告']};},apply:async p=>{calls.push(['apply',p]);return {outcome:'succeeded',status:'okOverridden'};},...overrides});return {root,panel,calls};}
async function prepare(x){await x.panel.activate();const select=all(x.root).find(n=>n.tag==='select');select.value='new';select.listeners.change();await button(x.root,'保存更改').listeners.click();}
test('entry refreshes configuration and preserves a dirty draft',async()=>{const x=setup();await x.panel.activate();await x.panel.activate();assert.equal(x.calls.length,2);const select=all(x.root).find(n=>n.tag==='select');select.value='new';select.listeners.change();await x.panel.activate();assert.equal(x.calls.length,2);assert.equal(select.value,'new');assert.match(text(x.root),/保留尚未提交/);});
test('save with a permission warning asks once and automatically rereads the confirmed result',async()=>{const x=setup();await prepare(x);assert.match(text(x.root),/安全警告/);assert.equal(x.calls.length,2);await button(x.root,'确认更改').listeners.click();assert.deepEqual(x.calls[2],['apply',{planId:'p',confirmed:true}]);assert.deepEqual(x.calls[3],['read']);assert.match(text(x.root),/更高优先级/);});
test('ordinary changes save on first click',async()=>{let writes=0;const x=setup({plan:async()=>({planId:'p',expiresAt:100,diff:[],warnings:[]}),apply:async()=>{writes++;return {outcome:'succeeded',status:'ok'};}});await prepare(x);assert.equal(writes,1);assert.match(text(x.root),/已保存/);});
test('unknown outcomes require a fresh read and expose no raw errors',async()=>{const x=setup({apply:async()=>{throw Error('SECRET TOML');}});await prepare(x);await button(x.root,'确认更改').listeners.click();assert.match(text(x.root),/结果未知/);assert.ok(!text(x.root).includes('SECRET'));assert.equal(button(x.root,'保存更改').disabled,true);assert.equal(button(x.root,'重新读取').disabled,false);});
test('edit after plan invalidates confirmation; cancel sends no write',async()=>{const x=setup();await prepare(x);all(x.root).find(n=>n.tag==='select').listeners.change();assert.equal(button(x.root,'确认更改').hidden,true);button(x.root,'取消修改').listeners.click();assert.equal(x.calls.length,2);});
test('stale reads cannot repopulate after reset; readonly fields are omitted',async()=>{let resolve;const x=setup({read:()=>new Promise(r=>resolve=r)});const pending=x.panel.activate();x.panel.reset();resolve(view());await pending;assert.equal(all(x.root).filter(n=>n.tag==='select').length,0);x.panel.destroy();assert.equal(x.root.children.length,0);const y=setup({read:async()=>{const v=view();v.fields.approval_policy.readonly=true;return v;}});await y.panel.activate();assert.equal(all(y.root).filter(n=>n.tag==='select').length,4);assert.doesNotMatch(text(y.root),/批准策略/);});
