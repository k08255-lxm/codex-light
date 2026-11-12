import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from '../src/server.mjs';
import {DemoClient} from '../src/demo.mjs';
let sequence=0;
async function fixture(t,{demo=false,statisticsRoot}={}){const client=new DemoClient(),app=await createServer({client,demo,statisticsRoot});await app.started;t.after(()=>app.close());return app;}
const post=(app,route,body={},extra={})=>fetch(app.origin+route,{method:'POST',headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json',...extra},body:JSON.stringify(body)});
const rpc=(app,method,params,extra={})=>post(app,'/api/rpc',{method,params,requestId:`${app.operations.serverInstance}:${Date.now()}:statistics-http-${++sequence}`,...extra});
async function directory(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'statistics-http-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}

test('statistics routes retain token/origin validation and reject malformed filters without RPC or inference',async t=>{
 const app=await fixture(t,{demo:true});let rpcCalls=0;app.rpc.call=async()=>{rpcCalls++;throw new Error('No RPC expected');};
 assert.equal((await fetch(app.origin+'/api/statistics/query',{method:'POST',body:'{}'})).status,401);
 assert.equal((await post(app,'/api/statistics/query',{}, {Origin:'https://outside.invalid'})).status,403);
 for(const input of [null,[],{scope:'combined'},{limit:0},{cursor:Buffer.from('null').toString('base64url')},{provider:42},{from:'bad'},{unknown:true}])assert.equal((await post(app,'/api/statistics/query',input)).status,400);
 const data=await(await post(app,'/api/statistics/query')).json();assert.equal(data.scope,'light');assert.equal(data.totals.turnCount,0);assert.equal(data.totals.inputTokens,null);assert.equal(data.totals.requestCount,null);assert.equal(rpcCalls,0);
 assert.equal((await post(app,'/api/statistics/import',{directory:process.cwd()})).status,400,'demo must not scan real history');
});

test('confirmed mutation dedup counts one submission; raw events supply measurements independently of frontend navigation',async t=>{
 const app=await fixture(t,{demo:true});
 const created=await(await rpc(app,'thread/start',{cwd:process.cwd()})).json(),threadId=created.thread.id;
 const requestId=`${app.operations.serverInstance}:${Date.now()}:statistics-same-send`;
 const params={threadId,cwd:process.cwd(),input:[{type:'text',text:'PRIVATE_SYNTHETIC_PROMPT'}]};
 const responses=await Promise.all([rpc(app,'turn/start',params,{requestId}),rpc(app,'turn/start',params,{requestId})]);for(const response of responses)assert.equal(response.status,200);
 const turn=(await responses[0].json()).turn;
 const steer=await rpc(app,'turn/steer',{threadId,expectedTurnId:turn.id,input:[{type:'text',text:'more'}]});assert.equal(steer.status,200);
 const status=await(await post(app,'/api/statistics/query')).json();assert.equal(status.totals.turnCount,1);assert.equal(status.totals.submissionCount,2);assert.ok(!JSON.stringify(status).includes('PRIVATE_SYNTHETIC_PROMPT'));
 assert.equal((await rpc(app,'thread/unsubscribe',{threadId})).status,200);
 app.rpc.emit('event',{method:'turn/completed',params:{threadId,turn:{id:turn.id,status:'completed',durationMs:2000}}});
 const done=await(await post(app,'/api/statistics/query')).json();assert.equal(done.totals.completedCount,1);assert.equal(done.totals.performance.durationMs.p50,2000);
});

test('explicit import uses the existing bounded scanner and replaces local scope without combining live data',async t=>{
 const root=await directory(t),app=await fixture(t),threadId='11111111-1111-4111-8111-111111111111';
 const token=n=>({timestamp:'2030-01-01T01:00:00Z',type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:n,output_tokens:0,cached_input_tokens:0,cache_write_input_tokens:0,reasoning_output_tokens:0,total_tokens:n}}}});
 const rows=[{type:'session_meta',payload:{id:threadId,source:'cli',model_provider:'openai'}},{type:'turn_context',payload:{turn_id:'turn',model:'m'}},token(0),token(5),{type:'response_item',payload:{text:'PRIVATE_LOG_TEXT'}}];
 await fs.writeFile(path.join(root,'fixture.jsonl'),rows.map(row=>JSON.stringify(row)).join('\n'));
 const response=await post(app,'/api/statistics/import',{directory:root});assert.equal(response.status,200);const imported=await response.json();assert.equal(imported.imported,true);assert.equal(imported.scan.filesRead,1);assert.equal(imported.statistics.totals.totalTokens,5);assert.equal(imported.statistics.details.data[0].provider,'openai');assert.ok(!JSON.stringify(imported).includes('PRIVATE_LOG_TEXT'));assert.ok(!JSON.stringify(imported).includes(root));
 assert.equal((await(await post(app,'/api/statistics/query')).json()).totals.turnCount,0);
 await fs.writeFile(path.join(root,'fixture.jsonl'),rows.slice(0,3).map(row=>JSON.stringify(row)).join('\n'));
 const scan=await post(app,'/api/local-usage/scan',{directory:root});assert.equal(scan.status,200);const updated=await(await post(app,'/api/statistics/query',{scope:'local'})).json();assert.equal(updated.totals.totalTokens,null,'re-import replaces, never adds snapshots');
 assert.equal((await post(app,'/api/statistics/import',{directory:'relative'})).status,400);
});

test('explicit statistics state persists sanitized metadata and reopens without live activity or prompt text',async t=>{
 const root=await directory(t),app=await fixture(t,{statisticsRoot:root});
 app.rpc.emit('event',{method:'turn/started',params:{threadId:'synthetic',turn:{id:'turn'}}});app.rpc.emit('event',{method:'item/agentMessage/delta',params:{threadId:'synthetic',turnId:'turn',itemId:'msg',delta:'PRIVATE_TEXT_NEVER_ON_DISK'}});
 await app.close();const saved=await fs.readFile(path.join(root,'live.json'),'utf8');assert.ok(!saved.includes('PRIVATE_TEXT'));assert.ok(!saved.includes('delta'));
 const restored=await fixture(t,{statisticsRoot:root});const data=await(await post(restored,'/api/statistics/query')).json();assert.equal(data.totals.turnCount,1);assert.equal(data.totals.unknownCount,1);assert.equal(data.totals.runningCount,0);
});
