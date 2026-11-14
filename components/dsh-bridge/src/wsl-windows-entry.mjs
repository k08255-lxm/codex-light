// WSL launches this Windows process over stdio. No listener, token export or firewall change.
import {createInterface} from 'node:readline';
import {readFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readQueueDescriptor} from './callback-queue.mjs';
import {parseWindowsLaunch,mapWindowsRequest,assertQueueCapability} from './wsl-windows-paths.mjs';
try {
 if(process.platform!=='win32'||process.argv.length!==3)throw Error('Windows interop entry only');
 const launch=parseWindowsLaunch(process.argv[2]);
 if(launch.queueDescriptor)readQueueDescriptor(launch.queueDescriptor);
 const root=fileURLToPath(new URL('../',import.meta.url));
 const record=JSON.parse(readFileSync(path.join(launch.config,'installation.json'),'utf8'));
 if(record.owner!=='codex-light'||path.resolve(record.root)!==path.resolve(root)||path.resolve(record.state)!==path.resolve(launch.state))throw Error('Windows bridge installation identity mismatch');
 // Do not use Linux account/configuration variables inherited through interop.
 for(const key of ['HOME','CODEX_HOME','DSH_HOME','DSH_CODEX_CONNECTION','OPENAI_API_KEY','DEEPSEEK_API_KEY','DEEPSEEK_BASE_URL','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME'])delete process.env[key];
 Object.assign(process.env,{DSH_SUBAGENT_CONFIG:launch.config,DSH_SUBAGENT_STATE:launch.state,DSH_SUBAGENT_DATA:launch.data,CODEX_LIGHT_DSH_BRIDGE:'1'});
 process.chdir(root);
 await import('node:sqlite');
 const {connectBridge}=await import('./ipc.mjs');
 let socket;
 try{socket=await connectBridge(launch.state);}catch(error){
  if(existsSync(path.join(launch.state,'paused')))throw Error('Windows DSH was explicitly stopped; resume it before reconnecting');
  await (await import('./service.mjs')).startService();socket=await connectBridge(launch.state);
 }
 const input=createInterface({input:process.stdin});
 let initializeId,queueReady=false;
 const output=createInterface({input:socket});
 output.on('line',line=>{
  try{const response=JSON.parse(line);if(initializeId!==undefined&&response.id===initializeId&&response.result){if(launch.queueDescriptor){try{assertQueueCapability(response.result);queueReady=true;}catch(error){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:response.id,error:{code:-32603,message:error.message}})+'\n');socket.end();return;}}response.result.instructions=(response.result.instructions||'')+' WSL to Windows DSH mode: DSH executes Windows tools and uses Windows provider settings. Pass the calling WSL cwd for Windows-drive projects only; Linux-native /home projects are unsupported. Results may contain Windows paths. '+(launch.queueDescriptor?'Register dsh_watch for completion through this GUI instance. Inspect callback status; retained results are available with dsh_wait if delivery fails.':'Automatic parent wakeup is unavailable; use dsh_wait and retain task IDs across disconnects.');process.stdout.write(JSON.stringify(response)+'\n');}else process.stdout.write(line+'\n');}catch{socket.destroy(Error('Invalid bridge output'));}
 });
 input.on('line',line=>{
  let message;
  try{
   message=JSON.parse(line);
   if(message.method==='initialize'){initializeId=message.id;message.params={...message.params,_meta:{...message.params?._meta,dshClientProfile:launch.queueDescriptor?'desktop-queue':'desktop'}};}
   if(message.method==='tools/call'){if(launch.queueDescriptor&&!queueReady)throw Error('Callback queue handshake has not completed');message.params={...message.params,_meta:{...message.params?._meta,dshQueue:launch.queueDescriptor}};}
   message=mapWindowsRequest(message,launch.distribution,{user:launch.user});
   socket.write(JSON.stringify(message)+'\n');
  }catch(error){
   if(message?.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32602,message:error.message}})+'\n');
   else socket.destroy(Error('Invalid MCP input'));
  }
 });
 input.once('close',()=>socket.end());
 socket.once('close',()=>{input.close();process.stdin.destroy();});
 socket.on('error',()=>{process.stderr.write('Windows DSH bridge disconnected; reconnect and use dsh_wait for existing task IDs.\n');process.exitCode=1;input.close();process.stdin.destroy();});

}catch(error){process.stderr.write('Windows DSH interop unavailable: '+error.message+'\n');process.exitCode=1;}
