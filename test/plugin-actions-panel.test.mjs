import test from 'node:test';import assert from 'node:assert/strict';import {mountPluginActionsPanel} from '../public/plugin-actions-panel.js';
class El{constructor(tag,doc){this.tag=tag;this.ownerDocument=doc;this.children=[];this.listeners={};this.textContent='';this.checked=false;this.classList={add(){}};}append(...x){this.children.push(...x);}replaceChildren(...x){this.children=x;}setAttribute(){}addEventListener(k,f){this.listeners[k]=f;}focus(){if(!this.disabled)this.focused=true;}set innerHTML(_){throw Error('HTML forbidden');}}
const doc={createElement:t=>new El(t,doc)},all=e=>[e,...e.children.flatMap(all)],text=e=>all(e).map(n=>n.textContent).join(' '),button=(e,s)=>all(e).find(n=>n.tag==='button'&&n.textContent===s);
const ready=()=>({status:'ready',planId:'p',expiresAt:120000,summary:{action:'install',name:'<script>name</script>',source:{type:'unknown',warning:'未知来源需确认'},mustShowInstallationInterstitial:false,consequences:['安装会启用并可能 silent OAuth'],skills:[],mcpServers:[],hooks:[],apps:[],appTemplates:[]}});
function setup(extra={}){const root=new El('div',doc),calls=[];const panel=mountPluginActionsPanel(root,{clock:()=>0,plan:async(h,a)=>{calls.push(['plan',h,a]);return ready();},apply:async v=>{calls.push(['apply',v]);return {outcome:'succeeded'};},...extra});return {root,calls,panel,select:(action='install')=>panel.select({handle:'h',action})};}
test('action selection prepares read-only; one explicit final click applies without a checkbox',async()=>{
 const x=setup();assert.equal(x.calls.length,0);await x.select();assert.deepEqual(x.calls,[['plan','h','install']]);assert.match(text(x.root),/silent OAuth/);assert.match(text(x.root),/<script>name<\/script>/);
 assert.equal(all(x.root).filter(n=>n.tag==='input').length,0);assert.equal(button(x.root,'取消').focused,true);
 const confirm=button(x.root,'确认安装');await confirm.listeners.click();await confirm.listeners.click();assert.deepEqual(x.calls[1],['apply',{planId:'p',confirmed:true}]);assert.equal(x.calls.length,2);
});
test('mandatory official interstitial and expiration cannot be bypassed by invoking confirm',async()=>{
 let time=0;const x=setup({clock:()=>time,plan:async()=>({...ready(),summary:{...ready().summary,mustShowInstallationInterstitial:true}})});await x.select();assert.equal(button(x.root,'确认安装').disabled,true);await button(x.root,'确认安装').listeners.click();assert.equal(x.calls.length,0);assert.match(text(x.root),/官方客户端/);
 const y=setup({clock:()=>time});await y.select();time=120001;await button(y.root,'确认安装').listeners.click();assert.equal(y.calls.length,1);assert.match(text(y.root),/过期/);
});
test('unknown and transport errors lock retry even after reset/select',async()=>{const x=setup({apply:async()=>{throw Error('SECRET');}});await x.select();await button(x.root,'确认安装').listeners.click();assert.match(text(x.root),/禁止重试/);assert.ok(!text(x.root).includes('SECRET'));x.panel.reset();await x.select();assert.equal(button(x.root,'确认安装').disabled,true);});
test('changed plan does not continue; cancel during preflight ignores late result',async()=>{
 const x=setup({plan:async()=>({status:'changed',handle:'new'})});await x.select();assert.match(text(x.root),/重新选择/);assert.equal(button(x.root,'确认安装').disabled,true);
 let resolve, canceled=0;const y=setup({plan:()=>new Promise(r=>resolve=r),onCancel:()=>canceled++});const pending=y.select();assert.equal(button(y.root,'确认安装').disabled,true);button(y.root,'取消').listeners.click();resolve(ready());await pending;assert.equal(canceled,1);assert.match(text(y.root),/已取消/);assert.equal(button(y.root,'确认安装').disabled,true);
});
test('reset while apply pending preserves uncertain action lock; late response does not overwrite',async()=>{let resolve;const x=setup({apply:()=>new Promise(r=>resolve=r)});await x.select();const pending=button(x.root,'确认安装').listeners.click();x.panel.reset();await x.select();assert.equal(button(x.root,'确认安装').disabled,true);resolve({outcome:'succeeded'});await pending;assert.match(text(x.root),/禁止重试/);});
test('toggle plan exposes effects, folds advanced details, and focuses Cancel',async()=>{
 const x=setup({plan:async()=>({...ready(),summary:{...ready().summary,action:'disable',name:'示例插件',source:{type:'local',path:'/source'},consequences:['修改当前 Codex 用户配置','不卸载插件，不撤销授权']}})});
 await x.select('disable');
 const advanced=all(x.root).find(n=>n.tag==='details');assert.ok(advanced);assert.match(text(advanced),/版本、能力与策略/);
 const effects=all(x.root).find(n=>n.tag==='ul');assert.match(text(effects),/修改当前 Codex 用户配置/);assert.match(text(effects),/不撤销授权/);
 assert.equal(button(x.root,'取消').focused,true);assert.equal(button(x.root,'确认停用').disabled,false);
});
