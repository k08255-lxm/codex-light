import http from 'node:http';import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from '../src/server.mjs';
async function fixture(t){const app=await createServer({demo:true});await app.started;t.after(()=>app.close());return app;}
let requestSequence=0;
const post=(a,url,data,extra={})=>{if(url==='/api/rpc'&&['thread/start','turn/start','turn/interrupt'].includes(data.method)&&data.requestId===undefined)data={...data,requestId:`${a.operations.serverInstance}:${Date.now()}:operation-${++requestSequence}`};return fetch(a.origin+url,{method:'POST',headers:{Authorization:`Bearer ${a.token}`,'Content-Type':'application/json',...extra},body:JSON.stringify(data)});};
test('loopback, token, origin and CSRF gates',async t=>{
 const a=await fixture(t);assert.equal(a.server.address().address,'127.0.0.1');
 assert.equal((await fetch(a.origin+'/api/status')).status,401);
 assert.equal((await post(a,'/api/rpc',{method:'thread/list',params:{}},{Origin:'https://evil.example'})).status,403);
 const hostStatus=await new Promise(resolve=>{const req=http.request(a.origin+'/api/status',{headers:{Host:'evil.example',Authorization:`Bearer ${a.token}`}},res=>{res.resume();resolve(res.statusCode);});req.end();});assert.equal(hostStatus,403);
 assert.equal((await post(a,'/api/rpc',{method:'config/value/write',params:{}})).status,400);
});
test('demo round trip never requires auth or inference',async t=>{
 const a=await fixture(t);const headers={Authorization:`Bearer ${a.token}`};
 const status=await (await fetch(a.origin+'/api/status',{headers})).json();assert.equal(status.demo,true);assert.equal(status.connected,true);
 const r=await post(a,'/api/rpc',{method:'thread/start',params:{cwd:process.cwd(),approvalPolicy:'on-request',sandbox:'workspace-write'}});const {thread}=await r.json();assert.ok(thread.id);
 const turn=await post(a,'/api/rpc',{method:'turn/start',params:{threadId:thread.id,cwd:process.cwd(),input:[{type:'text',text:'demo'}]}});assert.equal(turn.status,200);
 const missing=await post(a,'/api/rpc',{method:'thread/start',params:{cwd:'/not-existing-path-9919',approvalPolicy:'on-request',sandbox:'workspace-write'}});assert.equal(missing.status,400);
});
test('SSE delivers events and disconnect cleans up',async t=>{
 const a=await fixture(t);const abort=new AbortController();const response=await fetch(a.origin+'/api/events',{headers:{Authorization:`Bearer ${a.token}`},signal:abort.signal});
 const reader=response.body.getReader();await reader.read();a.rpc.emit('event',{method:'test/event',params:{value:1}});const result=await reader.read();assert.match(new TextDecoder().decode(result.value),/test\/event/);abort.abort();
});
test('missing or stale approval is rejected',async t=>{
 const a=await fixture(t);assert.equal((await post(a,'/api/respond',{id:123,result:{decision:'accept'}})).status,400);
 a.rpc.requests.set('12',{id:12,method:'item/commandExecution/requestApproval',params:{}});
 assert.equal((await post(a,'/api/respond',{id:12,result:{decision:'acceptForSession'}})).status,400);
 assert.equal((await post(a,'/api/respond',{id:12,result:{decision:'decline'}})).status,200);
});
test('all entry HTML assets and JavaScript imports are locally served',async t=>{
 const a=await fixture(t);const htmlResponse=await fetch(a.origin+'/');assert.equal(htmlResponse.status,200);const html=await htmlResponse.text();
 for(const match of html.matchAll(/(?:src|href)="(\/[^"#]+)"/g)){
  const response=await fetch(a.origin+match[1]);assert.equal(response.status,200,match[1]);
 }
 const js=await (await fetch(a.origin+'/app.js')).text();
 for(const match of js.matchAll(/from\s+['"]\.\/(.+?)['"]/g))assert.equal((await fetch(a.origin+'/'+match[1])).status,200,match[1]);
 assert.match(htmlResponse.headers.get('content-security-policy'),/frame-ancestors 'none'/);
 assert.equal((await fetch(a.origin+'/src/server.mjs')).status,404);
});
test('normal large SSE event survives stream backpressure intact',async t=>{
 const a=await fixture(t);const abort=new AbortController();const response=await fetch(a.origin+'/api/events',{headers:{Authorization:`Bearer ${a.token}`},signal:abort.signal});const reader=response.body.getReader();await reader.read();
 const payload='x'.repeat(128*1024);a.rpc.emit('event',{method:'large',params:{payload}});let buffer='';
 while(!buffer.includes('\n\n')){const {done,value}=await reader.read();assert.equal(done,false,'stream must not be destroyed at its high-water mark');buffer+=new TextDecoder().decode(value);}
 assert.equal(JSON.parse(buffer.slice(6).trim()).params.payload,payload);abort.abort();
});
test('mutation IDs are required and one operation executes once over HTTP',async t=>{
 const a=await fixture(t);const params={cwd:process.cwd(),approvalPolicy:'on-request',sandbox:'workspace-write'};
 const missing=await post(a,'/api/rpc',{method:'thread/start',params,requestId:null});assert.equal(missing.status,400);assert.equal((await missing.json()).notExecuted,true);
 const requestId=`${a.operations.serverInstance}:${Date.now()}:http-operation-1`;
 const [one,two]=await Promise.all([post(a,'/api/rpc',{method:'thread/start',params,requestId}),post(a,'/api/rpc',{method:'thread/start',params,requestId})]);assert.deepEqual(await one.json(),await two.json());assert.equal(a.rpc.threads.size,1);
 const operation=await (await fetch(a.origin+'/api/operations?requestId='+encodeURIComponent(requestId),{headers:{Authorization:`Bearer ${a.token}`}})).json();assert.equal(operation.state,'succeeded');
 const conflict=await post(a,'/api/rpc',{method:'thread/start',params:{...params,model:'different'},requestId});assert.equal(conflict.status,409);assert.equal((await conflict.json()).outcome,'unknown');assert.equal(a.rpc.threads.size,1);
});
test('image upload remains local and only opaque owned IDs become localImage input',async t=>{
 const a=await fixture(t);const png=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
 const unauth=await fetch(a.origin+'/api/uploads',{method:'POST',body:png});assert.equal(unauth.status,401);
 const uploaded=await fetch(a.origin+'/api/uploads',{method:'POST',headers:{Authorization:`Bearer ${a.token}`,'X-Filename':encodeURIComponent('demo.png')},body:png});assert.equal(uploaded.status,200);const attachment=await uploaded.json();assert.ok(attachment.id);assert.equal(attachment.path,undefined);
 const created=await post(a,'/api/rpc',{method:'thread/start',params:{cwd:process.cwd(),approvalPolicy:'on-request',sandbox:'workspace-write'}});const {thread}=await created.json();
 const sent=await post(a,'/api/rpc',{method:'turn/start',params:{threadId:thread.id,cwd:process.cwd(),input:[{type:'text',text:''}]},attachmentIds:[attachment.id]});assert.equal(sent.status,200);
 const user=a.rpc.items.get(thread.id)[0].item;assert.equal(user.content[0].type,'localImage');assert.ok(user.content[0].path.endsWith('.png'));
 const invalid=await post(a,'/api/rpc',{method:'turn/start',params:{threadId:thread.id,cwd:process.cwd(),input:[{type:'text',text:'x'}]},attachmentIds:['../../secret']});assert.equal(invalid.status,400);
 const wrongMethod=await post(a,'/api/rpc',{method:'thread/list',params:{},attachmentIds:[attachment.id]});assert.equal(wrongMethod.status,400);
});
test('DSH refresh never exposes arbitrary MCP execution and stays bound to thread',async t=>{
 const {DemoClient}=await import('../src/demo.mjs');const a=await createServer({client:new DemoClient(),demo:false,cwd:process.cwd()});await a.started;t.after(()=>a.close());
 const calls=[];const original=a.rpc.call.bind(a.rpc);a.rpc.call=async(method,params)=>{calls.push({method,params});if(method==='mcpServer/tool/call')return {structuredContent:{agent_id:'agent-a',events:[{type:'assistant/final',text:'fixture event'}]}};return original(method,params);};
 assert.equal((await post(a,'/api/dsh/read',{threadId:'t',agentId:'agent-a',kind:'status'})).status,400);
 a.rpc.emit('event',{method:'item/completed',params:{threadId:'t',item:{id:'call-a',type:'mcpToolCall',server:'dsh_subagent',tool:'dsh_start',status:'completed',result:{structuredContent:{agent_id:'agent-a',status:'running'}}}}});
 assert.equal((await post(a,'/api/dsh/read',{threadId:'other',agentId:'agent-a',kind:'status'})).status,400);
 assert.equal((await post(a,'/api/dsh/read',{threadId:'t',agentId:'agent-a',kind:'start'})).status,400);
 assert.equal((await post(a,'/api/dsh/read',{threadId:'t',agentId:'agent-a',kind:'result'})).status,400);
 const result=await post(a,'/api/dsh/read',{threadId:'t',agentId:'agent-a',kind:'events',after:'1:2:3'});assert.equal(result.status,200);const body=await result.json();assert.equal(body.tool,'dsh_events');assert.equal(body.result.structuredContent.events[0].text,'fixture event');
 assert.deepEqual(calls,[{method:'mcpServer/tool/call',params:{threadId:'t',server:'dsh_subagent',tool:'dsh_events',arguments:{agent_id:'agent-a',include_progress:true,include_tool_events:true,include_descendants:true,limit:100,max_chars:12000,after:'1:2:3'}}}]);
});
test('successful mutation replay survives cwd removal; invalid reuse never claims original not executed',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const os=await import('node:os');const path=await import('node:path');
 const a=await fixture(t);const cwd=await mkdtemp(path.join(os.tmpdir(),'codex-light-replay-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
 const requestId=`${a.operations.serverInstance}:${Date.now()}:replay-cwd-test`;
 const data={requestId,method:'thread/start',params:{cwd,approvalPolicy:'on-request',sandbox:'workspace-write'}};
 const first=await post(a,'/api/rpc',data);assert.equal(first.status,200);const result=await first.json();await rm(cwd,{recursive:true});
 const replay=await post(a,'/api/rpc',data);assert.equal(replay.status,200);assert.deepEqual(await replay.json(),result);
 const bad=await post(a,'/api/rpc',{...data,params:{...data.params,cwd:''}});assert.equal(bad.status,400);const error=await bad.json();assert.equal(error.notExecuted,false);assert.equal(error.outcome,'unknown');
});
test('remote changes require explicit confirmation and observed device; pairing codes expire in memory',async t=>{
 const {DemoClient}=await import('../src/demo.mjs');const client=new DemoClient();let changes=0;const base=client.call.bind(client);
 client.call=async(method,p)=>{
  if(method==='remoteControl/status/read')return {status:'connected',serverName:'mock',installationId:'mock',environmentId:'env-1'};
  if(method==='remoteControl/client/list')return {data:[{clientId:'device-1',displayName:'Test device'}],nextCursor:null};
  if(method==='remoteControl/pairing/start'){changes++;return {pairingCode:'private-test-code',manualPairingCode:'123456',environmentId:'env-1',expiresAt:Math.floor(Date.now()/1000)+1};}
  if(method==='remoteControl/client/revoke'){changes++;return {};}
  if(method==='remoteControl/pairing/status')return {claimed:false};
  return base(method,p);
 };
 const a=await createServer({client,demo:true});await a.started;t.after(()=>a.close());
 const id=suffix=>`${a.operations.serverInstance}:${Date.now()}:remote-${suffix}`;
 let r=await post(a,'/api/rpc',{method:'remoteControl/pairing/start',params:{manualCode:true},requestId:id('unapproved')});assert.equal(r.status,400);assert.equal(changes,0);
 await post(a,'/api/rpc',{method:'remoteControl/status/read',params:{}});
 r=await post(a,'/api/rpc',{method:'remoteControl/client/revoke',params:{environmentId:'env-1',clientId:'unknown'},confirmed:true,requestId:id('revoke-unknown')});assert.equal(r.status,400);assert.equal(changes,0);
 await post(a,'/api/rpc',{method:'remoteControl/client/list',params:{environmentId:'env-1'}});
 r=await post(a,'/api/rpc',{method:'remoteControl/client/revoke',params:{environmentId:'env-1',clientId:'device-1'},confirmed:true,requestId:id('revoke-known')});assert.equal(r.status,200);assert.equal(changes,1);
 const requestId=id('pairing');r=await post(a,'/api/rpc',{method:'remoteControl/pairing/start',params:{manualCode:true},confirmed:true,requestId});assert.equal(r.status,200);assert.equal((await r.json()).pairingCode,'private-test-code');
 r=await post(a,'/api/rpc',{method:'remoteControl/pairing/status',params:{pairingCode:'wrong-code'}});assert.equal(r.status,400);
 await new Promise(resolve=>setTimeout(resolve,1100));const stored=a.operations.get(requestId);assert.equal(stored.state,'succeeded');assert.equal(stored.result.pairingCode,undefined);assert.equal(stored.result.manualPairingCode,undefined);assert.equal(stored.result.expired,true);
 r=await post(a,'/api/rpc',{method:'remoteControl/pairing/status',params:{pairingCode:'private-test-code'}});assert.equal(r.status,400);
 const second=id('pairing-second');r=await post(a,'/api/rpc',{method:'remoteControl/pairing/start',params:{manualCode:true},confirmed:true,requestId:second});assert.equal(r.status,200);
 await post(a,'/api/rpc',{method:'remoteControl/pairing/start',params:{manualCode:true},confirmed:true,requestId});
 r=await post(a,'/api/rpc',{method:'remoteControl/pairing/status',params:{pairingCode:'private-test-code'}});assert.equal(r.status,200); // replaying an old completed operation cannot erase a newer active pairing

});
test('xterm styles use fresh HTML nonce without relaxing script or unnonced style CSP',async t=>{
 const a=await fixture(t),response=await fetch(a.origin+'/'),html=await response.text(),csp=response.headers.get('content-security-policy');
 const nonce=html.match(/name="codex-light-style-nonce" content="([A-Za-z0-9+/=]+)"/)?.[1];assert.ok(nonce);assert.ok(csp.includes(`style-src 'self' 'nonce-${nonce}'`));assert.ok(csp.includes("script-src 'self';"));assert.ok(!csp.includes('unsafe-inline'));assert.ok(!csp.includes('unsafe-eval'));
 const other=await (await fetch(a.origin+'/')).text();assert.ok(!other.includes(`content="${nonce}"`));
 for(const path of ['/vendor/xterm.mjs','/vendor/addon-fit.mjs','/vendor/xterm.css','/terminal.js'])assert.equal((await fetch(a.origin+path)).status,200);
 const vendor=await(await fetch(a.origin+'/vendor/xterm.mjs')).text();assert.match(vendor,/if\(nonce\)el.nonce=nonce/);
});
