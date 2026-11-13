import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createServer} from '../src/server.mjs';
import {SessionDefaultsService,projectSessionDefaults} from '../src/session-defaults.mjs';
const configResponse=()=>({config:{model:'gpt-5.1-codex',model_provider:'openai',model_reasoning_effort:'high',api_key:'SECRET-KEY',instructions:'SECRET-INSTRUCTIONS'},origins:{model:{name:{type:'user'}}},layers:[{name:{type:'user'},version:'private-version'}]});
class Mock extends EventEmitter{
 constructor(response=configResponse()){super();this.connected=false;this.requests=new Map();this.calls=[];this.response=response;}
 async start(){this.connected=true;return {};}
 async close(){this.connected=false;}
 async call(method,params){this.calls.push({method,params});if(method!=='config/read')throw new Error('unexpected RPC '+method);return structuredClone(this.response);}
}
const post=(app,url,data,extra={})=>fetch(app.origin+url,{method:'POST',headers:{Authorization:`Bearer ${app.token}`,'Content-Type':'application/json',...extra},body:JSON.stringify(data)});
test('defaults projection returns only bounded model, permission and speed fields and never raw config',()=>{
 const projected=projectSessionDefaults(configResponse());
 assert.deepEqual(projected,{model:'gpt-5.1-codex',modelProvider:'openai',reasoningEffort:'high',approvalPolicy:null,approvalsReviewer:null,sandbox:null,sandboxPolicy:null,serviceTier:null});
 assert.deepEqual(Object.keys(projected).sort(),['approvalPolicy','approvalsReviewer','model','modelProvider','reasoningEffort','sandbox','sandboxPolicy','serviceTier']);
 assert.ok(!JSON.stringify(projected).includes('SECRET'));
 assert.ok(!JSON.stringify(projected).includes('private-version'));
});
test('defaults projection marks missing, non-string, empty and overlong values null',()=>{
 assert.deepEqual(projectSessionDefaults({config:{}}),{model:null,modelProvider:null,reasoningEffort:null,approvalPolicy:null,approvalsReviewer:null,sandbox:null,sandboxPolicy:null,serviceTier:null});
 assert.deepEqual(projectSessionDefaults({config:{model:42,model_provider:{name:'openai'},model_reasoning_effort:''}}),{model:null,modelProvider:null,reasoningEffort:null,approvalPolicy:null,approvalsReviewer:null,sandbox:null,sandboxPolicy:null,serviceTier:null});
 assert.equal(projectSessionDefaults({config:{model:'m'.repeat(512)}}).model,'m'.repeat(512));
 assert.equal(projectSessionDefaults({config:{model:'m'.repeat(513)}}).model,null);
 assert.throws(()=>projectSessionDefaults({}),{code:'CONFIG_INVALID_RESPONSE'});
 assert.throws(()=>projectSessionDefaults(null),{code:'CONFIG_INVALID_RESPONSE'});
});

test('permission and Fast defaults are projected without provider credentials',()=>{
 const result=projectSessionDefaults({config:{approval_policy:'on-request',approvals_reviewer:'auto_review',sandbox_mode:'workspace-write',sandbox_workspace_write:{writable_roots:[process.cwd()],network_access:true},service_tier:'fast',api_key:'PRIVATE'}});
 assert.equal(result.approvalPolicy,'on-request');assert.equal(result.approvalsReviewer,'auto_review');assert.equal(result.serviceTier,'fast');assert.deepEqual(result.sandboxPolicy,{type:'workspaceWrite',writableRoots:[process.cwd()],networkAccess:true});assert.ok(!JSON.stringify(result).includes('PRIVATE'));
 const invalid=projectSessionDefaults({config:{approval_policy:'invalid',approvals_reviewer:'invalid',sandbox_mode:'invalid',service_tier:'invalid'}});
 for(const key of ['approvalPolicy','approvalsReviewer','sandbox','sandboxPolicy','serviceTier'])assert.equal(invalid[key],null,key);
});
test('service rejects null, arrays, unknown fields and unusable cwd before any RPC',async()=>{
 const rpc=new Mock();let validated=0;const service=new SessionDefaultsService({rpc,validateDirectory:async()=>{validated++;}});
 for(const input of [null,undefined,[],'text',{cwd:null},{cwd:''},{cwd:0},{cwd:'relative/path'},{cwd:'x'.repeat(8193)},{extra:true},{cwd:process.cwd(),extra:true}])await assert.rejects(()=>service.read(input));
 assert.equal(rpc.calls.length,0);assert.equal(validated,0);
});
test('service reads includeLayers:false and only forwards a validated cwd',async t=>{
 const rpc=new Mock(),dir=await mkdtemp(path.join(os.tmpdir(),'codex-light-defaults-'));rpc.connected=true;const file=path.join(dir,'a.txt');
 t.after(()=>rm(dir,{recursive:true,force:true}));
 await writeFile(file,'x');const service=new SessionDefaultsService({rpc});
 await assert.rejects(()=>service.read({cwd:file}),/工作目录不存在或不是文件夹/);
 await assert.rejects(()=>service.read({cwd:path.join(dir,'missing')}),/工作目录不存在或不是文件夹/);
 assert.equal(rpc.calls.length,0);
 const projected=await service.read({cwd:dir});
 assert.deepEqual(projected,{model:'gpt-5.1-codex',modelProvider:'openai',reasoningEffort:'high',approvalPolicy:null,approvalsReviewer:null,sandbox:null,sandboxPolicy:null,serviceTier:null});
 assert.deepEqual(rpc.calls,[{method:'config/read',params:{includeLayers:false,cwd:dir}}]);
 await service.read({});
 assert.deepEqual(rpc.calls.at(-1),{method:'config/read',params:{includeLayers:false}});
});
test('demo and disconnected reads fail explicitly without calling config/read',async()=>{
 const demoRpc=new Mock();const demo=new SessionDefaultsService({rpc:demoRpc,demo:true});
 await assert.rejects(()=>demo.read({}),/演示模式不读取真实配置默认值/);assert.equal(demoRpc.calls.length,0);
 const offlineRpc=new Mock();offlineRpc.connected=false;const offline=new SessionDefaultsService({rpc:offlineRpc});
 await assert.rejects(()=>offline.read({}),error=>error.code==='NOT_CONNECTED'&&error.status===503);assert.equal(offlineRpc.calls.length,0);
});
test('HTTP defaults require auth and same origin, then return only the whitelist',async t=>{
 const client=new Mock(),app=await createServer({client});await app.started;t.after(()=>app.close());
 assert.equal((await fetch(app.origin+'/api/session/defaults',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
 assert.equal((await post(app,'/api/session/defaults',{},{Origin:'https://evil.example'})).status,403);
 const response=await post(app,'/api/session/defaults',{cwd:process.cwd()});assert.equal(response.status,200);
 const body=await response.json();assert.deepEqual(body,{model:'gpt-5.1-codex',modelProvider:'openai',reasoningEffort:'high',approvalPolicy:null,approvalsReviewer:null,sandbox:null,sandboxPolicy:null,serviceTier:null});
 const serialized=JSON.stringify(body);assert.ok(!serialized.includes('SECRET'));assert.ok(!serialized.includes('private-version'));
 assert.deepEqual(client.calls,[{method:'config/read',params:{includeLayers:false,cwd:process.cwd()}}]);
 assert.equal(app.operations.entries.size,0);
});
test('HTTP defaults reject malformed bodies and bad cwd without touching config',async t=>{
 const client=new Mock(),app=await createServer({client});await app.started;t.after(()=>app.close());
 const dir=await mkdtemp(path.join(os.tmpdir(),'codex-light-defaults-http-'));const file=path.join(dir,'a.txt');await writeFile(file,'x');t.after(()=>rm(dir,{recursive:true,force:true}));
 for(const data of [null,[],{extra:true},{cwd:null},{cwd:''},{cwd:file},{cwd:path.join(dir,'missing')}]){
  const response=await post(app,'/api/session/defaults',data);assert.equal(response.status,400,JSON.stringify(data));
 }
 assert.equal(client.calls.length,0);assert.equal(app.operations.entries.size,0);
});
test('HTTP defaults fail clearly in demo mode and while disconnected',async t=>{
 const demo=await createServer({demo:true});await demo.started;t.after(()=>demo.close());
 let demoCalls=0;const original=demo.rpc.call.bind(demo.rpc);demo.rpc.call=async(...args)=>{demoCalls++;return original(...args);};
 let response=await post(demo,'/api/session/defaults',{});assert.equal(response.status,400);assert.match((await response.json()).error,/演示模式不读取真实配置默认值/);assert.equal(demoCalls,0);
 const client=new Mock(),offline=await createServer({client});await offline.started;t.after(()=>offline.close());
 client.connected=false;response=await post(offline,'/api/session/defaults',{});assert.equal(response.status,503);
 assert.match((await response.json()).error,/尚未连接/);assert.equal(client.calls.length,0);
});
