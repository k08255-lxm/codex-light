import {createInterface} from 'node:readline';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {locations,installation} from './platform.mjs';
import {connectBridge} from './ipc.mjs';
import {applyModelDefaults} from './model-defaults.mjs';

export async function stdioProxy({desktop = false} = {}) {
  const state=locations().state;
    let socket,initializeId,queueVerified=false;
    try {socket=await connectBridge(state);}
    catch(error) {
      const {installation}=await import('./platform.mjs');
      if(!installation())throw error;
      if(existsSync(join(state,'paused')))throw new Error('DSH was stopped explicitly. Run dsh-subagent-mcp start to resume the service.');
      await (await import('./service.mjs')).startService();
      socket=await connectBridge(state);
    }
    socket.on('error',e=>{console.error('DSH subagent service unavailable: '+e.message);process.exitCode=1;process.stdin.destroy();});
    if(desktop || process.env.DSH_CODEX_CONNECTION) {
      const input=createInterface({input:process.stdin});
      input.on('line',line=>{
        try {
          let message=JSON.parse(line);
          if(desktop&&process.env.CODEX_LIGHT_DSH_BRIDGE==='1'){
            try {message=applyModelDefaults(message,locations().config);}
            catch(error){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32603,message:error.message}})+'\n');return;}
          }
          if(desktop&&process.env.DSH_CODEX_QUEUE&&message.method==='initialize')initializeId=message.id;
          if(desktop&&process.env.DSH_CODEX_QUEUE&&message.method==='tools/call'&&!queueVerified)throw Error('GUI callback service not verified');
          if(desktop && message.method==='initialize') message.params = {...message.params, _meta: {...message.params?._meta, dshClientProfile: process.env.DSH_CODEX_QUEUE?'desktop-queue':'desktop'}};
          if(!desktop && message.method==='tools/call')message.params._meta={...message.params._meta,dshConnection:process.env.DSH_CODEX_CONNECTION};
          if(desktop&&message.method==='tools/call'&&process.env.DSH_CODEX_QUEUE)message.params={...message.params,_meta:{...message.params?._meta,dshQueue:process.env.DSH_CODEX_QUEUE,dshConnection:undefined}};
          socket.write(JSON.stringify(message)+'\n');
        } catch {socket.destroy(new Error('Invalid MCP input'));}
      });
      input.once('close',()=>socket.end());
      socket.once('close',()=>input.close());
    } else process.stdin.pipe(socket);
    if(desktop&&process.env.DSH_CODEX_QUEUE){const replies=createInterface({input:socket});replies.on('line',line=>{try{const message=JSON.parse(line);if(message.id===initializeId){if(message.result?.capabilities?.experimental?.codecangCallbackQueue?.version!==1)throw Error('Installed DSH bridge must be restarted before GUI callbacks can be used');queueVerified=true;}process.stdout.write(JSON.stringify(message)+'\n');}catch{process.stderr.write('GUI callback bridge protocol mismatch. Restart the DSH bridge after its active tasks finish.\n');process.exitCode=1;socket.destroy();process.stdin.destroy();}});}else socket.pipe(process.stdout);
    socket.on('close',()=>process.stdin.destroy());
}
