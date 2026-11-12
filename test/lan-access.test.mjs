import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {LanAccess} from '../src/lan-access.mjs';

const ADDRESS='192.168.123.7';
const interfaces=()=>({
 'Fixture Wi-Fi':[{address:ADDRESS,family:'IPv4',internal:false},{address:'127.0.0.1',family:'IPv4',internal:true}],
 'Fixture Ethernet':[{address:'10.12.0.2',family:4,internal:false},{address:'8.8.8.8',family:'IPv4',internal:false},{address:'fd00::1',family:'IPv6',internal:false}],
 duplicate:[{address:ADDRESS,family:'IPv4',internal:false}],
});
const bearer=status=>`Bearer ${new URL(status.url).hash.slice('#token='.length)}`;
function fixture(t,options={}){
 const calls=[],bindings=[];
 const manager=new LanAccess({
  publicPaths:['/','/index.html','/app.js','/icon.svg'],networkInterfaces:interfaces,
  handler:(req,res,context)=>{
   calls.push({path:req.url,access:context.access,origin:context.origin});
   if(req.url==='/api/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': synthetic connection\n\n');return;}
   if(req.url==='/explode')throw new Error('Do not reflect a synthetic private error');
   res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({sharedHandler:true,access:context.access}));
  },
  serverFactory:listener=>{
   const server=http.createServer(listener),listen=server.listen;
   server.listen=function(options,...args){bindings.push(options.host);return listen.call(this,{...options,host:'127.0.0.1'},...args);};
   return server;
  },...options,
 });
 t.after(()=>manager.close());return {manager,calls,bindings};
}
function request(status,{path='/',method='GET',headers={}}={}){
 return new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port:status.port,path,method,agent:false,headers:Array.isArray(headers)?headers:{Host:new URL(status.origin).host,...headers}},res=>{
   const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));
  });req.setTimeout(2000,()=>req.destroy(new Error('Synthetic request timeout')));req.on('error',reject);req.end();
 });
}
async function stream(status){
 return new Promise((resolve,reject)=>{
  const req=http.get({host:'127.0.0.1',port:status.port,path:'/api/events',agent:false,headers:{Host:new URL(status.origin).host,Authorization:bearer(status)}},res=>{
   const closed=new Promise(done=>res.once('close',done));res.on('error',()=>{});res.once('data',()=>resolve({req,res,closed}));
  });req.on('error',reject);
 });
}
async function promptly(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Revocation did not close the synthetic stream')),2000);})]);}finally{clearTimeout(timer);}}

test('LAN defaults off and lists only distinct private IPv4 interface candidates without listening',t=>{
 const {manager,bindings}=fixture(t),state=manager.status();
 assert.equal(state.enabled,false);assert.equal(state.url,null);assert.equal(state.port,null);assert.equal(state.encrypted,false);assert.equal(state.transport,'http');
 assert.deepEqual(state.addresses.map(row=>row.address),[ADDRESS,'10.12.0.2']);assert.deepEqual(bindings,[]);
});

test('enable validates selected interfaces, exact options and port before creating a listener',async t=>{
 const {manager,bindings}=fixture(t);
 for(const input of [null,[],{}, {address:'0.0.0.0'},{address:'127.0.0.1'},{address:'8.8.8.8'},{address:'192.168.12.99'},{address:'localhost'},{address:ADDRESS,port:'0'},{address:ADDRESS,port:-1},{address:ADDRESS,port:65536},{address:ADDRESS,port:1.5},{address:ADDRESS,extra:true}]){
  await assert.rejects(manager.enable(input),error=>error.status===400&&error.outcome==='notExecuted');
 }
 assert.equal(bindings.length,0);assert.equal(manager.status().enabled,false);
});

test('one opt-in listener reuses the handler and exposes a separate fragment-only capability',async t=>{
 const {manager,bindings,calls}=fixture(t),state=await manager.enable({address:ADDRESS});
 assert.deepEqual(bindings,[ADDRESS]);assert.ok(state.port>0);assert.equal(new URL(state.origin).hostname,ADDRESS);assert.equal(new URL(state.url).search,'');assert.match(new URL(state.url).hash,/^#token=[a-f0-9]{64}$/);
 const page=await request(state),script=await request(state,{path:'/app.js'});assert.equal(page.status,200);assert.equal(script.status,200);assert.equal(page.headers['cache-control'],'no-store');assert.equal(page.headers['access-control-allow-origin'],undefined);
 const api=await request(state,{path:'/api/status',headers:{Authorization:bearer(state),Origin:state.origin}});assert.equal(api.status,200);assert.equal(JSON.parse(api.body).access,'lan');assert.equal(calls.length,3);
 await assert.rejects(manager.enable({address:ADDRESS}),error=>error.status===409);
});

test('API, attachments, previews, health and static writes require the current LAN token',async t=>{
 const {manager,calls}=fixture(t),state=await manager.enable({address:ADDRESS});
 for(const [path,method] of [['/api/status','GET'],['/api/uploads','POST'],['/api/file-uploads','POST'],['/preview/private.png','GET'],['/health','GET'],['/app.js','POST']]){
  assert.equal((await request(state,{path,method})).status,401);
  assert.equal((await request(state,{path,method,headers:{Authorization:'Bearer SYNTHETIC_MAIN_TOKEN'}})).status,401);
  assert.equal((await request(state,{path,method,headers:{Authorization:bearer(state)}})).status,200);
 }
 assert.equal(calls.length,6);
});

test('Host/Origin and request-target boundaries reject rebinding, cross-origin and query tokens',async t=>{
 const {manager,calls}=fixture(t),state=await manager.enable({address:ADDRESS}),auth={Authorization:bearer(state)};
 for(const headers of [{Host:'evil.example'},{Host:`127.0.0.1:${state.port}`},{Host:`${ADDRESS}:${state.port+1}`},{Origin:'http://evil.example'},{Origin:'null'},{Origin:''}])assert.equal((await request(state,{headers:{...auth,...headers}})).status,403);
 for(const path of ['//evil.example/api/status',state.origin+'/api/status','/api/status#token=not-allowed', '/api/status?token=not-allowed','/api/status?%74oken=not-allowed','/api/status?access_token=not-allowed'])assert.equal((await request(state,{path,headers:auth})).status,400);
 assert.equal(calls.length,0);
});

test('duplicate security headers are rejected even if Node normally discards duplicates',async t=>{
 const {manager,calls}=fixture(t),state=await manager.enable({address:ADDRESS}),host=new URL(state.origin).host;
 for(const extra of [['Host',host],['Origin',state.origin,'Origin',state.origin],['Authorization',bearer(state),'Authorization',bearer(state)]])assert.equal((await request(state,{headers:['Host',host,...extra]})).status,400);
 assert.equal(calls.length,0);
});

test('LAN credentials cannot reach local management endpoints, including normalized traversal',async t=>{
 const {manager,calls}=fixture(t),state=await manager.enable({address:ADDRESS});
 for(const path of ['/api/lan','/api/lan/status','/api/lan/enable','/api/lan/rotate','/api/lan/disable','/api/shutdown','/api/reopen','/api/desktop/pick-folder','/api/desktop/theme','/api/runtime/update','/api/other/../shutdown'])assert.equal((await request(state,{path,method:'POST',headers:{Authorization:bearer(state)}})).status,403);
 assert.equal(calls.length,0);
});

test('rotation invalidates old tokens and existing SSE but retains the same listener',async t=>{
 const {manager}=fixture(t),old=await manager.enable({address:ADDRESS}),sse=await stream(old);
 const current=await manager.rotate();await promptly(sse.closed);assert.equal(sse.res.destroyed,true);assert.equal(current.port,old.port);assert.equal(current.origin,old.origin);assert.notEqual(current.url,old.url);
 assert.equal((await request(old,{path:'/api/status',headers:{Authorization:bearer(old)}})).status,401);
 assert.equal((await request(current,{path:'/api/status',headers:{Authorization:bearer(current)}})).status,200);
});

test('disable revokes SSE, recycles the listener, and a later enable gets a fresh token',async t=>{
 const {manager}=fixture(t),old=await manager.enable({address:ADDRESS}),sse=await stream(old);
 const disabled=await manager.disable();await promptly(sse.closed);assert.equal(disabled.enabled,false);assert.equal(disabled.url,null);assert.equal(disabled.address,null);
 await assert.rejects(request(old),error=>['ECONNREFUSED','ECONNRESET'].includes(error.code));
 const current=await manager.enable({address:ADDRESS});assert.notEqual(current.url,old.url);assert.equal((await request(current,{path:'/api/status',headers:{Authorization:bearer(current)}})).status,200);
 await manager.disable();await manager.disable();await assert.rejects(manager.rotate(),error=>error.status===409);
});

test('service close is terminal, closes existing streams and cannot race a queued enable',async t=>{
 const {manager}=fixture(t),state=await manager.enable({address:ADDRESS}),sse=await stream(state);
 await manager.close();await promptly(sse.closed);await assert.rejects(manager.enable({address:ADDRESS}),error=>error.code==='LAN_CLOSED');assert.equal(manager.status().enabled,false);
 const next=fixture(t).manager,pending=next.enable({address:ADDRESS}),closing=next.close();await assert.rejects(pending,error=>error.code==='LAN_CLOSED');await closing;assert.equal(next.status().enabled,false);
});

test('bind failure is explicit and does not return an active capability',async t=>{
 const first=fixture(t).manager,state=await first.enable({address:ADDRESS}),second=fixture(t).manager;
 await assert.rejects(second.enable({address:ADDRESS,port:state.port}),error=>error.code==='LAN_LISTEN_FAILED'&&error.status===503);
 assert.equal(second.status().enabled,false);assert.equal(second.status().url,null);
});

test('unexpected application errors do not echo internal messages or capabilities',async t=>{
 const {manager}=fixture(t),state=await manager.enable({address:ADDRESS}),result=await request(state,{path:'/explode',headers:{Authorization:bearer(state)}});
 assert.equal(result.status,500);assert.ok(!result.body.includes('synthetic private'));assert.ok(!result.body.includes(new URL(state.url).hash.slice(7)));
});
