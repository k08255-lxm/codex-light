import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {RpcClient} from '../src/rpc.mjs';
import {createServer} from '../src/server.mjs';
const peer=fileURLToPath(new URL('./session-app-server.mjs',import.meta.url));
let seq=0;
const id=app=>`${app.operations.serverInstance}:${Date.now()}:session-test-${++seq}`;
async function post(app,method,params,extra={}){
 const response=await fetch(app.origin+'/api/rpc',{method:'POST',headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json'},body:JSON.stringify({method,params,requestId:id(app),...extra})});
 return {status:response.status,body:await response.json()};
}
async function until(check){for(let attempt=0;attempt<100;attempt++){if(await check())return;await new Promise(r=>setTimeout(r,10));}assert.fail('synthetic session cleanup did not settle');}
async function fixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'light-sessions-')),apps=[];
 t.after(async()=>{await Promise.all(apps.map(a=>a.close()));await rm(root,{recursive:true,force:true});});
 async function create(){const rpc=new RpcClient({command:process.execPath,args:[peer,root],cwd:root,timeout:3000,closeTimeout:100});const app=await createServer({client:rpc,fileAttachmentRoot:path.join(root,'attachments')});apps.push(app);await app.started;return app;}
 return {root,create};
}

test('two synthetic clients: reads do not lock; active switch retains; completion and shutdown release',async t=>{
 const {root,create}=await fixture(t),a=await create(),b=await create();
 assert.equal((await post(a,'thread/read',{threadId:'history',includeTurns:true})).status,200);
 assert.equal((await post(a,'thread/resume',{threadId:'history',excludeTurns:true})).status,200);
 assert.equal((await post(a,'thread/items/list',{threadId:'history'})).status,200);
 let stats=await a.rpc.call('test/stats');assert.equal(stats.calls.some(c=>c.method==='thread/resume'),false);assert.deepEqual(await readdir(root),[]);
 const params={threadId:'history',cwd:root,input:[{type:'text',text:'synthetic work'}]};
 let result=await post(a,'turn/start',params);assert.equal(result.status,200);const turnId=result.body.turn.id;
 const retained=await post(a,'thread/unsubscribe',{threadId:'history'});assert.equal(retained.body.status,'retained');assert.equal(retained.body.activeTurnId,turnId);
 const denied=await post(b,'turn/start',params);assert.equal(denied.status,400);assert.match(denied.body.error,/another client/);assert.equal(denied.body.outcome,'notExecuted');
 assert.equal((await b.rpc.call('test/stats')).calls.some(c=>c.method==='turn/start'),false);
 await a.rpc.call('test/complete',{threadId:'history'});await until(async()=>!(await a.rpc.call('test/stats')).owned.length);
 result=await post(b,'turn/start',params);assert.equal(result.status,200);
 await b.close();assert.ok(b.rpc.child.exitCode!==null||b.rpc.child.signalCode);
 assert.deepEqual((await readdir(root)).filter(f=>f.endsWith('.synthetic-lock')),[]);
 result=await post(a,'turn/start',params);assert.equal(result.status,200);
 await a.close();assert.ok(a.rpc.child.exitCode!==null||a.rpc.child.signalCode);assert.deepEqual((await readdir(root)).filter(f=>f.endsWith('.synthetic-lock')),[]);
});

test('HTTP steer uses owned attachments, preserves turn, deduplicates, rejects stale turn and never resends unknown outcome',async t=>{
 const {root,create}=await fixture(t),app=await create();
 const started=await post(app,'turn/start',{threadId:'t',cwd:root,input:[{type:'text',text:'synthetic work'}]});assert.equal(started.status,200);const turnId=started.body.turn.id;
 const upload=await fetch(app.origin+'/api/uploads',{method:'POST',headers:{Authorization:'Bearer '+app.token,'X-Filename':'fixture.png'},body:Buffer.from([137,80,78,71,13,10,26,10,1])});assert.equal(upload.status,200);const image=await upload.json();
 const fileResponse=await fetch(app.origin+'/api/file-uploads',{method:'POST',headers:{Authorization:'Bearer '+app.token,'X-Filename':'fixture.txt','X-File-Mime':'text/plain'},body:'local synthetic attachment'});assert.equal(fileResponse.status,200);const file=await fileResponse.json();
 const params={threadId:'t',expectedTurnId:turnId,input:[{type:'text',text:'立即',text_elements:[{byteRange:{start:0,end:6}}]}]},requestId=id(app);
 const extra={requestId,attachmentIds:[image.id],fileAttachmentIds:[file.id]};
 const [one,two]=await Promise.all([post(app,'turn/steer',params,extra),post(app,'turn/steer',params,extra)]);assert.equal(one.status,200);assert.deepEqual(one,two);assert.deepEqual(one.body,{turnId});
 let calls=(await app.rpc.call('test/stats')).calls.filter(c=>c.method==='turn/steer');assert.equal(calls.length,1);
 const input=calls[0].params.input;assert.equal(input.length,3);assert.deepEqual(input[0].text_elements,[{byteRange:{start:0,end:6}}]);assert.equal(input[1].type,'localImage');assert.match(input[2].text,/fixture.txt/);assert.deepEqual(input[2].text_elements,[]);
 const stale=await post(app,'turn/steer',{...params,expectedTurnId:'wrong'});assert.equal(stale.status,409);assert.equal(stale.body.code,'ACTIVE_TURN_MISMATCH');assert.equal(stale.body.notExecuted,true);
 assert.equal((await post(app,'turn/steer',{...params,model:'override'})).status,400);
 const missing=await post(app,'turn/steer',params,{requestId:null});assert.equal(missing.status,400);
 app.rpc.timeout=40;
 const uncertainId=id(app),unknownParams={threadId:'t',expectedTurnId:turnId,input:[{type:'text',text:'synthetic-timeout'}]};
 const unknown=await post(app,'turn/steer',unknownParams,{requestId:uncertainId});assert.equal(unknown.body.outcome,'unknown');
 const replay=await post(app,'turn/steer',unknownParams,{requestId:uncertainId});assert.deepEqual(replay,unknown);
 calls=(await app.rpc.call('test/stats')).calls.filter(c=>c.method==='turn/steer');assert.equal(calls.length,2);
 const status=await(await fetch(app.origin+'/api/status',{headers:{Authorization:'Bearer '+app.token}})).json();assert.equal(status.threadSessions.threads[0].activeTurnId,turnId);
});

test('shutdown response waits for observed engine exit before accepting HTTP close',async t=>{
 const {root,create}=await fixture(t),app=await create();
 await post(app,'turn/start',{threadId:'shutdown',cwd:root,input:[{type:'text',text:'synthetic only'}]});
 const response=await fetch(app.origin+'/api/shutdown',{method:'POST',headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json'},body:'{}'});
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{engineStopped:true,shutdownAccepted:true});
 assert.ok(app.rpc.child.exitCode!==null||app.rpc.child.signalCode,'engine must have exited before response');
 assert.deepEqual((await readdir(root)).filter(f=>f.endsWith('.synthetic-lock')),[]);
 await app.close();
});

test('failed shutdown returns unknown and observable failure without claiming stopped or unhandled timer rejection',async t=>{
 const {DemoClient}=await import('../src/demo.mjs');const client=new DemoClient();let closes=0;
 client.close=async()=>{closes++;throw Object.assign(new Error('Synthetic exit failure'),{code:'CHILD_CLOSE_FAILED'});};
 const app=await createServer({client,demo:true});await app.started;t.after(()=>app.close().catch(()=>{}));
 const response=await fetch(app.origin+'/api/shutdown',{method:'POST',headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json'},body:'{}'});
 assert.equal(response.status,500);const error=await response.json();assert.equal(error.code,'CHILD_CLOSE_FAILED');assert.equal(error.outcome,'unknown');assert.equal(error.ok,undefined);
 const status=await(await fetch(app.origin+'/api/status',{headers:{Authorization:'Bearer '+app.token}})).json();assert.equal(status.engineStopped,false);assert.equal(status.stopping,true);assert.equal(status.shutdownError.code,'CHILD_CLOSE_FAILED');
 const denied=await post(app,'thread/start',{cwd:process.cwd()});assert.equal(denied.status,409);assert.equal(denied.body.code,'CLIENT_CLOSING');assert.equal(closes,1);
 await assert.rejects(app.close(),e=>e.code==='CHILD_CLOSE_FAILED');
});
