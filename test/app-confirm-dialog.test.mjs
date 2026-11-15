import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument } from './mini-dom.mjs';
import { confirmApp } from '../public/app-confirm-dialog.js';
function setup() {
 const document=createDocument(); const create=document.createElement;
 document.createElement=tag=>{const node=create(tag);if(tag==='dialog'){node.showModal=()=>{node.open=true;};node.close=()=>{node.open=false;node.dispatch('close');};}return node;};
 const opener=document.createElement('button');document.body.append(opener);opener.focus();return {document,opener};
}
test('plain-text warnings preserved and explicit acceptance required',async()=>{const {document,opener}=setup();const message='2 个文件 · 9.87 MiB\n归档可能不减反增\n<script>text</script>';const promise=confirmApp(document,message);const dialog=document.querySelector('dialog');assert.match(dialog.textContent,/9.87 MiB/);assert.match(dialog.textContent,/<script>text<\/script>/);assert.equal(document.activeElement.textContent,'取消');dialog.querySelector('.primary').click();assert.equal(await promise,true);assert.equal(document.activeElement,opener);});
for(const mode of ['cancel','escape','close','abort'])test(mode+' never accepts',async()=>{const {document}=setup();const controller=new AbortController();const promise=confirmApp(document,'永久删除无法恢复',{signal:controller.signal});const dialog=document.querySelector('dialog');if(mode==='cancel')dialog.querySelector('button').click();if(mode==='escape')dialog.dispatch('cancel',{preventDefault(){}});if(mode==='close')dialog.close();if(mode==='abort')controller.abort();assert.equal(await promise,false);assert.equal(document.querySelector('dialog'),null);});
test('duplicate request fails closed and no automatic queue of approvals',async()=>{const {document}=setup();const first=confirmApp(document,'one');assert.equal(await confirmApp(document,'two'),false);document.querySelector('dialog').querySelector('button').click();assert.equal(await first,false);});
test('unsupported dialog fails closed',async()=>{const document=createDocument();assert.equal(await confirmApp(document,'one'),false);});
