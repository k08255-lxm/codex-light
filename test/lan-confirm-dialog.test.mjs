import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument } from './mini-dom.mjs';
import { confirmLanPersistence } from '../public/lan-confirm-dialog.js';
function setup() {
 const document=createDocument(); const create=document.createElement;
 document.createElement=tag=>{const node=create(tag);if(tag==='dialog'){node.showModal=()=>{node.open=true;};node.close=()=>{node.open=false;node.dispatch('close');};}return node;};
 const opener=document.createElement('button');document.body.append(opener);opener.focus();return {document,opener};
}
test('consent requires explicit acceptance, preserves warning, defaults focus to cancel',async()=>{
 const {document,opener}=setup();const promise=confirmLanPersistence(document);
 const dialog=document.querySelector('dialog');
 assert.match(dialog.textContent,/未加密的 HTTP/);assert.match(dialog.textContent,/令牌/);assert.match(dialog.textContent,/主动关闭/);
 assert.equal(document.activeElement.textContent,'取消');
 dialog.querySelector('.primary').click();assert.equal(await promise,true);
 assert.equal(document.querySelector('dialog'),null);assert.equal(document.activeElement,opener);
});
for(const mode of ['cancel','escape','close','abort'])test(`${mode} declines without consent`,async()=>{
 const {document}=setup();const controller=new AbortController();const promise=confirmLanPersistence(document,{signal:controller.signal});const dialog=document.querySelector('dialog');
 if(mode==='cancel')dialog.querySelector('button').click();
 if(mode==='escape')dialog.dispatch('cancel');
 if(mode==='close')dialog.close();
 if(mode==='abort')controller.abort();
 assert.equal(await promise,false);assert.equal(document.querySelector('dialog'),null);
});
test('pre-aborted navigation never opens dialog; repeat sessions remain independent',async()=>{
 const {document}=setup();const controller=new AbortController();controller.abort();
 assert.equal(await confirmLanPersistence(document,{signal:controller.signal}),false);assert.equal(document.querySelector('dialog'),null);
 for(let i=0;i<2;i++){const promise=confirmLanPersistence(document);document.querySelector('button.btn').click();assert.equal(await promise,false);}
});
import { mountLanAccess } from '../public/ui/lan-view.js';
for(const accept of [false,true])test(`LAN API invoked only on consent (${accept})`,async()=>{
 const {document}=setup();const calls=[];const host=document.createElement('div');document.body.append(host);
 const status={enabled:false,persistenceAvailable:true,addresses:[{address:'192.168.1.2',name:'Test'}]};
 const view=mountLanAccess(host,{api:async(path,body)=>{calls.push({path,body});return status;}});
 await view.activate();const toggle=host.querySelector('input');toggle.checked=true;toggle.dispatch('change');
 assert.equal(calls.filter(x=>x.path==='/api/lan/enable').length,0);
 const dialog=document.querySelector('dialog');assert.ok(dialog);
 dialog.querySelector(accept?'.primary':'button').click();await new Promise(resolve=>setImmediate(resolve));
 const enabled=calls.filter(x=>x.path==='/api/lan/enable');assert.equal(enabled.length,accept?1:0);
 if(accept)assert.equal(enabled[0].body.confirmed,true);
 view.deactivate();
});
test('navigation aborts pending consent and cannot enable LAN later',async()=>{
 const {document}=setup();const calls=[];const host=document.createElement('div');document.body.append(host);
 const view=mountLanAccess(host,{api:async path=>{calls.push(path);return {enabled:false,persistenceAvailable:true,addresses:[{address:'192.168.1.2'}]};}});
 await view.activate();const toggle=host.querySelector('input');toggle.checked=true;toggle.dispatch('change');const button=document.querySelector('dialog').querySelector('.primary');
 view.deactivate();button.click();await new Promise(resolve=>setImmediate(resolve));assert.ok(!calls.includes('/api/lan/enable'));assert.equal(document.querySelector('dialog'),null);
});
