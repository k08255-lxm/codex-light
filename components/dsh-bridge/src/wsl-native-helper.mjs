// Static Linux runtime discovery and explicit preparation. Never starts DSH or a model.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {ProviderSources} from './provider-sources.mjs';
import {modelSelection,readModelDefaults,saveModelDefaults} from './model-defaults.mjs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const fileIdentity=file=>{const s=fs.statSync(file);if(!s.isFile())fail('DSH_PATH_INVALID','Expected a regular Linux runtime file');return {size:s.size,mtimeMs:s.mtimeMs};};
const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8'));
export function nativeProviders({home,cli,env,stateRoot,selection,exists=fs.existsSync,Source=ProviderSources}){
 const explicit=env.DSH_NATIVE_PROVIDER_CONFIG;
 const files=explicit?[explicit]:['desktop','sdk'].map(p=>path.join(home,'profiles',p,'cordis.patch.yml')).filter(exists);
 const sources=new Source({configDir:path.join(stateRoot,'config'),stateDir:path.join(stateRoot,'state'),home,cli});
 const valid=[];
 for(const file of files){const row=sources.readSource({id:'native',path:file});if(!row.valid)fail('DSH_PROVIDER_INVALID','Linux provider source invalid; inspect it in DSH');if(Object.keys(row._providers||{}).length)valid.push({file,providers:row._providers,hash:row.hash});}
 if(valid.length>1)fail('DSH_PROVIDER_AMBIGUOUS','Multiple Linux provider sources; set DSH_NATIVE_PROVIDER_CONFIG explicitly');
 if(valid.length){const source=valid[0];let provider=env.DSH_DEFAULT_PROVIDER;if(!provider){const names=Object.keys(source.providers);provider=names.length===1?names[0]:selection?.provider;if(!provider)fail('DSH_PROVIDER_AMBIGUOUS','请在子代理默认模型设置中指定 Linux DSH 提供商。');}const entry=source.providers[provider];if(!entry)fail('DSH_PROVIDER_INVALID','Selected provider is absent in the Linux source');
  if(entry.apiKeyEnv&&!env[entry.apiKeyEnv])fail('DSH_CREDENTIAL_UNAVAILABLE','Linux provider credential environment variable is unavailable; configure it in the selected Linux login environment');
  const model=env.DSH_DEFAULT_MODEL||(entry.models?.length===1?entry.models[0].id:null)||((!selection?.provider||selection.provider===provider)&&selection?.model);if(!model)fail('DSH_MODEL_REQUIRED','请在子代理默认模型设置中指定 Linux DSH 模型。');return {providerSource:source.file,providerSourceHash:source.hash,defaultProvider:provider,defaultModel:model};
 }
 if(!env.DEEPSEEK_API_KEY)fail('DSH_CREDENTIAL_UNAVAILABLE','No usable Linux provider source or DEEPSEEK_API_KEY found; configure Linux DSH first');
 return {providerSource:null,defaultProvider:'deepseek-official',defaultModel:env.DSH_DEFAULT_MODEL||'deepseek-flash'};
}
export function verifyNativeProviderDependency(providers,requireFn){if(providers.providerSource){try{requireFn.resolve('@deepseek-ai/dsh-llm-pi-ai');}catch{fail('DSH_PROVIDER_DEPENDENCY_MISSING','Linux DSH custom providers require @deepseek-ai/dsh-llm-pi-ai; repair the Linux DSH installation first');}}}
export function nativeProbe({cli='',home=os.homedir(),env=process.env,platform=process.platform,node=process.execPath}={}){
 if(platform!=='linux')fail('DSH_NATIVE_LINUX_REQUIRED','Native DSH requires Linux');
 if(!cli){for(const dir of (env.PATH||'').split(path.delimiter)){const candidate=path.join(dir,'dsh');try{fs.accessSync(candidate,fs.constants.X_OK);cli=candidate;break;}catch{}}}
 if(!path.isAbsolute(cli)||/[\x00-\x1f\x7f]/.test(cli))fail('DSH_NOT_FOUND','No Linux DSH CLI found; provide its absolute path');
 cli=fs.realpathSync(cli);node=fs.realpathSync(node);
 const fd=fs.openSync(node,'r');const magic=Buffer.alloc(4);try{fs.readSync(fd,magic,0,4,0);}finally{fs.closeSync(fd);}if(magic.toString('hex')!=='7f454c46')fail('DSH_NATIVE_LINUX_REQUIRED','Node must be a Linux ELF binary');
 if(/\.(exe|cmd|bat)$/i.test(cli)||/^\/mnt\/[a-z]\//i.test(cli))fail('DSH_NATIVE_LINUX_REQUIRED','Windows DSH cannot be used as a Linux CLI');
 let packageRoot=path.dirname(cli),pkg;
 for(let i=0;i<8;i++){try{const p=readJson(path.join(packageRoot,'package.json'));if(p.name==='@deepseek-ai/dsh'){pkg=p;break;}}catch{}const next=path.dirname(packageRoot);if(next===packageRoot)break;packageRoot=next;}
 if(!pkg||!/^0\.2\.2(?:-|$)/.test(pkg.version))fail('DSH_RUNTIME_UNSUPPORTED','Requires Linux @deepseek-ai/dsh 0.2.2');
 const bin=typeof pkg.bin==='string'?pkg.bin:pkg.bin?.dsh;if(!bin||fs.realpathSync(path.resolve(packageRoot,bin))!==cli)fail('DSH_RUNTIME_UNSUPPORTED','DSH path is not the package CLI entry');
 const req=createRequire(path.join(packageRoot,'package.json'));
 for(const name of ['@deepseek-ai/dsh-base','@deepseek-ai/dsh-sdk-app','@deepseek-ai/dsh-agent-presets','@deepseek-ai/dsh-sdk-jsonrpc-server','@deepseek-ai/dsh-workspace','@deepseek-ai/dsh-tool-subagent/model-selection-settings'])req.resolve(name);
 const major=Number(process.versions.node.split('.')[0]);if(major<22)fail('DSH_RUNTIME_UNSUPPORTED','Linux Node 22 or newer with node:sqlite required');
 if(env.DSH_HOME&&(!path.isAbsolute(env.DSH_HOME)||/^\/mnt\/[a-z]\//i.test(env.DSH_HOME)))fail('DSH_PATH_INVALID','DSH_HOME must be a native Linux directory');
 const stateRoot=path.join(home,'.local/share/codecang/dsh-native');
 const selected=readModelDefaults(path.join(stateRoot,'config')).selection;
 const providers=nativeProviders({home:env.DSH_HOME||path.join(home,'.dsh'),cli,env,selection:selected,stateRoot});
 verifyNativeProviderDependency(providers,req);
 return {...providers,ok:true,root,node,executablePath:cli,version:pkg.version,identity:{cli:fileIdentity(cli),node:fileIdentity(node)},stateRoot,configDir:path.join(stateRoot,'config'),stateDir:path.join(stateRoot,'state'),dshHome:env.DSH_HOME||path.join(home,'.dsh')};
}
function ownedDirectory(dir){let parent=path.dirname(dir);while(parent!==path.dirname(parent)){if(fs.existsSync(parent)&&fs.lstatSync(parent).isSymbolicLink())fail('DSH_STATE_CONFLICT','Symlink ancestors are not accepted for bridge state');parent=path.dirname(parent);}if(fs.existsSync(dir)){const s=fs.lstatSync(dir);if(s.isSymbolicLink()||!s.isDirectory()||(typeof process.getuid==='function'&&s.uid!==process.getuid())||(s.mode&0o077))fail('DSH_STATE_CONFLICT','Bridge directory must be private and owned by this Linux user');}else fs.mkdirSync(dir,{recursive:true,mode:0o700});}
export function prepareNative(p,expected){
 for(const key of ['providerSource','providerSourceHash','defaultProvider','defaultModel'])if(p[key]!==expected?.[key])fail('DSH_CHANGED','Linux provider selection changed; probe again');
 if(JSON.stringify(p.identity)!==JSON.stringify(expected?.identity)||p.root!==expected.root||p.node!==expected.node||p.executablePath!==expected.executablePath)fail('DSH_CHANGED','Linux DSH changed after confirmation; probe again');
 for(const dir of [p.stateRoot,p.configDir,p.stateDir])ownedDirectory(dir);
 const file=path.join(p.configDir,'installation.json');
 if(fs.existsSync(file)){const old=readJson(file);if(fs.lstatSync(file).isSymbolicLink()||old.owner!=='codecang-wsl'||old.root!==p.root||old.dsh!==p.executablePath||old.node!==p.node||old.state!==p.stateDir)fail('DSH_STATE_CONFLICT','Another bridge owns this state');return;}
 const profile=path.join(p.dshHome,'profiles/codecang-wsl');
 if(fs.existsSync(profile)&&fs.readdirSync(profile).length){let owner;try{owner=readJson(path.join(profile,'package.json')).codecangWslProfile;}catch{}if(owner!==1)fail('DSH_PROFILE_CONFLICT','Existing Linux DSH profile preserved');}
 for(const dir of [p.stateRoot,p.configDir,p.stateDir,profile])ownedDirectory(dir);
 const writeNew=(name,value)=>{if(!fs.existsSync(name))fs.writeFileSync(name,value,{flag:'wx',mode:0o600});};
 writeNew(path.join(profile,'package.json'),JSON.stringify({name:'codecang-wsl-profile',private:true,codecangWslProfile:1,dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-sdk-app'],patchReload:'startup'}}},null,2));
 for(const name of ['cordis.yml','cordis.patch.yml'])writeNew(path.join(profile,name),'[]\n');
 const env={DSH_SUBAGENT_CONFIG:p.configDir,DSH_SUBAGENT_STATE:p.stateDir,DSH_SUBAGENT_DATA:p.stateRoot,DSH_HOME:p.dshHome,DSH_CLI:p.executablePath,DSH_BRIDGE_PROFILE:'codecang-wsl',CODEX_LIGHT_DSH_TARGET:'wsl',DSH_DESKTOP_EXECUTABLE:'',DSH_NATIVE_PROVIDER_CONFIG:p.providerSource||'',DSH_DEFAULT_PROVIDER:p.defaultProvider,DSH_DEFAULT_MODEL:p.defaultModel};
 writeNew(file,JSON.stringify({version:1,owner:'codecang-wsl',root:p.root,node:p.node,nodeArgs:[],backend:'background',dsh:p.executablePath,state:p.stateDir,env},null,2));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const action=process.argv[2];let result;
  if(action==='model-status'||action==='model-save'){
   const stateRoot=path.join(os.homedir(),'.local/share/codecang/dsh-native'),dir=path.join(stateRoot,'config');
   if(action==='model-save'){
    const selection=modelSelection(JSON.parse(process.argv[4]).selection);
    ownedDirectory(stateRoot);ownedDirectory(dir);result=saveModelDefaults(dir,selection);
   }else result=readModelDefaults(dir);
   result={ok:true,settings:result};
  }else{
   if(!['probe','prepare'].includes(action))fail('INVALID_INPUT','Invalid action');
   const sqlite=await import('node:sqlite');if(!sqlite.DatabaseSync)fail('DSH_RUNTIME_UNSUPPORTED','node:sqlite unavailable');
   result=nativeProbe({cli:process.argv[3]});if(action==='prepare')prepareNative(result,JSON.parse(process.argv[4]));
  }
  process.stdout.write(JSON.stringify(result)+'\n');
 }
 catch(error){process.stdout.write(JSON.stringify({ok:false,code:error.code||'DSH_RUNTIME_UNSUPPORTED',message:error.code?error.message:'Linux DSH runtime dependencies unavailable'})+'\n');process.exitCode=1;}
}
