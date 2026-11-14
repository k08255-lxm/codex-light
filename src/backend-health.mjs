import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from './server.mjs';

// Component health only: real HTTP/backend code, synthetic RPC, no account/model/DSH.
export async function checkBackendHealth(){
 const root=await mkdtemp(path.join(os.tmpdir(),'codex-light-health-'));
 let app;
 try{
  app=await createServer({demo:true,desktop:true,reopen:false,cwd:root,command:'health-no-codex',desktopStateRoot:path.join(root,'state'),projectsRoot:path.join(root,'projects'),fileAttachmentRoot:path.join(root,'attachments'),statisticsRoot:null});
  await app.started;
  const address=app.server.address();
  if(address.address!=='127.0.0.1'||app.lan.status().enabled)throw Error('HEALTH_LISTENER_INVALID');
  const endpoint=app.origin+'/api/status';
  const denied=await fetch(endpoint,{signal:AbortSignal.timeout(5000)});
  await denied.arrayBuffer();
  if(denied.status!==401)throw Error('HEALTH_AUTH_NOT_ENFORCED');
  const response=await fetch(endpoint,{headers:{Authorization:`Bearer ${app.token}`},signal:AbortSignal.timeout(5000)});
  const status=await response.json();
  if(response.status!==200||status.demo!==true||status.connected!==true||status.desktop!==true||status.pendingRequests.length||status.threadSessions.threads.length)throw Error('HEALTH_STATUS_INVALID');
  const version=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;
  await app.close();app=null;
  return {ok:true,scope:'isolated-demo-backend',version,nodeVersion:process.version,authenticatedStatus:true,unauthenticatedRejected:true,loopbackOnly:true,gracefulShutdown:true,realAccountVerified:false};
 }finally{
  if(app)await app.close();
  // Only the fresh directory created above, never any supplied user path.
  await rm(root,{recursive:true,force:true});
 }
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 // Exit only this disposable health process if a faulty packaged module hangs.
 const watchdog=setTimeout(()=>process.exit(2),25000);
 try{if(process.argv.length!==2)throw Error('HEALTH_ARGUMENTS_INVALID');console.log(JSON.stringify(await checkBackendHealth()));}
 catch{console.log(JSON.stringify({ok:false,scope:'isolated-demo-backend',code:'BACKEND_HEALTH_FAILED'}));process.exitCode=1;}
 finally{clearTimeout(watchdog);}
}
