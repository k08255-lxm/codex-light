// Every socket in this fixture listens on loopback. RFC1918 appears only in
// synthetic interface metadata and the required Host/Origin headers.
import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createServer} from '../src/server.mjs';
const address='192.168.74.19';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII=','base64');
const capability=state=>new URLSearchParams(new URL(state.url).hash.slice(1)).get('token');
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'lan-server-fixture-'));await fs.writeFile(path.join(root,'icon.png'),png);let listeners=0,pickers=0;
 const app=await createServer({demo:true,desktop:true,onDesktopPickFolder:()=>{pickers++;return root;},projectStore:{list:async()=>({projects:[{id:'p',path:root}],selectedId:'p'}),queue:Promise.resolve()},lanOptions:{networkInterfaces:()=>({Synthetic:[{address,family:'IPv4',internal:false}]}),serverFactory:handler=>{
  const server=http.createServer(handler),listen=server.listen.bind(server);server.listen=options=>{listeners++;assert.equal(options.host,address);return listen({...options,host:'127.0.0.1'});};return server;
 }}});
 await app.started;t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});return {app,root,get listeners(){return listeners;},get pickers(){return pickers;}};
}
async function owner(app,action,body={},token=app.token){const response=await fetch(app.origin+'/api/lan/'+action,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};}
function request(state,{pathname='/api/status',method='GET',token=capability(state),body,headers={}}={}){
 return new Promise((resolve,reject)=>{
  const wire=body===undefined?null:JSON.stringify(body),req=http.request({hostname:'127.0.0.1',agent:false,port:state.port,path:pathname,method,headers:{Host:new URL(state.origin).host,Origin:state.origin,...(token?{Authorization:'Bearer '+token}:{}),...(wire?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(wire)}:{}),...headers}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(chunks)}));res.on('error',reject);});req.on('error',reject);req.end(wire);
 });
}
async function sse(state){
 return new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port:state.port,path:'/api/events',headers:{Host:new URL(state.origin).host,Authorization:'Bearer '+capability(state)}},res=>{
   res.on('error',()=>{});let closed;const closedPromise=new Promise(r=>{closed=r;});res.on('close',closed);
   res.once('data',()=>resolve({res,closed:closedPromise}));
  });req.on('error',reject);req.end();
 });
}
const bounded=promise=>{let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Loopback connection was not revoked')),2000);})]).finally(()=>clearTimeout(timer));};

test('LAN is default-off; only owner token manages it and loopback/phone use the same application handler',async t=>{
 const f=await fixture(t),{app}=f;assert.equal(f.listeners,0);
 let result=await owner(app,'status');assert.equal(result.status,200);assert.equal(result.body.enabled,false);assert.equal(result.body.url,null);assert.equal(result.body.addresses[0].address,address);
 assert.equal((await owner(app,'enable',{address},'invalid')).status,401);assert.equal(f.listeners,0);
 result=await owner(app,'enable',{address});assert.equal(result.status,200);const lan=result.body;assert.equal(f.listeners,1);assert.notEqual(capability(lan),app.token);assert.equal(lan.encrypted,false);
 assert.equal((await owner(app,'status',{},capability(lan))).status,401,'LAN capability cannot manage loopback service');
 const page=await request(lan,{pathname:'/',token:null});assert.equal(page.status,200);assert.match(page.bytes.toString(),/<html/);
 assert.equal((await request(lan,{pathname:'/ui/artifacts.js',token:null})).status,200);
 const head=await request(lan,{pathname:'/icon.svg',method:'HEAD',token:null});assert.equal(head.status,200);assert.equal(head.bytes.length,0);
 assert.equal((await request(lan,{token:null})).status,401);assert.equal((await request(lan,{token:app.token})).status,401);
 const mobile=JSON.parse((await request(lan)).bytes);assert.equal(mobile.access,'lan');assert.equal(mobile.desktop,false);assert.equal(mobile.serverInstance,app.operations.serverInstance);assert.equal(mobile.reopenAvailable,false);
 const local=await(await fetch(app.origin+'/api/status',{headers:{Authorization:'Bearer '+app.token}})).json();assert.equal(local.access,'local');assert.equal(local.desktop,true);
 const projects=JSON.parse((await request(lan,{pathname:'/api/projects'})).bytes);assert.equal(projects.canPickFolder,false);
 for(const pathname of ['/api/lan/status','/api/shutdown','/api/runtime/status','/api/desktop/pick-folder'])assert.equal((await request(lan,{pathname,method:'POST',body:{}})).status,403);
 assert.equal(f.pickers,0);assert.equal(app.rpc.connected,true);assert.equal(app.operations.entries.size,0,'LAN capability URLs must not enter operation receipts');
});

test('LAN artifact preview requires its own capability and accepts external image paths from a known scope',async t=>{
 const {app}=await fixture(t),lan=(await owner(app,'enable',{address})).body;
 const success=await request(lan,{pathname:'/api/artifacts/preview',method:'POST',body:{projectId:'p',path:'icon.png'}});assert.equal(success.status,200);assert.equal(success.headers['content-type'],'image/png');assert.deepEqual(success.bytes,png);
 assert.equal((await request(lan,{pathname:'/api/artifacts/preview',method:'POST',token:null,body:{projectId:'p',path:'icon.png'}})).status,401);
 const external=await fs.mkdtemp(path.join(os.tmpdir(),'lan-image-preview-'));t.after(()=>fs.rm(external,{recursive:true,force:true}));const image=path.join(external,'outside.png');await fs.writeFile(image,png);
 const preview=await request(lan,{pathname:'/api/artifacts/preview',method:'POST',body:{projectId:'p',path:image}});assert.equal(preview.status,200);assert.deepEqual(preview.bytes,png);
 assert.equal((await request(lan,{pathname:'/api/artifacts/preview',method:'POST',body:{projectId:'unknown',path:'icon.png'}})).status,403);
});

test('owner rotation revokes LAN SSE and old bearer, disable/close reclaim only the added listener',async t=>{
 const {app}=await fixture(t),first=(await owner(app,'enable',{address})).body,stream=await sse(first);
 const second=(await owner(app,'rotate')).body;await bounded(stream.closed);assert.equal(second.port,first.port);assert.notEqual(capability(second),capability(first));
 assert.equal((await request(second,{token:capability(first)})).status,401);assert.equal((await request(second)).status,200);
 const secondStream=await sse(second);assert.equal((await owner(app,'disable')).body.enabled,false);await bounded(secondStream.closed);
 await assert.rejects(request(second),e=>e.code==='ECONNREFUSED');assert.equal(app.rpc.connected,true,'disabling mobile access must not stop the engine');
 const third=(await owner(app,'enable',{address})).body;assert.notEqual(capability(third),capability(second));const thirdStream=await sse(third);await app.close();await bounded(thirdStream.closed);await assert.rejects(request(third),e=>e.code==='ECONNREFUSED');
});

test('QR redemption authenticates the real LAN application and preserves browser remote access',async t=>{
 const {app}=await fixture(t);const enabled=await owner(app,'enable',{address});const lan=enabled.body;
 const issued=await owner(app,'pairing');assert.equal(issued.status,200);const ticket=new URL(issued.body.url).hash.slice(6);
 const response=await request(lan,{pathname:'/api/pairing/redeem',method:'POST',token:null,body:{ticket}});assert.equal(response.status,200);
 const token=JSON.parse(response.bytes).token;assert.notEqual(token,app.token);
 const status=await request(lan,{token});assert.equal(status.status,200);assert.equal(JSON.parse(status.bytes).access,'lan');
 assert.equal((await request(lan,{pathname:'/ui/pairing.js',token:null})).status,200);
 assert.equal((await request(lan,{pathname:'/api/lan/pairing',method:'POST',token,body:{}})).status,403);
 assert.equal((await request(lan,{pathname:'/api/pairing/redeem',method:'POST',token:null,body:{ticket}})).status,401);
 await owner(app,'rotate');assert.equal((await request(lan,{token})).status,401);
});