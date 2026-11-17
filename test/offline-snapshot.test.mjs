import test from 'node:test';
import assert from 'node:assert/strict';
import {mountOfflineSnapshot} from '../public/ui/offline-snapshot.js';
test('offline projection includes loaded page text, excluding settings, terminal and input drafts',()=>{
 const nodes=new Map([['messages',{innerText:'已加载的回答',getAttribute:()=>null}],['approvals',{innerText:'等待处理'}],['prompt',{value:'未发送的草稿'}]]);
 const document={getElementById:id=>nodes.get(id)},window={};let state={ready:true,page:'chat',title:'对话标题',project:'项目'};
 mountOfflineSnapshot({document,window,readState:()=>state});
 assert.deepEqual(window.CodexLightOfflineSnapshot.capture(),{title:'对话标题',page:'对话',text:'项目\n等待处理\n\n已加载的回答'});
 for(const page of ['settings','terminal']){state={...state,page};assert.equal(window.CodexLightOfflineSnapshot.capture(),null);}
 state={...state,page:'chat',ready:false};assert.equal(window.CodexLightOfflineSnapshot.capture(),null);
});
test('empty or loading pages never replace the previous good snapshot, and stored text is bounded',()=>{
 let text='',busy=false;const window={},document={getElementById:id=>id==='messages'?{innerText:text,getAttribute:()=>busy?'true':null}:null};
 mountOfflineSnapshot({document,window,readState:()=>({ready:true,page:'chat',title:'x'.repeat(200)})});
 assert.equal(window.CodexLightOfflineSnapshot.capture(),null);text='a'.repeat(120000);busy=true;assert.equal(window.CodexLightOfflineSnapshot.capture(),null);
 busy=false;const saved=window.CodexLightOfflineSnapshot.capture();assert.equal(saved.text.length,100000);assert.equal(saved.title.length,160);
});
