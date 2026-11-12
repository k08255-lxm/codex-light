import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from '../src/server.mjs';
import {DemoClient} from '../src/demo.mjs';
import {RuntimeManager} from '../src/runtime-manager.mjs';

class FakeRuntime {
 constructor(){this.upgrading=false;this.calls=[];this.closed=false;this.gate=null;}
 snapshot(){return {current:{source:'desktop',path:'C:\\App\\codex.exe',version:'0.167.0-alpha.3.2'},npm:{available:true,path:'C:\\npm\\codex.exe',version:'0.157.1'},desktop:{available:true,path:'C:\\App\\codex.exe',version:'0.167.0-alpha.3.2'},latest:{version:'0.167.1',checkedAt:'2026-11-11T12:00:00.000Z'},canUpgrade:true,blockedReason:null,upgrading:this.upgrading,diagnostics:[]};}
 async status(){this.calls.push('status');return this.snapshot();}
 async check(){this.calls.push('check');return this.snapshot();}
 async upgrade(input,{requestId}={}){if(input.confirmed!==true)throw Object.assign(new Error('confirm required'),{code:'RUNTIME_CONFIRM_REQUIRED',outcome:'notExecuted'});this.calls.push({upgrade:input,requestId});if(this.gate)await this.gate;return {outcome:'succeeded',installedVersion:input.version,restartRequired:true};}
 async close(){this.closed=true;}
}

let sequence=0;
const requestId=a=>`${a.operations.serverInstance}:${Date.now()}:runtime-http-${++sequence}`;
const post=(a,url,data,extra={})=>fetch(a.origin+url,{method:'POST',headers:{Authorization:`Bearer ${a.token}`,'Content-Type':'application/json',...extra},body:JSON.stringify(data)});
async function fixture(t,runtime){const app=await createServer({client:new DemoClient(),demo:false,runtimeManager:runtime});await app.started;t.after(()=>app.close());return app;}

test('runtime routes share API auth/origin checks and keep status/check read-only',async t=>{
 const runtime=new FakeRuntime();const a=await fixture(t,runtime);
 assert.equal((await fetch(a.origin+'/api/runtime/status',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
 assert.equal((await post(a,'/api/runtime/status',{},{Origin:'https://evil.example'})).status,403);
 const status=await post(a,'/api/runtime/status',{});assert.equal(status.status,200);assert.equal((await status.json()).latest.version,'0.167.1');
 const check=await post(a,'/api/runtime/check',{});assert.equal(check.status,200);
 assert.deepEqual(runtime.calls,['status','check']);
 assert.equal((await post(a,'/api/runtime/status',{extra:true})).status,400);
 assert.equal((await post(a,'/api/runtime/check',{version:'0.167.1'})).status,400);
 assert.equal((await post(a,'/api/rpc',{method:'runtime/status',params:{}})).status,400,'runtime must not become a generic RPC method');
 assert.deepEqual(runtime.calls,['status','check']);
});

test('demo runtime routes are explicitly rejected without status/check/upgrade side effects',async t=>{
 const runtime=new FakeRuntime();const app=await createServer({demo:true,runtimeManager:runtime});await app.started;t.after(()=>app.close());
 for(const [path,data] of [['/api/runtime/status',{}],['/api/runtime/check',{}],['/api/runtime/upgrade',{version:'0.167.1',confirmed:true,requestId:'x'}]]){
  const response=await post(app,path,data);assert.equal(response.status,400);assert.match((await response.json()).error,/演示模式/);
 }
 assert.deepEqual(runtime.calls,[]);
});

test('upgrade uses OperationStore, deduplicates requestId, and persists only the final result',async t=>{
 const runtime=new FakeRuntime();const a=await fixture(t,runtime);let release;runtime.gate=new Promise(resolve=>{release=resolve;});
 const id=requestId(a);const body={version:'0.167.1',confirmed:true,requestId:id};
 const first=post(a,'/api/runtime/upgrade',body);const second=post(a,'/api/runtime/upgrade',body);
 for(let index=0;index<100&&runtime.calls.filter(call=>typeof call==='object').length===0;index++)await new Promise(resolve=>setTimeout(resolve,2));
 assert.equal(runtime.calls.filter(call=>typeof call==='object').length,1,JSON.stringify(runtime.calls));
 release();const [one,two]=await Promise.all([first,second]);assert.equal(one.status,200);assert.equal(two.status,200);
 const result=await one.json();assert.deepEqual(result,{outcome:'succeeded',installedVersion:'0.167.1',restartRequired:true});assert.deepEqual(await two.json(),result);
 const operation=a.operations.get(id);assert.equal(operation.state,'succeeded');assert.equal(operation.method,'runtime/upgrade');assert.deepEqual(operation.result,result);
 runtime.gate=null;const replay=await post(a,'/api/runtime/upgrade',body);assert.equal(replay.status,200);assert.deepEqual(await replay.json(),result);
 assert.equal(runtime.calls.filter(call=>typeof call==='object').length,1);
 const before=runtime.calls.length;
 assert.equal((await post(a,'/api/runtime/upgrade',{version:'0.167.1',confirmed:true,requestId:id,extra:true})).status,400);
 assert.equal((await post(a,'/api/runtime/upgrade',{version:'0.167.1',confirmed:false,requestId:requestId(a)})).status,400);
 assert.equal(runtime.calls.length,before);
});

test('pre-spawn rejection is notExecuted while an unknown upgrade outcome stays unknown',async t=>{
 const runtime=new FakeRuntime();const a=await fixture(t,runtime);
 runtime.upgrade=async()=>{throw Object.assign(new Error('busy now'),{code:'RUNTIME_BUSY',outcome:'notExecuted'});};
 let id=requestId(a);let response=await post(a,'/api/runtime/upgrade',{version:'0.167.1',confirmed:true,requestId:id});
 assert.equal(response.status,400);let body=await response.json();assert.equal(body.outcome,'notExecuted');assert.equal(body.notExecuted,true);assert.equal(a.operations.get(id).state,'failed');
 runtime.upgrade=async()=>{throw Object.assign(new Error('timeout unknown'),{code:'RUNTIME_UPGRADE_TIMEOUT',outcome:'unknown'});};
 id=requestId(a);response=await post(a,'/api/runtime/upgrade',{version:'0.167.1',confirmed:true,requestId:id});
 assert.equal(response.status,400);body=await response.json();assert.equal(body.outcome,'unknown');assert.equal(body.notExecuted,false);assert.equal(a.operations.get(id).state,'unknown');
});

test('runtime status JSON exposes optional diagnostics and latest.stale',async t=>{
 const npmPath='C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
 const desktopLocation='C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0.0_x64__abc',desktopPath=desktopLocation+'\\app\\resources\\codex.exe';
 const npmCliPath='C:\\node\\node_modules\\npm\\bin\\npm-cli.js';
 const runtime=new RuntimeManager({currentPath:desktopPath,currentSource:'desktop',platform:'win32',env:{APPDATA:'C:\\Users\\u\\AppData\\Roaming'},exists:p=>[npmPath,desktopPath,npmCliPath].includes(p),discoverDesktop:()=>desktopLocation,versionOf:p=>p===npmPath?'0.157.1':null,npmCliPath,node:'C:\\node\\node.exe',fetchFn:async()=>({ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify({version:'0.167.1'})}),now:()=>1700000000000});
 const a=await fixture(t,runtime);
 let response=await post(a,'/api/runtime/status',{});let body=await response.json();
 assert.ok(Array.isArray(body.diagnostics)&&body.diagnostics.some(line=>/版本/.test(line)));
 await runtime.check();
 runtime.fetchFn=async()=>{throw new Error('network down');};
 await assert.rejects(runtime.check(),/network down/);
 response=await post(a,'/api/runtime/status',{});body=await response.json();
 assert.equal(body.latest.stale,true);assert.equal(body.latest.version,'0.167.1');
 assert.ok(Array.isArray(body.diagnostics)&&body.diagnostics.some(line=>/版本/.test(line)));
});

test('runtime upgrading flag does not block legitimate new threads or turns',async t=>{
 const runtime=new FakeRuntime();const a=await fixture(t,runtime);
 const created=await post(a,'/api/rpc',{method:'thread/start',params:{cwd:process.cwd(),approvalPolicy:'on-request',sandbox:'workspace-write'},requestId:requestId(a)});
 assert.equal(created.status,200);const {thread}=await created.json();
 runtime.upgrading=true;
 const createdWhileUpgrading=await post(a,'/api/rpc',{method:'thread/start',params:{cwd:process.cwd(),approvalPolicy:'on-request',sandbox:'workspace-write'},requestId:requestId(a)});
 assert.equal(createdWhileUpgrading.status,200);const activeThread=(await createdWhileUpgrading.json()).thread;assert.ok(activeThread.id);
 const turn=await post(a,'/api/rpc',{method:'turn/start',params:{threadId:activeThread.id,cwd:process.cwd(),input:[{type:'text',text:'continue while downloading'}]},requestId:requestId(a)});
 assert.equal(turn.status,200);assert.ok((await turn.json()).turn.id);
 const resume=await post(a,'/api/rpc',{method:'thread/resume',params:{threadId:thread.id}});assert.equal(resume.status,200);
 runtime.upgrading=false;
});
