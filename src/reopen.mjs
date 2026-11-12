import net from 'node:net';
import {spawn} from 'node:child_process';
import {mkdtemp,chmod,rm,lstat} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';

export function validateReopenPayload(payload,{port,serverInstance}={}){
 const url=new URL(payload?.url);
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/'||url.search||!/^#token=[a-f0-9]{64}$/.test(url.hash))throw new Error('Invalid reopening address');
 if(port!==undefined&&Number(url.port)!==port)throw new Error('Reopening port mismatch');
 if(serverInstance!==undefined&&payload.serverInstance!==serverInstance)throw new Error('Reopening instance mismatch');
 return url.href;
}
export async function createReopener({url,serverInstance}){
 const payload={url,serverInstance};validateReopenPayload(payload);
 if(process.platform==='win32')return createWindows(payload);
 const dir=await mkdtemp(path.join(os.tmpdir(),'codex-light-ipc-'));await chmod(dir,0o700);
 const endpoint=path.join(dir,'reopen.sock');const clients=new Set();
 const server=net.createServer(socket=>{clients.add(socket);socket.on('error',()=>{});socket.on('close',()=>clients.delete(socket));socket.setTimeout(2000,()=>socket.destroy());socket.end(JSON.stringify(payload)+'\n');});
 try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(endpoint,resolve);});await chmod(endpoint,0o600);
 const info=await lstat(endpoint);if((info.mode&0o777)!==0o600||info.uid!==process.getuid())throw new Error('Private socket permissions not established');
 }catch(error){server.close();await rm(dir,{recursive:true,force:true});throw error;}
 let closing;return {endpoint,close(){return closing||=(async()=>{for(const c of clients)c.destroy();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});})();}};
}
async function createWindows(payload){
 const name='codex-light-'+randomBytes(24).toString('hex');
 const executable=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 const child=spawn(executable,['-NoLogo','-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./reopen-helper.ps1',import.meta.url))],{windowsHide:true,stdio:['pipe','pipe','pipe'],shell:false});
 child.stderr.resume();child.stdin.on('error',()=>{});
 try{await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('Private reopening helper startup timeout')),8000);let body='';
  const fail=()=>{clearTimeout(timer);reject(new Error('Private reopening helper unavailable'));};child.once('error',fail);child.once('exit',fail);
  child.stdout.on('data',chunk=>{body+=chunk;if(body.length>4096){fail();return;}if(body.includes('\n')){try{if(JSON.parse(body.trim()).ready!==true)throw 0;clearTimeout(timer);resolve();}catch{fail();}}});
  child.stdin.write(JSON.stringify({name,payload,parentPid:process.pid})+'\n');
 });}catch(error){child.kill();throw error;}
 // Helper watches the owning process; no persistent token or global service.
 let closing;return {endpoint:`\\\\.\\pipe\\${name}`,close(){return closing||=new Promise(resolve=>{if(child.exitCode!==null)return resolve();const timer=setTimeout(()=>{child.kill();resolve();},2500);child.once('exit',()=>{clearTimeout(timer);resolve();});child.stdin.end();child.kill();});}};
}
export async function requestReopen(record,{timeout=3000}={}){
 const endpoint=record?.reopenEndpoint;
 if(typeof endpoint!=='string'||(process.platform==='win32'?!/^\\\\\.\\pipe\\codex-light-[a-f0-9]{48}$/.test(endpoint):(!path.isAbsolute(endpoint)||path.basename(endpoint)!=='reopen.sock')))throw new Error('This instance has no supported private reopening endpoint');
 if(process.platform==='win32')return requestWindows(record,timeout);
 if(process.platform!=='win32'){
  const dir=await lstat(path.dirname(endpoint)),socket=await lstat(endpoint);
  if(!dir.isDirectory()||dir.isSymbolicLink()||(dir.mode&0o777)!==0o700||dir.uid!==process.getuid()||!socket.isSocket()||(socket.mode&0o777)!==0o600||socket.uid!==process.getuid())throw new Error('Reopening socket is not private');
 }
 return new Promise((resolve,reject)=>{
  const socket=net.connect(endpoint);let body='';socket.setTimeout(timeout,()=>socket.destroy(new Error('Reopening timed out')));socket.on('error',reject);
  socket.on('data',chunk=>{body+=chunk;if(body.length>8192){socket.destroy(new Error('Invalid reopening response'));return;}if(body.includes('\n')){try{resolve(validateReopenPayload(JSON.parse(body),record));socket.destroy();}catch(error){socket.destroy(error);}}});
  socket.on('end',()=>{try{resolve(validateReopenPayload(JSON.parse(body),record));}catch(error){reject(error);}});
 });
}

async function requestWindows(record,timeout){
 const executable=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 const child=spawn(executable,['-NoLogo','-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./reopen-helper.ps1',import.meta.url))],{windowsHide:true,stdio:['pipe','pipe','pipe'],shell:false});
 child.stderr.resume();child.stdin.on('error',()=>{});
 return new Promise((resolve,reject)=>{
  let body='',settled=false;
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);child.kill();error?reject(error):resolve(value);};
  const timer=setTimeout(()=>finish(new Error('Private reopening client timed out')),Math.max(timeout,7000));
  child.once('error',()=>finish(new Error('Private reopening client unavailable')));
  child.stdout.on('data',chunk=>{body+=chunk;if(body.length>8192)finish(new Error('Invalid private reopening response'));});
  child.once('exit',code=>{if(code!==0){finish(new Error('Private reopening peer verification failed'));return;}try{finish(null,validateReopenPayload(JSON.parse(body),record));}catch{finish(new Error('Invalid private reopening response'));}});
  child.stdin.end(JSON.stringify({mode:'client',name:record.reopenEndpoint.split('\\').at(-1)})+'\n');
 });
}
