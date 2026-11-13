import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from '../src/server.mjs';
import {DemoClient} from '../src/demo.mjs';
const tick=()=>new Promise(resolve=>setTimeout(resolve,2));
test('HTTP settings default off and future first-turn summaries exclude injected attachment metadata',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'title-http-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const client=new DemoClient(),base=client.call.bind(client),calls=[];let summaryInput=null;
 client.call=async(method,params)=>{calls.push({method,params:structuredClone(params)});
  if(method==='thread/start'&&params.ephemeral)return {thread:{id:'title-reader',cwd:params.cwd,ephemeral:true},approvalPolicy:'never',sandbox:{type:'readOnly',networkAccess:false},instructionSources:[]};
  if(method==='thread/start'){const result=await base(method,params);result.thread.name=null;return result;}
  if(method==='turn/start'&&params.threadId==='title-reader'){summaryInput=params.input;setTimeout(()=>{client.emit('event',{method:'turn/started',params:{threadId:'title-reader',turn:{id:'summary-turn'}}});client.emit('event',{method:'item/completed',params:{threadId:'title-reader',item:{type:'agentMessage',text:'{"title":"附件问题"}'}}});client.emit('event',{method:'turn/completed',params:{threadId:'title-reader',turn:{id:'summary-turn',status:'completed'}}});},0);return {turn:{id:'summary-turn'}};}
  if(method==='turn/start'){setTimeout(()=>client.emit('event',{method:'turn/completed',params:{threadId:params.threadId,turn:{id:'original-turn',status:'completed'}}}),0);client.emit('event',{method:'turn/started',params:{threadId:params.threadId,turn:{id:'original-turn'}}});return {turn:{id:'original-turn'}};}
  if(method==='thread/unsubscribe'&&params.threadId==='title-reader')return {};
  return base(method,params);
 };
 const app=await createServer({client,statisticsRoot:root,fileAttachmentRoot:path.join(root,'uploads')});await app.started;t.after(()=>app.close());let sequence=0;
 const post=(route,input={})=>fetch(app.origin+route,{method:'POST',headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json'},body:JSON.stringify(input)});
 const rpc=(method,params,extra={})=>post('/api/rpc',{method,params,...extra,requestId:`${app.operations.serverInstance}:${Date.now()}:title-http-${++sequence}`});
 assert.equal((await(await post('/api/title-summary/status')).json()).enabled,false);assert.equal(calls.length,0);assert.equal((await post('/api/title-summary/configure',{enabled:true,model:'demo'})).status,200);assert.equal(calls.filter(row=>row.method==='turn/start').length,0);
 const upload=await fetch(app.origin+'/api/file-uploads',{method:'POST',headers:{Authorization:'Bearer '+app.token,'X-Filename':'private-file.txt','X-File-Mime':'text/plain'},body:'PRIVATE_FILE_CONTENT'});const file=await upload.json();
 const created=await(await rpc('thread/start',{cwd:process.cwd()})).json();assert.ok(created.thread?.id);const sent=await rpc('turn/start',{threadId:created.thread.id,cwd:process.cwd(),input:[{type:'text',text:'请说明附件用途'}]},{fileAttachmentIds:[file.id]});assert.equal(sent.status,200);
 for(let i=0;i<100&&!calls.some(row=>row.method==='thread/name/set');i++)await tick();assert.deepEqual(JSON.parse(summaryInput[0].text),{user_text:'请说明附件用途'});assert.ok(!JSON.stringify(summaryInput).includes('private-file'));assert.ok(!JSON.stringify(summaryInput).includes('PRIVATE_FILE_CONTENT'));assert.equal(calls.filter(row=>row.method==='turn/start'&&row.params.threadId==='title-reader').length,1);
 const data=await(await post('/api/statistics/query')).json();assert.equal(data.totals.turnCount,1,'internal title turn is not a user turn');assert.ok(!data.details.data.some(row=>row.threadId==='title-reader'));assert.equal(client.threads.get(created.thread.id).name,'附件问题');
});
