// Private stdio protocol for the native desktop host. Never launch a browser.
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {createServer} from './server.mjs';
import {nativeCodex} from './runtime-path.mjs';
const args=process.argv.slice(2);
if(args.some(a=>a!=='--demo')) {process.stderr.write('Unsupported desktop backend argument.\n');process.exit(2);}
const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
let app,starting=false,stopping=false,pendingFolder;
const timer=setTimeout(()=>shutdown(),15000);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
function pickFolder(){
 if(stopping)throw new Error('桌面宿主正在关闭');
 if(pendingFolder)throw new Error('已有文件夹选择窗口等待处理');
 return new Promise((resolve,reject)=>{
  const requestId=randomUUID();
  // Keep the native dialog's identity until it closes: a normal late reply is
  // stale selection, not a broken host protocol. Do not queue a second dialog.
  const timeout=setTimeout(()=>{pendingFolder.expired=true;reject(new Error('文件夹选择已超时，请关闭选择窗口后重试'));},5*60*1000);
  pendingFolder={requestId,resolve,reject,timeout,expired:false};
  process.stdout.write(JSON.stringify({type:'pickFolder',requestId})+'\n');
 });
}
async function shutdown(){
 if(stopping)return;stopping=true;clearTimeout(timer);
 if(pendingFolder){const pending=pendingFolder;pendingFolder=undefined;clearTimeout(pending.timeout);pending.reject(new Error('桌面宿主已关闭文件夹选择'));}
 let exitCode=0;
 try{if(app)await app.close();}catch(error){exitCode=1;process.stderr.write(JSON.stringify({type:'shutdownError',code:/^[A-Z0-9_]+$/.test(error?.code)?error.code:'SHUTDOWN_FAILED'})+'\n');}finally{lines.close();process.exit(exitCode);}
}
lines.on('line',async line=>{
 // JSON escaping can expand a 4096-character native path to six bytes per character.
 if(line.length>32768)return shutdown();
 let message;try{message=JSON.parse(line);}catch{return shutdown();}
 if(exact(message,['action'])&&message.action==='shutdown')return shutdown();
 if(exact(message,['action','requestId','path'])&&message.action==='folderPicked'){
  if(!uuid(message.requestId)||!pendingFolder||message.requestId!==pendingFolder.requestId||!(message.path===null||(typeof message.path==='string'&&message.path.length>0&&message.path.length<=4096&&!message.path.includes('\0')&&isAbsolute(message.path))))return shutdown();
  const pending=pendingFolder;pendingFolder=undefined;clearTimeout(pending.timeout);if(!pending.expired)pending.resolve(message.path);return;
 }
 if(!exact(message,['action'])||message.action!=='start'||starting)return shutdown();
 starting=true;clearTimeout(timer);
 try{
  // The host assigns this process to its kill-on-close Job before sending start.
  app=await createServer({demo:args.includes('--demo'),reopen:false,desktop:true,onDesktopPickFolder:pickFolder,onDesktopTheme:(theme,visualStyle)=>{
   if(!['light','dark'].includes(theme)||(visualStyle!==undefined&&!['codex','claude'].includes(visualStyle)))throw new Error('无效原生主题');
   if(!stopping)process.stdout.write(JSON.stringify({type:'theme',theme,...(visualStyle===undefined?{}:{visualStyle})})+'\n');
  },cwd:'',command:args.includes('--demo')?'demo-unused':nativeCodex()});
  if(stopping){await app.close();return;}
  app.server.once('close',()=>shutdown());
  process.stdout.write(JSON.stringify({url:app.url,serverInstance:app.operations.serverInstance})+'\n');
 }catch(error){process.stderr.write(JSON.stringify({type:'startupError',name:/^[A-Za-z]+$/.test(error?.name)?error.name:'Error',code:/^[A-Z0-9_]+$/.test(error?.code)?error.code:null,syscall:/^[A-Za-z]+$/.test(error?.syscall)?error.syscall:null})+'\n');await shutdown();}
});
lines.on('close',()=>shutdown());
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>shutdown());
