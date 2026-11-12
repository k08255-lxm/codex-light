import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
const entry=fileURLToPath(new URL('../src/desktop-backend.mjs',import.meta.url));
function launch(t,{fastFolderTimeout=false}={}){
 // Child-only timer injection exercises the real stdio/HTTP timeout path without
 // a production switch or waiting five minutes. No application config changes.
 const preload=fastFolderTimeout?['--import','data:text/javascript,'+encodeURIComponent('const timer=globalThis.setTimeout;globalThis.setTimeout=(callback,ms,...args)=>timer(callback,ms===300000?200:ms,...args);')]:[];
 const p=spawn(process.execPath,[...preload,entry,'--demo'],{stdio:['pipe','pipe','pipe']});t.after(()=>p.kill());return p;
}
function ready(p){return new Promise((resolve,reject)=>{let b='';p.stdout.on('data',c=>{b+=c;if(b.includes('\n')){try{resolve(JSON.parse(b.split('\n')[0]));}catch(e){reject(e);}}});p.once('error',reject);p.once('exit',()=>reject(new Error('Exited before ready')));});}
function hostMessage(p){return new Promise((resolve,reject)=>{
 let buffer='';const timeout=setTimeout(()=>finish(new Error('Native host message timed out')),5000);
 const exited=()=>finish(new Error('Backend exited before native host message'));
 const data=chunk=>{buffer+=chunk;if(buffer.includes('\n')){try{finish(null,JSON.parse(buffer.split('\n')[0]));}catch(error){finish(error);}}};
 function finish(error,value){clearTimeout(timeout);p.stdout.off('data',data);p.off('exit',exited);error?reject(error):resolve(value);}
 p.stdout.on('data',data);p.once('exit',exited);
});}
const post=(url,route,value={})=>{const u=new URL(url);return fetch(u.origin+route,{method:'POST',headers:{Authorization:'Bearer '+u.hash.slice(7),'Content-Type':'application/json'},body:JSON.stringify(value)});};
test('desktop host handshake gates startup and exposes private URL only on stdout',async t=>{
 const p=launch(t);let bytes=0;p.stdout.on('data',c=>bytes+=c.length);await new Promise(r=>setTimeout(r,100));assert.equal(bytes,0);
 const started=ready(p);p.stdin.write('{"action":"start"}\n');const data=await started;const u=new URL(data.url);assert.equal(u.hostname,'127.0.0.1');assert.match(u.hash,/^#token=[a-f0-9]{64}$/);
 const status=await (await fetch(u.origin+'/api/status',{headers:{Authorization:'Bearer '+u.hash.slice(7)}})).json();assert.equal(status.demo,true);assert.equal(status.desktop,true);assert.equal(status.reopenAvailable,false);
 const exited=once(p,'exit');p.stdin.write('{"action":"shutdown"}\n');assert.equal((await exited)[0],0);await assert.rejects(fetch(u.origin+'/health'));
});
test('desktop parent pipe loss shuts down its service, no detached orphan',async t=>{
 const p=launch(t),started=ready(p);p.stdin.write('{"action":"start"}\n');const {url}=await started;const exited=once(p,'exit');p.stdin.end();assert.equal((await exited)[0],0);await assert.rejects(fetch(new URL(url).origin+'/health'));
});
test('desktop malformed host protocol exits without starting a service',async t=>{
 const p=launch(t);let output='';p.stdout.on('data',c=>output+=c);const exited=once(p,'exit');p.stdin.end('invalid\n');assert.equal((await exited)[0],0);assert.equal(output,'');
});
test('desktop theme follows handshake as enum-only private stdout message',async t=>{
 const p=launch(t),started=ready(p);p.stdin.write('{"action":"start"}\n');const {url}=await started;const u=new URL(url);
 const message=new Promise(resolve=>{let text='';p.stdout.on('data',chunk=>{text+=chunk;if(text.includes('\n'))resolve(JSON.parse(text.split('\n')[0]));});});
 const response=await fetch(u.origin+'/api/desktop/theme',{method:'POST',headers:{Authorization:'Bearer '+u.hash.slice(7),'Content-Type':'application/json'},body:'{"theme":"light"}'});
 assert.equal(response.status,200);assert.deepEqual(await message,{type:'theme',theme:'light'});
 const exited=once(p,'exit');p.stdin.end();assert.equal((await exited)[0],0);
});
test('desktop malformed or unsolicited folder replies stop the private backend',async t=>{
 for(const message of [{action:'start',extra:true},{action:'folderPicked',requestId:'ae47163c-0102-4321-8030-af0415418241',path:null}]){
  const p=launch(t);let output='';p.stdout.on('data',chunk=>output+=chunk);const exited=once(p,'exit');p.stdin.write(JSON.stringify(message)+'\n');assert.equal((await exited)[0],0);assert.equal(output,'');
 }
});
test('desktop folder selection returns a native path or cancellation without changing the project',async t=>{
 const p=launch(t),started=ready(p);p.stdin.write('{"action":"start"}\n');const {url}=await started;
 const u=new URL(url),headers={Authorization:'Bearer '+u.hash.slice(7)};
 const before=await (await fetch(u.origin+'/api/config',{headers})).json();
 for(const path of [process.cwd(),null]){
  const next=hostMessage(p),response=post(url,'/api/desktop/pick-folder');
  const request=await next;assert.deepEqual(Object.keys(request).sort(),['requestId','type']);assert.equal(request.type,'pickFolder');assert.match(request.requestId,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  p.stdin.write(JSON.stringify({action:'folderPicked',requestId:request.requestId,path})+'\n');
  const result=await response;assert.equal(result.status,200);assert.deepEqual(await result.json(),{path});
 }
 assert.deepEqual(await (await fetch(u.origin+'/api/config',{headers})).json(),before);
 const exited=once(p,'exit');p.stdin.write('{"action":"shutdown"}\n');assert.equal((await exited)[0],0);
});
test('desktop allows one native folder request and rejects it on shutdown',async t=>{
 const p=launch(t),started=ready(p);p.stdin.write('{"action":"start"}\n');const {url}=await started;
 const next=hostMessage(p),pending=post(url,'/api/desktop/pick-folder').catch(error=>error);await next;
 const duplicate=await post(url,'/api/desktop/pick-folder');assert.equal(duplicate.ok,false);assert.match((await duplicate.json()).error,/等待处理/);
 const exited=once(p,'exit');p.stdin.write('{"action":"shutdown"}\n');assert.equal((await exited)[0],0);
 const result=await pending;assert.ok(result instanceof Error||!result.ok);
});
test('desktop rejects invalid native folder replies instead of accepting a fabricated selection',async t=>{
 for(const invalid of [{path:'relative/folder'},{path:'C:\\'+'a'.repeat(4096)},{requestId:'invalid-uuid',path:null},{requestId:'ae47163c-0102-4321-8030-af0415418241',path:null},{path:null,extra:true}]){
  const p=launch(t),started=ready(p);p.stdin.write('{"action":"start"}\n');const {url}=await started;
  const next=hostMessage(p),pending=post(url,'/api/desktop/pick-folder').catch(error=>error);const request=await next;
  const exited=once(p,'exit');p.stdin.write(JSON.stringify({action:'folderPicked',requestId:request.requestId,...invalid})+'\n');assert.equal((await exited)[0],0);
  const response=await pending;assert.ok(response instanceof Error||!response.ok);
 }
});
test('desktop timed-out native selection ignores its late reply and keeps the backend available',async t=>{
 const p=launch(t,{fastFolderTimeout:true}),started=ready(p);p.stdin.write('{"action":"start"}\n');const {url}=await started;
 const next=hostMessage(p),pending=post(url,'/api/desktop/pick-folder');const request=await next;
 const timeout=await pending;assert.equal(timeout.ok,false);assert.match((await timeout.json()).error,/超时/);
 const duplicate=await post(url,'/api/desktop/pick-folder');assert.equal(duplicate.ok,false);assert.match((await duplicate.json()).error,/等待处理/);
 p.stdin.write(JSON.stringify({action:'folderPicked',requestId:request.requestId,path:process.cwd()})+'\n');
 // The late path must neither resolve a newer picker nor kill the local service.
 const health=await fetch(new URL(url).origin+'/health');assert.equal(health.status,200);
 const retryMessage=hostMessage(p),retry=post(url,'/api/desktop/pick-folder');const retryRequest=await retryMessage;assert.notEqual(retryRequest.requestId,request.requestId);
 p.stdin.write(JSON.stringify({action:'folderPicked',requestId:retryRequest.requestId,path:null})+'\n');
 assert.deepEqual(await (await retry).json(),{path:null});
 const exited=once(p,'exit');p.stdin.write('{"action":"shutdown"}\n');assert.equal((await exited)[0],0);
});
test('desktop theme supports the fixed visual-style enum',async t=>{
 const p=launch(t),started=ready(p);p.stdin.write('{"action":"start"}\n');const {url}=await started;
 const next=hostMessage(p);assert.equal((await post(url,'/api/desktop/theme',{theme:'light',visualStyle:'claude'})).status,200);assert.deepEqual(await next,{type:'theme',theme:'light',visualStyle:'claude'});
 assert.equal((await post(url,'/api/desktop/theme',{theme:'dark',visualStyle:'#ff0000'})).ok,false);
 const exited=once(p,'exit');p.stdin.end();assert.equal((await exited)[0],0);
});
