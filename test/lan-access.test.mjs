import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHmac} from 'node:crypto';
import {LanAccess} from '../src/lan-access.mjs';

const ADDRESS='192.168.123.7';
const SECOND='10.12.0.2';
const loopback=address=>address===SECOND?'127.0.0.2':'127.0.0.1';
const interfaces=()=>({
 'Fixture Wi-Fi':[{address:ADDRESS,family:'IPv4',internal:false},{address:'127.0.0.1',family:'IPv4',internal:true}],
 'Fixture Ethernet':[{address:'10.12.0.2',family:4,internal:false},{address:'8.8.8.8',family:'IPv4',internal:false},{address:'fd00::1',family:'IPv6',internal:false}],
 duplicate:[{address:ADDRESS,family:'IPv4',internal:false}],
});
const bearer=status=>`Bearer ${new URL(status.url).hash.slice('#token='.length)}`;
function fixture(t,options={}){
 const calls=[],bindings=[],servers=[];
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
   servers.push(server);
   server.listen=function(options,...args){bindings.push(options.host);return listen.call(this,{...options,host:loopback(options.host)},...args);};
   return server;
  },...options,
 });
 t.after(()=>manager.close());return {manager,calls,bindings,servers};
}
function request(status,{path='/',method='GET',headers={},body}={}){
 return new Promise((resolve,reject)=>{
  const url=new URL(status.origin);
  const req=http.request({host:loopback(status.address),port:status.port||url.port||80,path,method,agent:false,headers:Array.isArray(headers)?headers:{Host:url.host,...headers}},res=>{
   const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));
  });req.setTimeout(2000,()=>req.destroy(new Error('Synthetic request timeout')));req.on('error',reject);req.end(body);
 });
}
async function stream(status){
 return new Promise((resolve,reject)=>{
  const req=http.get({host:loopback(status.address),port:status.port||new URL(status.origin).port||80,path:'/api/events',agent:false,headers:{Host:new URL(status.origin).host,Authorization:bearer(status)}},res=>{
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

test('LAN candidates prefer physical adapters and keep enumeration order within each priority',t=>{
 const candidates={
  'vEthernet (WSL (Hyper-V firewall))':'172.18.128.1',
  'Work VPN':'10.12.0.2',
  'Office adapter':'10.12.0.3',
  '以太网':ADDRESS,
  'Wi-Fi 2':'192.168.123.8',
  'enp3s0':'192.168.123.9',
  'Fixture Ethernet':ADDRESS,
  'Virtual Ethernet':'172.18.128.2',
 };
 const networkInterfaces=()=>Object.fromEntries(Object.entries(candidates).map(([name,address])=>[name,[{address,family:'IPv4',internal:false}]]));
 const {manager,bindings}=fixture(t,{networkInterfaces});
 assert.deepEqual(manager.status().addresses.map(row=>row.name),[
  '以太网','Wi-Fi 2','enp3s0','Office adapter','vEthernet (WSL (Hyper-V firewall))','Work VPN','Virtual Ethernet',
 ]);
 assert.deepEqual(bindings,[]);
});

test('an explicitly selected virtual adapter can still be paired and restored',async t=>{
 const virtualAddress='172.18.128.1',virtualName='vEthernet (WSL)';
 const networkInterfaces=()=>({...interfaces(),[virtualName]:[{address:virtualAddress,family:'IPv4',internal:false}]});
 let saved=null;
 const preferenceStore={read:async()=>saved,write:async value=>{saved=value;}};
 const networkIdentity=async name=>{assert.equal(name,virtualName);return 'fixture-virtual-network';};
 const options={networkInterfaces,preferenceStore,networkIdentity};
 const first=fixture(t,options).manager;
 const enabled=await first.enable({address:virtualAddress,persistent:true,confirmed:true});
 assert.equal(enabled.address,virtualAddress);
 await first.close();

 const {manager,bindings}=fixture(t,options),restored=await manager.restore();
 assert.deepEqual(bindings,[virtualAddress]);
 assert.equal(restored.address,virtualAddress);
 assert.equal(restored.url,enabled.url);
 assert.equal(restored.addresses[0].address,ADDRESS);
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

const postJson=(endpoint,path,input,headers={})=>request(endpoint,{method:'POST',path,headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(input)});
const proofFor=(endpoint,nonce,prefix='codecang-lan-v1:')=>createHmac('sha256',bearer(endpoint).slice(7)).update(prefix+nonce).digest('hex');

test('auto binds all private addresses on one port and pairs only on the selected endpoint',async t=>{
 const {manager,bindings}=fixture(t);
 assert.deepEqual(manager.status().endpoints,[]);assert.equal(manager.status().mode,null);
 const state=await manager.enable({address:'auto'}),[first,second]=state.endpoints;
 assert.equal(state.mode,'auto');assert.equal(state.persistent,false);assert.deepEqual(bindings,[ADDRESS,SECOND]);
 assert.equal(state.url,first.url);assert.equal(state.address,first.address);
 assert.deepEqual(state.endpoints.map(row=>Object.keys(row).sort()),Array(2).fill(['address','family','origin','url']));
 assert.equal(new URL(first.url).port,new URL(second.url).port);assert.equal(bearer(first),bearer(second));
 assert.equal((await request(second,{path:'/api/status',headers:{Authorization:bearer(first)}})).status,200);
 assert.equal((await request(second,{headers:{Host:new URL(first.origin).host}})).status,403);
 assert.equal((await request(first,{headers:{Origin:second.origin}})).status,403);
 assert.throws(()=>manager.pairing({address:'10.0.0.99'}),{code:'LAN_ADDRESS_UNAVAILABLE'});
 assert.equal(new URL(manager.pairing().url).origin,first.origin);
 const issued=new URL(manager.pairing({address:SECOND}).url);
 assert.equal(issued.origin,second.origin);
 const ticket={ticket:issued.hash.slice(6)},path='/api/pairing/redeem';
 assert.equal((await postJson(first,path,ticket)).status,401);
 const redeemed=await postJson(second,path,ticket);assert.equal(redeemed.status,200);
 assert.equal(JSON.parse(redeemed.body).token,bearer(first).slice(7));
 assert.equal((await postJson(second,path,ticket)).status,401);
 const active=await Promise.all(state.endpoints.map(stream));
 const rotated=await manager.rotate();await promptly(Promise.all(active.map(s=>s.closed)));
 assert.notEqual(rotated.url,state.url);assert.equal(rotated.port,state.port);
 for(const endpoint of rotated.endpoints){
  assert.equal((await request(endpoint,{path:'/api/status',headers:{Authorization:bearer(first)}})).status,401);
  assert.equal((await request(endpoint,{path:'/api/status',headers:{Authorization:bearer(rotated)}})).status,200);
 }
 const closed=await manager.disable();assert.deepEqual(closed.endpoints,[]);assert.equal(closed.mode,null);
 for(const endpoint of rotated.endpoints)await assert.rejects(request(endpoint),{code:'ECONNREFUSED'});
});

test('a failure binding the second listener releases the first and leaves other listeners alone',async t=>{
 const occupied=fixture(t).manager;
 const used=await occupied.enable({address:SECOND});
 const {manager,servers}=fixture(t);
 await assert.rejects(manager.enable({address:'auto',port:used.port}),{code:'LAN_LISTEN_FAILED'});
 assert.equal(manager.status().enabled,false);assert.equal(servers.length,2);
 assert.ok(servers.every(server=>!server.listening));
 const first=await manager.enable({address:ADDRESS,port:used.port});
 assert.equal((await request(first)).status,200);assert.equal((await request(used)).status,200);
});

test('auto pins the original bindings and network identities across monitor checks',async t=>{
 t.mock.timers.enable({apis:['setInterval']});
 let rows=interfaces(),identity='original';
 const {manager,bindings}=fixture(t,{networkInterfaces:()=>rows,networkIdentity:async name=>name==='Fixture Ethernet'?identity:'wifi'});
 const state=await manager.enable({address:'auto'});
 rows={...rows,hotplug:[{address:'10.42.0.3',family:4,internal:false}]};
 const check=async()=>{t.mock.timers.tick(15000);return manager.restore();};
 assert.deepEqual((await check()).endpoints,state.endpoints);assert.deepEqual(bindings,[ADDRESS,SECOND]);
 const active=await Promise.all(state.endpoints.map(stream));
 identity='changed';
 const after=await check();assert.equal(after.enabled,false);assert.ok(after.restoreError);
 await promptly(Promise.all(active.map(s=>s.closed)));
 for(const endpoint of state.endpoints)await assert.rejects(request(endpoint),{code:'ECONNREFUSED'});
 rows=interfaces();
 await manager.enable({address:'auto'});delete rows['Fixture Ethernet'];
 assert.equal((await check()).enabled,false);
});

test('auto rejects unsafe persistence and unavailable identities before binding',async t=>{
 const writes=[];
 const {manager,bindings}=fixture(t,{preferenceStore:{read:async()=>null,write:async value=>writes.push(value)},networkIdentity:async()=>{throw new Error('fixture');}});
 await assert.rejects(manager.enable({address:'auto',persistent:true,confirmed:true}),{code:'LAN_PERSISTENCE_UNAVAILABLE'});
 await assert.rejects(manager.enable({address:'auto'}),{code:'LAN_NETWORK_UNVERIFIED'});
 assert.deepEqual(bindings,[]);assert.deepEqual(writes,[]);
 const f=fixture(t,{preferenceStore:{read:async()=>null,write:async value=>writes.push(value)},networkSnapshot:async names=>names});
 await f.manager.enable({address:'auto'});await f.manager.close();
 assert.ok(writes.every(value=>value===null));assert.equal((await f.manager.restore()).enabled,false);
});

test('LAN proof accepts an unauthenticated bounded nonce and follows the active token',async t=>{
 const {manager,calls}=fixture(t),state=await manager.enable({address:'auto'}),[first,second]=state.endpoints;
 const nonce='a1'.repeat(16),path='/api/pairing/prove';
 for(const endpoint of state.endpoints){
  const response=await postJson(endpoint,path,{nonce});
  assert.equal(response.status,200);assert.equal(response.headers['cache-control'],'no-store');
  assert.deepEqual(JSON.parse(response.body),{proof:proofFor(endpoint,nonce)});
 }
 assert.equal((await request(first,{path})).status,405);
 for(const invalid of [null,{},[nonce],{nonce:nonce.toUpperCase()},{nonce:nonce.slice(1)},{nonce,extra:1}])assert.equal((await postJson(first,path,invalid)).status,400);
 assert.equal((await postJson(first,path,{nonce:'a'.repeat(257)})).status,413);
 assert.equal((await postJson(second,path,{nonce},{Origin:first.origin})).status,403);
 assert.equal((await postJson(second,path,{nonce},{Host:new URL(first.origin).host})).status,403);
 assert.equal((await postJson(second,path+'?x=1',{nonce})).status,400);
 assert.equal(manager.verifyRelayProof(nonce,proofFor(first,nonce)),false);
 const next=await manager.rotate(),proof=JSON.parse((await postJson(second,path,{nonce})).body).proof;
 assert.notEqual(proof,proofFor(first,nonce));assert.equal(proof,proofFor(next,nonce));assert.deepEqual(calls,[]);
});

test('the connector shuts down once after revocation and before listeners release their port',async t=>{
 for(const event of ['disable','error','close']){
  let started,release,runs=0;
  const entered=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const {manager,servers}=fixture(t,{beforeListenerClose:()=>{runs++;started();return gate;}});
  const state=await manager.enable({address:'auto'});
  let closing;
  if(event==='disable')closing=manager.disable();
  else{
   if(event==='error')servers[0].emit('error',new Error('fixture'));
   else servers[0].close();
   closing=entered;
  }
  await entered;
  try{
   assert.equal(manager.status().enabled,false);assert.ok(servers[1].listening);
   if(event!=='close')assert.ok(servers[0].listening);
   assert.equal((await request(state.endpoints[1])).status,503);
  }finally{release();}
  await closing;await manager.close();
  assert.equal(runs,1);assert.ok(servers.every(server=>!server.listening));
 }
});

test('a connector shutdown failure retains the revoked endpoint until a successful retry',async t=>{
 let attempts=0;
 const {manager,servers}=fixture(t,{beforeListenerClose:async()=>{if(++attempts===1)throw new Error('connector still running');}});
 const state=await manager.enable({address:ADDRESS});
 await assert.rejects(manager.disable(),/connector still running/);
 assert.ok(servers[0].listening);assert.equal((await request(state)).status,503);
 await assert.rejects(manager.enable({address:ADDRESS}),{code:'LAN_ALREADY_ENABLED'});
 await assert.rejects(manager.rotate(),{code:'LAN_NOT_ENABLED'});
 await manager.disable();assert.equal(servers[0].listening,false);
 assert.equal(attempts,2);
});

test('tunnel proof is bound to the relay protocol, the public origin and the current session',async t=>{
 const {manager}=fixture(t,{tunnel:true});
 // Reserve and release an ephemeral loopback port to satisfy the tunnel's explicit-port contract.
 const reservation=http.createServer();
 await new Promise((resolve,reject)=>reservation.once('error',reject).listen(0,'127.0.0.1',resolve));
 const port=reservation.address().port;
 await new Promise(resolve=>reservation.close(resolve));
 const state=await manager.enable({publicOrigin:'https://relay.example.net',port});
 const nonce='4f'.repeat(16),path='/api/pairing/prove';
 const response=await postJson(state,path,{nonce});
 const {proof}=JSON.parse(response.body);
 assert.equal(response.status,200);assert.equal(response.headers['cache-control'],'no-store');
 assert.deepEqual(JSON.parse(response.body),{proof:proofFor(state,nonce,'codecang-relay-v1:')});
 assert.equal((await postJson(state,path,{nonce},{Host:'other.example.net'})).status,403);
 assert.equal(manager.verifyRelayProof(nonce,proof),true);
 assert.equal(manager.verifyRelayProof(nonce,proofFor(state,nonce)),false);
 assert.equal(manager.verifyRelayProof(nonce.toUpperCase(),proof),false);
 assert.equal(manager.verifyRelayProof(nonce,proof.slice(1)),false);
 await manager.rotate();assert.equal(manager.verifyRelayProof(nonce,proof),false);
 const rotated=JSON.parse((await postJson(state,path,{nonce})).body).proof;
 await manager.disable();assert.equal(manager.verifyRelayProof(nonce,rotated),false);
});
