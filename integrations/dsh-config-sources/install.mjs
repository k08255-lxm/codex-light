// Optional, explicit bridge integration; never invoked by Codex Light startup or installer.
import fs from 'node:fs';import path from 'node:path';import {parseArgs} from 'node:util';
import {createHash} from 'node:crypto';
import {discoverDshInstallation} from '../../src/dsh-config-sources.mjs';
const {values:flags}=parseArgs({options:{apply:{type:'boolean',default:false},config:{type:'string'}}});
const installation=discoverDshInstallation({env:{...process.env,...(flags.config?{CODEX_LIGHT_DSH_CONFIG:flags.config}:{})},requireAdapter:false});
const record=JSON.parse(fs.readFileSync(path.join(installation.configDir,'installation.json'),'utf8')),root=record.root;
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
if(pkg.name!=='dsh-subagent-mcp'||pkg.version!=='0.8.0')throw Error('This adapter targets dsh-subagent-mcp 0.8.0; no files changed');
const replace=(text,from,to)=>{if(text.split(from).length!==2)throw Error('Bridge source differs; no files changed');return text.replace(from,to);};
const targets=new Map(),endings=new Map();
const load=name=>{const text=fs.readFileSync(path.join(root,'src',name),'utf8');endings.set(name,text.includes('\r\n'));return text.replace(/\r\n/g,'\n');};
let config=load('config.mjs');
if(!config.includes("import {ProviderSources} from './provider-sources.mjs';")){
 config=replace(config,"import {providerOverlay} from './provider-config.mjs';","import {ProviderSources} from './provider-sources.mjs';");
 config=replace(config,"    const providers=providerOverlay(process.env.DSH_DESKTOP_PROVIDER_CONFIG);\n    writeFileSync(patch,presets+shared+providers,{mode:0o600});\n    writeFileSync(legacyPatch,presets+shared+providers,{mode:0o600});\n    return {database:join(state,'state.sqlite'),cli,patch,legacyPatch,","    // Provider files are read at each NEW runtime boundary, never hot-reloaded into live tasks.\n    const providerSources=new ProviderSources({configDir:locations().config,stateDir:state,home:process.env.DSH_HOME,sourcePath:process.env.DSH_DESKTOP_PROVIDER_CONFIG,cli});\n    writeFileSync(patch,presets+shared,{mode:0o600});\n    writeFileSync(legacyPatch,presets+shared,{mode:0o600});\n    return {database:join(state,'state.sqlite'),cli,patch,legacyPatch,providerSources,");
}
targets.set('config.mjs',config);
let manager=load('manager.mjs');
if(!manager.includes('this.config.providerSources?.prepare(this.config)')){
 manager=replace(manager,'  async ensureParent(a) {','  async ensureParent(a, runtimeConfig=this.config) {');
 manager=replace(manager,'const rt=new this.RuntimeClass({id:parent,cwd:a.cwd,preset:a.preset},this.config);','const rt=new this.RuntimeClass({id:parent,cwd:a.cwd,preset:a.preset},runtimeConfig);');
 manager=replace(manager,'    const parent=await this.ensureParent(a);\n    const rt=new this.RuntimeClass(a,this.config); this.live.set(a.id,rt);','    const runtimeConfig=this.config.providerSources?.prepare(this.config)??this.config;\n    const parent=await this.ensureParent(a,runtimeConfig);\n    const rt=new this.RuntimeClass(a,runtimeConfig); this.live.set(a.id,rt);');
 manager=replace(manager,'      current.workspace_id=identity.workspace_id;','      current.provider_config_revision=runtimeConfig.providerRevision??null;\n      current.workspace_id=identity.workspace_id;');
}
targets.set('manager.mjs',manager);
let server=load('server.mjs');
if(!server.includes('manager.config.providerSources?.markActive()'))server=replace(server,'try {manager=new Manager(runtimeConfig(state));} catch(error)', 'try {manager=new Manager(runtimeConfig(state));manager.config.providerSources?.markActive();} catch(error)');
targets.set('server.mjs',server);
targets.set('provider-sources.mjs',fs.readFileSync(new URL('../../src/dsh-provider-sources.mjs',import.meta.url),'utf8'));
for(const [name,text] of targets)if(endings.get(name))targets.set(name,text.replace(/\n/g,'\r\n'));
const manifest={version:1,bridgeVersion:pkg.version,files:Object.fromEntries([...targets].map(([name,text])=>[name,createHash('sha256').update(text).digest('hex')]))};
if(!flags.apply){console.log(JSON.stringify({mode:'check',target:root,adapterVersion:1,files:[...targets.keys(),'provider-sources-adapter.json'],restarted:false}));process.exit(0);}
const backupDir=fs.mkdtempSync(path.join(installation.stateDir,'source-adapter-backup-'));
for(const name of [...targets.keys(),'provider-sources-adapter.json']){const file=path.join(root,'src',name);if(fs.existsSync(file))fs.copyFileSync(file,path.join(backupDir,name));}
// Publish the capability marker last: incomplete installations never claim compatibility.
for(const [name,text] of targets)fs.writeFileSync(path.join(root,'src',name),text);
fs.writeFileSync(path.join(root,'src','provider-sources-adapter.json'),JSON.stringify(manifest,null,2));
console.log(JSON.stringify({adapterVersion:1,written:[...targets.keys(),'provider-sources-adapter.json'],backupDir,restarted:false,sourceFilesModified:false}));
