import path from 'node:path';
import {BundledDshBridge} from './dsh-connection.mjs';
const fail=(message,code='DSH_WSL_WINDOWS_UNAVAILABLE')=>Object.assign(new Error(message),{code,status:400,outcome:'notExecuted'});
export const INTEROP_SCRIPT='export ELECTRON_RUN_AS_NODE=1; WSLENV=ELECTRON_RUN_AS_NODE; export WSLENV; exec "$@"';
export class WslWindowsDshBridge {
 constructor({candidate,wsl,queueDescriptor,bundle=new BundledDshBridge()}={}) {Object.assign(this,{candidate,wsl,bundle,queueDescriptor});this.mode='windows';this.root=bundle.root;}
 bundled(){return this.bundle.bundled();}
 modelStatus(){return this.bundle.modelStatus();}
 saveModel(value){return this.bundle.saveModel(value);}
 detect(){return {...this.bundle.detect(),mode:this.mode,workspaceSupport:'windows-drives-only',completionMode:this.queueDescriptor?'local-queue':'dsh_wait',automaticWakeup:!!this.queueDescriptor};}
 async probe(value){
  const bundled=this.bundle.bundled();if(!bundled.available||!bundled.dependenciesReady)throw fail('Bundled bridge verification failed','DSH_COMPONENT_UNAVAILABLE');
  const c=this.candidate;if(!c?.distribution||!c?.user)throw fail('Select a WSL distribution first');
  const probe=this.bundle.probe(value),linuxExecutable=await this.wsl.toLinux(probe.executablePath,c);
  const args=['--distribution',c.distribution,'--user',c.user,'--cd',c.home,'--exec','/bin/sh','-c',INTEROP_SCRIPT,'codecang-dsh-interop',linuxExecutable,'--expose-internals',path.join(this.root,'src','probe-desktop.cjs')];
  let info;try{info=JSON.parse(String(await this.wsl.invoke(args)).trim());}catch{throw fail('Windows DSH cannot run through WSL interop. Enable interop yourself or choose DSH inside WSL.');}
  if(info?.name!=='@deepseek-ai/dsh-desktop-host'||info.version!==probe.version||info.sqlite!==true)throw fail('WSL interop DSH identity did not match the Windows installation');
  return {...probe,linuxExecutable,distribution:c.distribution,user:c.user,mode:this.mode};
 }
 prepare(probe){const bundled=this.bundle.bundled();if(!bundled.available||!bundled.dependenciesReady)throw fail('Bundled bridge verification failed','DSH_COMPONENT_UNAVAILABLE');return this.bundle.prepare(probe);}
 registration(executablePath,probe){
  if(typeof probe!=='object'||probe.distribution!==this.candidate.distribution||probe.user!==this.candidate.user||!probe.linuxExecutable)throw fail('Recheck the selected WSL distribution');
  const native=this.bundle.registration(probe.executablePath);
  const payload=Buffer.from(JSON.stringify({distribution:probe.distribution,user:probe.user,...(this.queueDescriptor?{queueDescriptor:this.queueDescriptor}:{}),config:native.env.DSH_SUBAGENT_CONFIG,state:native.env.DSH_SUBAGENT_STATE,data:native.env.DSH_SUBAGENT_DATA})).toString('base64url');
  return {command:'/bin/sh',args:['-c',INTEROP_SCRIPT,'codecang-dsh-interop',probe.linuxExecutable,'--expose-internals',path.join(this.root,'src','wsl-windows-entry.mjs'),payload],env:{CODEX_LIGHT_DSH_BRIDGE:'1',CODEX_LIGHT_DSH_MODE:'windows',CODEX_LIGHT_DSH_DISTRIBUTION:probe.distribution},startup_timeout_sec:30,tool_timeout_sec:3600,enabled:true};
 }
 owns(value){return value?.command==='/bin/sh'&&Array.isArray(value.args)&&value.args[1]===INTEROP_SCRIPT&&value.args.includes(path.join(this.root,'src','wsl-windows-entry.mjs'))&&value.env?.CODEX_LIGHT_DSH_MODE==='windows'&&value.env?.CODEX_LIGHT_DSH_DISTRIBUTION===this.candidate.distribution;}
}
