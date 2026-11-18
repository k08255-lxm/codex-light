import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {BundledDshBridge} from './dsh-connection.mjs';
import {validateWslSelection} from './wsl-runtime.mjs';
const fail=(message,code='DSH_WSL_UNAVAILABLE')=>Object.assign(new Error(message),{code,status:400,outcome:'notExecuted'});
const linuxPath=p=>typeof p==='string'&&p.startsWith('/')&&!p.startsWith('//')&&!/[\x00-\x1f\x7f]/.test(p)&&p.length<4096;
const DISCOVER=`if [ -n "$1" ]; then PATH="$1:$PATH"; export PATH; fi
shift
n=$(command -v node 2>/dev/null || true)
if [ -z "$n" ]; then exit 3; fi
n=$(readlink -f -- "$n")
magic=$(head -c 4 -- "$n" | od -An -tx1 | tr -d ' \\n')
[ "$magic" = 7f454c46 ] || exit 4
exec "$n" "$@"`;
/** No native process is started during construction; all WSL operations are explicit. */
export class WslNativeDshBridge {
 constructor({runtime,candidate,componentRoot=fileURLToPath(new URL('../components/dsh-bridge/',import.meta.url)),bundle,queueDescriptor}={}) {
  validateWslSelection({distribution:candidate?.distribution,user:candidate?.user});if(!runtime||!candidate?.user||!linuxPath(candidate.home))throw fail('Select a validated WSL user first');
  Object.assign(this,{runtime,candidate,root:componentRoot,bundle:bundle||new BundledDshBridge({componentRoot})});this.lastProbe=null;this.queueDescriptor=queueDescriptor;
 }
 capabilities(){return {mode:'native-wsl',transport:'stdio',sharedWorkspace:true,requires:'Linux Node with node:sqlite and DSH CLI 0.2.2 in the selected distribution',providerScope:'Linux user only; Windows provider credentials are never imported',verifiedOnWsl:false,completionMode:this.queueDescriptor?'gui-queue':'dsh_wait',automaticWakeup:!!this.queueDescriptor};}
 bundled(){return this.bundle.bundled();}
 async modelStatus(){return (await this.invoke('model-status')).settings;}
 async saveModel(selection){return (await this.invoke('model-save','',{selection})).settings;}
 async invoke(action,executablePath='',expected=null){
  if(executablePath&&!linuxPath(executablePath))throw fail('DSH CLI must be an absolute Linux path','DSH_PATH_INVALID');
  const root=await this.runtime.toLinux(this.root,this.candidate);
  const helper=path.posix.join(root,'src/wsl-native-helper.mjs');
  const bundled=await this.bundled();if(!bundled.available||!bundled.dependenciesReady)throw fail('Bundled DSH verification failed','DSH_COMPONENT_UNAVAILABLE');
  // WslRuntime strips host-origin credentials before invoking WSL. Do not unset
  // variables inside Linux: that would erase the selected user's own environment.
  const args=['--distribution',this.candidate.distribution,'--user',this.candidate.user,'--cd',this.candidate.home,'--exec','/bin/sh','-lc',DISCOVER,'codecang-dsh',this.candidate.nodeDirectory||'',helper,action,executablePath,expected?JSON.stringify(expected):''];
  let output;try{output=await this.runtime.invoke(args);}catch(error){if(typeof error.stdout==='string'&&error.stdout.length<128*1024)output=error.stdout;else throw fail('Cannot probe Linux Node/DSH in the selected WSL distribution');}
  let result;try{result=JSON.parse(String(output).trim());}catch{throw fail('Cannot probe Linux Node/DSH in the selected WSL distribution');}
  if(!result.ok)throw fail(result.message||'Linux DSH unavailable',result.code);
  return result;
 }
 async detect(){try{const p=await this.probe('');return {installed:true,executablePath:p.executablePath,target:'wsl'};}catch(error){return {installed:false,executablePath:null,target:'wsl',diagnostic:{code:error.code||'DSH_WSL_UNAVAILABLE',message:error.message||'Linux DSH unavailable'}};}}
 async probe(executablePath){const p=await this.invoke('probe',executablePath||'');if(this.queueDescriptor)p.queueDescriptor=await this.runtime.toLinux(this.queueDescriptor,this.candidate);this.lastProbe=p;return p;}
 async prepare(probe){this.lastProbe=await this.invoke('prepare',probe.executablePath,probe);}
 registration(executablePath,probe){const p=probe||this.lastProbe;if(!p||p.executablePath!==executablePath)throw fail('Probe Linux DSH before registration');return {command:p.node,args:[path.posix.join(p.root,'src/light-entry.mjs'),'mcp','--desktop'],env:{CODEX_LIGHT_DSH_BRIDGE:'1',CODEX_LIGHT_DSH_TARGET:'wsl',DSH_SUBAGENT_CONFIG:p.configDir,DSH_SUBAGENT_STATE:p.stateDir,DSH_SUBAGENT_DATA:p.stateRoot,DSH_HOME:p.dshHome,DSH_CLI:p.executablePath,DSH_BRIDGE_PROFILE:'codecang-wsl',DSH_DESKTOP_EXECUTABLE:'',DSH_NATIVE_PROVIDER_CONFIG:p.providerSource||'',DSH_DEFAULT_PROVIDER:p.defaultProvider,DSH_DEFAULT_MODEL:p.defaultModel,...(this.queueDescriptor?{DSH_CODEX_QUEUE:p.queueDescriptor}:{})},startup_timeout_sec:30,tool_timeout_sec:3600,enabled:true};}
 async owns(value){const root=await this.runtime.toLinux(this.root,this.candidate);return value?.env?.CODEX_LIGHT_DSH_TARGET==='wsl'&&value.env.CODEX_LIGHT_DSH_BRIDGE==='1'&&value.env.DSH_SUBAGENT_CONFIG===path.posix.join(this.candidate.home,'.local/share/codecang/dsh-native/config')&&Array.isArray(value.args)&&value.args[0]===path.posix.join(root,'src/light-entry.mjs');}
}
