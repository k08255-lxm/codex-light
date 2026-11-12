import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,stat} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createServer} from '../src/server.mjs';
test('Non-image HTTP uploads are owned persistent references and risky IDs need confirmation',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'file-http-'));const a=await createServer({demo:true,fileAttachmentRoot:root});await a.started;t.after(async()=>{await a.close();await rm(root,{recursive:true,force:true});});let seq=0;
 const post=(url,data)=>fetch(a.origin+url,{method:'POST',headers:{Authorization:`Bearer ${a.token}`,'Content-Type':'application/json'},body:JSON.stringify({...data,...(data.method?.includes('start')?{requestId:`${a.operations.serverInstance}:${Date.now()}:file-test-${++seq}`}:{})})});
 const upload=await fetch(a.origin+'/api/file-uploads',{method:'POST',headers:{Authorization:`Bearer ${a.token}`,'X-Filename':'note.txt','X-File-Mime':'text/plain'},body:'private local fixture'});assert.equal(upload.status,200);const file=await upload.json();assert.equal(file.path,undefined);assert.equal(file.category,'text');
 const {thread}=await(await post('/api/rpc',{method:'thread/start',params:{cwd:process.cwd(),approvalPolicy:'on-request',sandbox:'workspace-write'}})).json();
 const turn={method:'turn/start',params:{threadId:thread.id,cwd:process.cwd(),input:[{type:'text',text:''}]},fileAttachmentIds:[file.id]};assert.equal((await post('/api/rpc',turn)).status,200);
 const content=a.rpc.items.get(thread.id)[0].item.content;assert.equal(content[0].type,'text');assert.equal(content[0].text.includes('private local fixture'),false);assert.match(content[0].text,/attachment.txt/);
 const risk=await(await fetch(a.origin+'/api/file-uploads',{method:'POST',headers:{Authorization:`Bearer ${a.token}`,'X-Filename':'data.zip','X-File-Mime':'application/zip'},body:'not auto unpacked'})).json();
 assert.equal((await post('/api/rpc',{...turn,fileAttachmentIds:[risk.id]})).status,400);
 const next=await(await post('/api/rpc',{method:'thread/start',params:{cwd:process.cwd(),approvalPolicy:'on-request',sandbox:'workspace-write'}})).json();turn.params.threadId=next.thread.id;
 const accepted=await post('/api/rpc',{...turn,fileAttachmentIds:[risk.id],confirmedFileAttachmentIds:[risk.id]});assert.equal(accepted.status,200,await accepted.text());
 assert.equal((await post('/api/rpc',{...turn,fileAttachmentIds:['foreign']})).status,400);
 const owned=await a.fileUploads.resolve([file.id]);await a.close();assert.equal((await stat(owned[0].path)).isFile(),true);
});
