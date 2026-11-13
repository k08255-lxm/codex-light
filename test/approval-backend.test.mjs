import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';
import {RpcClient} from '../src/rpc.mjs';import {createServer} from '../src/server.mjs';import {DemoClient} from '../src/demo.mjs';
import {validateResponse} from '../src/security.mjs';
const headers=app=>({Authorization:`Bearer ${app.token}`,'Content-Type':'application/json'});
const status=async app=>(await fetch(app.origin+'/api/status',{headers:headers(app)})).json();
const post=(app,input)=>fetch(app.origin+'/api/respond',{method:'POST',headers:headers(app),body:JSON.stringify(input)});
function request(id,method,params={}){
 let base={threadId:'thread-one',turnId:'turn-one',itemId:'item-one',startedAtMs:0};
 if(method==='execCommandApproval')base={conversationId:'thread-one',callId:'call-one',command:['echo','synthetic'],cwd:process.cwd(),parsedCmd:[]};
 if(method==='applyPatchApproval')base={conversationId:'thread-one',callId:'call-one',fileChanges:{}};
 if(method==='item/permissions/requestApproval')base.cwd=process.cwd();
 if(method==='mcpServer/elicitation/request')base={threadId:'thread-one',turnId:'turn-one',serverName:'synthetic',mode:'form',message:'Synthetic request',requestedSchema:{type:'object',properties:{}}};
 if(method==='item/tool/requestUserInput')base={threadId:'thread-one',turnId:'turn-one',itemId:'item-one',isBlocking:true,questions:[]};
 const value={...base,...params};if(Array.isArray(value.questions))value.questions=value.questions.map(q=>({header:'Question',question:'Synthetic question',...q}));
 return {id,method,params:value};
}
async function fixture(t,{demo=false}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'light-approval-'));
 const client=demo?new DemoClient():new RpcClient({command:process.execPath,args:[fileURLToPath(new URL('./approval-backend-fixture.mjs',import.meta.url))],cwd:root});
 const app=await createServer({client,projectsRoot:path.join(root,'projects'),cwd:root});await app.started;
 t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});return app;
}
async function stream(t,app){
 const abort=new AbortController(),response=await fetch(app.origin+'/api/events',{headers:headers(app),signal:abort.signal}),reader=response.body.getReader(),events=[];let buffer='',notify;
 const pump=(async()=>{try{while(true){const {value,done}=await reader.read();if(done)return;buffer+=new TextDecoder().decode(value);let index;while((index=buffer.indexOf('\n\n'))!==-1){const line=buffer.slice(0,index);buffer=buffer.slice(index+2);if(line.startsWith('data: ')){events.push(JSON.parse(line.slice(6)));notify?.();}}}}catch(error){if(!abort.signal.aborted)throw error;}})();
 t.after(async()=>{abort.abort();await pump;});
 return {events,next:predicate=>new Promise((resolve,reject)=>{let timer;const check=()=>{const index=events.findIndex(predicate);if(index>=0){clearTimeout(timer);notify=null;resolve(events.splice(index,1)[0]);}};notify=check;timer=setTimeout(()=>{notify=null;reject(Error('Missing SSE event'));},4000);check();})};
}
const emit=(app,value)=>app.rpc.call('test/request',{request:value});
const sendNotification=(app,value)=>app.rpc.call('test/notification',{notification:value});
async function pending(app,id){return (await status(app)).pendingRequests.find(value=>value.id===id);}
async function submit(app,id,result){const current=await pending(app,id);assert.ok(current);return post(app,{id,bridgeRequestToken:current.bridgeRequestToken,result});}

test('stdio → SSE/status → authenticated HTTP → stdio carries every supported once-only response',async t=>{
 const app=await fixture(t),sse=await stream(t,app);
 assert.deepEqual((await app.rpc.call('test/initialization')).capabilities,{experimentalApi:true,requestAttestation:false,requiredHumanApproval:true});
 const rows=[
  ['item/commandExecution/requestApproval',{availableDecisions:['accept','decline','cancel']},{decision:'accept'}],
  ['item/fileChange/requestApproval',{}, {decision:'decline'}],
  ['execCommandApproval',{conversationId:'legacy-thread'}, {decision:'approved'}],
  ['applyPatchApproval',{conversationId:'legacy-thread'}, {decision:{denied:{rejection:'Synthetic user refusal'}}}],
  ['item/tool/requestUserInput',{isBlocking:true,questions:[{id:'choice',options:[{label:'A',description:'First'}],isOther:true},{id:'secret',isSecret:true},{id:'skip'}]}, {answers:{choice:{answers:['Custom answer']},secret:{answers:['  synthetic secret  ']},skip:{answers:[]}}}],
  ['item/permissions/requestApproval',{permissions:{network:{enabled:true},fileSystem:{read:['/synthetic/a'],write:['/synthetic/b']}}},{permissions:{fileSystem:{read:['/synthetic/a']}},scope:'turn'}],
  ['mcpServer/elicitation/request',{mode:'form',serverName:'synthetic',requestedSchema:{type:'object',properties:{name:{type:'string'},count:{type:'integer',minimum:1}},required:['name']}},{action:'accept',content:{name:'test',count:3},_meta:null}],
  ['mcpServer/elicitation/request',{mode:'url',serverName:'synthetic',url:'https://example.invalid/auth'},{action:'cancel'}],
  ['item/commandExecution/requestApproval',{kind:'humanCommand',availableDecisions:['accept','decline','cancel']},{decision:'accept'}],
  ['mcpServer/elicitation/request',{mode:'form',requestedSchema:{type:'object',properties:{color:{type:'string',oneOf:[{const:'red',title:'Red'}]},tags:{type:'array',items:{type:'string',enum:['a','b']},minItems:1},flag:{type:'boolean'},count:{type:'integer',minimum:0}},required:['color','tags','flag','count']}},{action:'accept',content:{color:'red',tags:['a','b'],flag:false,count:0},_meta:null}],
  ['mcpServer/elicitation/request',{mode:'form',requestedSchema:{type:'object',properties:{tags:{type:'array',items:{type:'string',enum:['a','b']},minItems:0}},required:['tags']}},{action:'accept',content:{tags:[]},_meta:null}],
  ...['openai/form','openaiForm'].map(mode=>['mcpServer/elicitation/request',{mode,requestedSchema:{type:'object',properties:{name:{type:'string'}},required:['name']}},{action:'accept',content:{name:'alias form'},_meta:null}])
 ];
 for(let index=0;index<rows.length;index++){
  const [method,params,result]=rows[index],id=100+index;await emit(app,request(id,method,params));
  const event=await sse.next(value=>value.id===id),snapshot=await pending(app,id);assert.equal(event.bridgeRequestToken,snapshot.bridgeRequestToken);assert.equal(typeof event.bridgeRequestToken,'string');
  const response=await post(app,{id,bridgeRequestToken:event.bridgeRequestToken,result});assert.equal(response.status,200,await response.text());
  await sse.next(value=>value.method==='serverRequest/resolved'&&value.params.requestId===id);assert.equal(await pending(app,id),undefined);
  const received=await app.rpc.call('test/received'),native=received.at(-1);assert.equal(native.id,id);assert.equal(Object.hasOwn(native,'bridgeRequestToken'),false);assert.deepEqual(native.result,index===7?{action:'cancel',content:null,_meta:null}:result);
 }
 assert.equal(app.operations.entries.size,0,'answers are never stored as mutation receipts');
});

test('HTTP validates envelope, exact native id type, instance token, replay and reused id',async t=>{
 const app=await fixture(t);await emit(app,request(1,'item/fileChange/requestApproval'));await emit(app,request('1','item/fileChange/requestApproval'));
 assert.equal((await status(app)).pendingRequests.length,2);const numeric=await pending(app,1),text=await pending(app,'1');assert.notEqual(numeric.bridgeRequestToken,text.bridgeRequestToken);
 for(const input of [{id:1,result:{decision:'accept'}},{id:1,bridgeRequestToken:text.bridgeRequestToken,result:{decision:'accept'}}]){const r=await post(app,input);assert.equal(r.status,409);assert.equal((await r.json()).code,'STALE_APPROVAL');}
 for(const input of [{id:[1],bridgeRequestToken:numeric.bridgeRequestToken,result:{decision:'accept'}},{id:1,bridgeRequestToken:numeric.bridgeRequestToken,result:{decision:'accept'},error:{code:-32601}},{id:1,bridgeRequestToken:numeric.bridgeRequestToken,result:{decision:'accept'},extra:true}])assert.equal((await post(app,input)).status,400);
 const answer={id:1,bridgeRequestToken:numeric.bridgeRequestToken,result:{decision:'accept'}};assert.equal((await post(app,answer)).status,200);assert.equal((await post(app,answer)).status,409);assert.ok(await pending(app,'1'));
 await emit(app,request(1,'item/fileChange/requestApproval'));const reused=await pending(app,1);assert.notEqual(reused.bridgeRequestToken,numeric.bridgeRequestToken);assert.equal((await post(app,answer)).status,409);assert.equal((await submit(app,1,{decision:'decline'})).status,200);
 const parallel=await Promise.all(['accept','decline'].map(decision=>post(app,{id:'1',bridgeRequestToken:text.bridgeRequestToken,result:{decision}})));assert.deepEqual(parallel.map(response=>response.status).sort(),[200,409]);
 const received=await app.rpc.call('test/received');assert.equal(received.length,3);assert.equal(received.at(-1).id,'1');
});

test('authoritative resolved, correlated completion, thread closure and disconnect expire exact requests',async t=>{
 const app=await fixture(t),sse=await stream(t,app);
 for(const value of [request(20,'item/tool/requestUserInput'),request('20','item/tool/requestUserInput'),request(21,'item/fileChange/requestApproval',{turnId:'other-turn'}),request(22,'mcpServer/elicitation/request',{turnId:null}),request(23,'item/fileChange/requestApproval',{threadId:'other-thread'}),{id:24,method:'execCommandApproval',params:{conversationId:'thread-one'}},{id:25,method:'currentTime/read',params:{}}])await emit(app,value);
 const old=await pending(app,20);await sendNotification(app,{method:'serverRequest/resolved',params:{requestId:20,threadId:'thread-one'}});assert.equal(await pending(app,20),undefined);assert.ok(await pending(app,'20'));assert.equal((await post(app,{id:20,bridgeRequestToken:old.bridgeRequestToken,result:{answers:{}}})).status,409);
 await sendNotification(app,{method:'turn/completed',params:{threadId:'thread-one',turn:{id:'turn-one'}}});assert.equal(await pending(app,'20'),undefined);assert.equal(await pending(app,24),undefined);assert.ok(await pending(app,21));assert.ok(await pending(app,22));assert.ok(await pending(app,23));
 await sendNotification(app,{method:'thread/closed'});assert.ok(await pending(app,22));assert.ok(await pending(app,25),'malformed close must not match unscoped requests');
 await sendNotification(app,{method:'thread/closed',params:{threadId:'thread-one'}});assert.equal(await pending(app,21),undefined);assert.equal(await pending(app,22),undefined);assert.ok(await pending(app,23));
 await assert.rejects(app.rpc.call('test/exit'));await sse.next(value=>value.method==='bridge/status'&&value.params.connected===false);assert.deepEqual((await status(app)).pendingRequests,[]);assert.ok(sse.events.some(value=>value.method==='serverRequest/resolved'&&value.params.requestId===23));
});

test('duplicate pending request retains its token; conflicting duplicate closes instead of overwriting',async t=>{
 const app=await fixture(t),value=request(30,'item/fileChange/requestApproval');await emit(app,value);const first=await pending(app,30);await emit(app,value);assert.equal((await pending(app,30)).bridgeRequestToken,first.bridgeRequestToken);
 await assert.rejects(emit(app,request(30,'item/fileChange/requestApproval',{itemId:'different'})),error=>error.code==='DUPLICATE_SERVER_REQUEST');assert.equal(app.rpc.connected,false);assert.equal((await status(app)).pendingRequests.length,0);
});

test('unknown request explicit error and transport failure never create fake successful response',async t=>{
 const app=await fixture(t);await emit(app,request('unknown','synthetic/unsupported'));const current=await pending(app,'unknown');assert.equal((await submit(app,'unknown',{approved:true})).status,400);
 assert.equal((await post(app,{id:'unknown',bridgeRequestToken:current.bridgeRequestToken,error:{code:-32601}})).status,200);assert.deepEqual((await app.rpc.call('test/received')).at(-1),{id:'unknown',error:{code:-32601,message:'This GUI does not support this request.'}});
 await emit(app,request(31,'item/fileChange/requestApproval'));const write=app.rpc.write;app.rpc.write=()=>{throw Object.assign(Error('Synthetic input full'),{code:'INPUT_BACKPRESSURE'});};const failed=await submit(app,31,{decision:'accept'});assert.equal(failed.status,400);assert.equal((await failed.json()).code,'INPUT_BACKPRESSURE');assert.ok(await pending(app,31));app.rpc.write=write;assert.equal((await app.rpc.call('test/received')).length,1);assert.equal((await submit(app,31,{decision:'decline'})).status,200);
});

test('invalid modern decisions, unsafe MCP accepts and unauthenticated responses stay pending',async t=>{
 const app=await fixture(t);
 const rows=[
  [request(50,'item/commandExecution/requestApproval',{availableDecisions:['decline']}),{decision:'accept'}],
  [request(51,'mcpServer/elicitation/request',{mode:'url',url:'https://example.invalid/auth',elicitationId:'synthetic'}),{action:'accept',content:{}}],
  [request(52,'mcpServer/elicitation/request',{requestedSchema:{type:'object',properties:{password:{type:'string'}}}}),{action:'accept',content:{password:'synthetic-secret'}}],
  [request(53,'mcpServer/elicitation/request',{requestedSchema:{type:'object',properties:{nested:{type:'object'}}}}),{action:'accept',content:{nested:{yes:true}}}],
  [request(54,'mcpServer/elicitation/request',{mode:'openai/userVerification',title:'Synthetic verification',description:'No authenticator',challenge:'synthetic'}),{action:'accept',content:{proof:'synthetic'}}]
 ];
 for(const [value,result]of rows){await emit(app,value);const current=await pending(app,value.id);assert.equal((await fetch(app.origin+'/api/respond',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:value.id,bridgeRequestToken:current.bridgeRequestToken,result})})).status,401);assert.equal((await submit(app,value.id,result)).status,400);assert.ok(await pending(app,value.id));}
 assert.deepEqual(await app.rpc.call('test/received'),[]);
});

test('DemoClient shares token projection, strict typed response and resolved lifecycle',async t=>{
 const app=await fixture(t,{demo:true}),sse=await stream(t,app),value=request(40,'item/fileChange/requestApproval');app.rpc.requests.set('40',value);app.rpc.emit('event',value);const event=await sse.next(message=>message.id===40);assert.equal((await pending(app,40)).bridgeRequestToken,event.bridgeRequestToken);assert.equal((await submit(app,40,{decision:'cancel'})).status,200);await sse.next(message=>message.method==='serverRequest/resolved'&&message.params.requestId===40);assert.equal(app.rpc.requests.size,0);
});

test('modern absolute-path permission entries grant only selected paths and retain every deny on native wire',async t=>{
 const app=await fixture(t),entry=(access,value)=>({access,path:{type:'path',path:value}}),read=entry('read','/synthetic/read'),write=entry('write','/synthetic/write'),deny=entry('deny','/synthetic/read/private');
 const permissions={network:{enabled:true},fileSystem:{entries:[read,write,deny]}};await emit(app,request(60,'item/permissions/requestApproval',{permissions}));
 const result=entries=>({scope:'turn',permissions:{fileSystem:{entries}}});
 for(const forged of [result([read]),result([entry('write','/synthetic/read'),deny]),result([read,entry('deny','/elsewhere')]),result([read,deny,entry('read','/elsewhere')]),result([read,deny,deny])]){assert.equal((await submit(app,60,forged)).status,400);assert.ok(await pending(app,60));}
 assert.deepEqual(await app.rpc.call('test/received'),[]);assert.equal((await submit(app,60,result([read,deny]))).status,200);assert.deepEqual((await app.rpc.call('test/received')).at(-1),{id:60,result:result([read,deny])});
 await emit(app,request(61,'item/permissions/requestApproval',{permissions}));assert.equal((await submit(app,61,{permissions:{network:{enabled:true}},scope:'turn'})).status,200);
 await emit(app,request(64,'item/permissions/requestApproval',{permissions}));const session={...result([read,deny]),scope:'session'};assert.equal((await submit(app,64,session)).status,200);assert.deepEqual((await app.rpc.call('test/received')).at(-1),{id:64,result:session});
 await emit(app,request(63,'item/permissions/requestApproval',{permissions:{fileSystem:{entries:[read,deny],read:null,write:null,globScanMaxDepth:null}}}));assert.equal((await submit(app,63,result([read,deny]))).status,200,'nullable unused scan depth must not reject plain paths');
 for(const pathValue of [{type:'glob_pattern',pattern:'/synthetic/**'},{type:'special',value:{kind:'root'}}]){await emit(app,request(62,'item/permissions/requestApproval',{permissions:{fileSystem:{entries:[{access:'write',path:pathValue}]}}}));assert.equal((await submit(app,62,{permissions:{fileSystem:{entries:[write]}},scope:'turn'})).status,400);assert.equal((await submit(app,62,{permissions:{},scope:'turn'})).status,200);}
});

test('MCP privileged approval metadata cannot bypass frontend gating; ordinary empty forms remain valid',async t=>{
 const app=await fixture(t);
 for(const kind of ['unrecognized_privileged_kind',null,7]){
  await emit(app,request(70,'mcpServer/elicitation/request',{_meta:{codex_approval_kind:kind}}));assert.equal((await submit(app,70,{action:'accept',content:{}})).status,400);assert.ok(await pending(app,70));assert.equal((await submit(app,70,{action:'decline'})).status,200);
 }
 for(const metadata of [undefined,{ordinary_correlation:'synthetic'},{codex_approval_kind:'mcp_tool_call',ordinary_correlation:'synthetic'}]){
  await emit(app,request(71,'mcpServer/elicitation/request',{_meta:metadata}));assert.equal((await submit(app,71,{action:'accept',content:{},_meta:null})).status,200);assert.deepEqual((await app.rpc.call('test/received')).at(-1),{id:71,result:{action:'accept',content:{},_meta:null}});
 }
 await emit(app,request(72,'mcpServer/elicitation/request',{_meta:{codex_approval_kind:'unrecognized_privileged_kind'},requestedSchema:{type:'object',properties:{name:{type:'string'}},required:['name']}}));assert.equal((await submit(app,72,{action:'accept',content:{name:'synthetic'}})).status,400);assert.equal((await submit(app,72,{action:'cancel'})).status,200);
 assert.equal((await app.rpc.call('test/received')).length,7);
});

test('legacy approvals reject session/policy mutation and user input preserves skip and secret bytes',()=>{
 for(const method of ['execCommandApproval','applyPatchApproval'])for(const decision of ['approved_for_session','approved_mcp_policy_amendment',{approved_execpolicy_amendment:{}},{network_policy_amendment:{}}])assert.throws(()=>validateResponse({method},{decision}));
 const value={answers:{q:{answers:[]},s:{answers:[' \t ']}}};assert.strictEqual(validateResponse(request(1,'item/tool/requestUserInput',{questions:[{id:'q'},{id:'s',isSecret:true}]}),value),value);
 for(const questions of [undefined,[{id:'q'},{id:'q'}]])assert.throws(()=>validateResponse(request(1,'item/tool/requestUserInput',{questions}),{answers:{q:{answers:[]}}}));
});
