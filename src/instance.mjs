// Lock metadata contains no URL fragment, authorization token, prompt or credentials.
import {mkdir,open,readFile,lstat,unlink,rename} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
function livePid(pid){if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}}
export function probeInstance(record,{timeout=800}={}) {
 if(!Number.isInteger(record?.port)||record.port<1||record.port>65535||typeof record.serverInstance!=='string')return Promise.resolve(false);
 return new Promise(resolve=>{
  const req=http.get({hostname:'127.0.0.1',port:record.port,path:'/health',timeout,headers:{Host:`127.0.0.1:${record.port}`}},res=>{
   let body='';res.on('data',chunk=>{body+=chunk;if(body.length>4096)req.destroy();});
   res.on('end',()=>{try{const result=JSON.parse(body);resolve(res.statusCode===200&&result.app==='codex-light'&&result.serverInstance===record.serverInstance&&result.pid===record.pid);}catch{resolve(false);}});
  });req.on('timeout',()=>req.destroy());req.on('error',()=>resolve(false));
 });
}
export async function acquireInstance({demo=false,directory,probe=probeInstance,isAlive=livePid}={}){
 const userHash=createHash('sha256').update(os.homedir()).digest('hex').slice(0,16);
 const dir=directory||path.join(os.tmpdir(),`codex-light-${userHash}`);
 await mkdir(dir,{recursive:true,mode:0o700});
 const dirInfo=await lstat(dir);if(!dirInfo.isDirectory()||dirInfo.isSymbolicLink())throw new Error('实例目录异常，未启动。请检查本机临时目录。');
 if(typeof process.getuid==='function'&&dirInfo.uid!==process.getuid())throw new Error('实例目录不属于当前用户，未启动。');
 const file=path.join(dir,demo?'demo-instance.json':'instance.json');
 const nonce=randomBytes(16).toString('hex');let record={version:1,nonce,pid:process.pid,phase:'starting',createdAt:Date.now()};
 for(let attempt=0;attempt<2;attempt++){
  try{const handle=await open(file,'wx',0o600);await handle.writeFile(JSON.stringify(record));await handle.close();break;}
  catch(error){
   if(error.code!=='EEXIST')throw error;
   const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>4096)throw new Error('实例记录异常，未启动；不会覆盖现有文件。');
   let previous;try{previous=JSON.parse(await readFile(file,'utf8'));}catch{throw new Error('实例记录损坏，未启动；请检查本机临时目录。');}
   const active=await probe(previous);
   if(active || isAlive(previous.pid))return {active:true,record:previous,file};
   // This is our nonsecret dead-process marker, not user project data.
   await unlink(file);if(attempt===1)throw new Error('另一个启动器正在运行，请稍后重试。');
  }
 }
 async function owns(){try{const value=JSON.parse(await readFile(file,'utf8'));return value.nonce===nonce;}catch{return false;}}
 return {
  active:false,file,
  async publish({pid,port,serverInstance,reopenEndpoint}){
   if(!await owns())throw new Error('实例锁已变化；未覆盖其他实例记录。');
   record={...record,pid,port,serverInstance,reopenEndpoint,phase:'ready'};
   const temp=`${file}.${nonce}.tmp`;const handle=await open(temp,'wx',0o600);await handle.writeFile(JSON.stringify(record));await handle.close();await rename(temp,file);
  },
  async release(){if(await owns())await unlink(file);}
 };
}
