import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ProviderSources} from './dsh-provider-sources.mjs';

const failure=(code,message,status=503)=>Object.assign(new Error(message),{code,status,outcome:'notExecuted'});
function fileJson(file){const stat=fs.statSync(file);if(!stat.isFile()||stat.size>128*1024)throw failure('DSH_INSTALLATION_INVALID','DSH 桥安装记录无效');return JSON.parse(fs.readFileSync(file,'utf8'));}
/** Read only the named bridge environment path, never credentials or arbitrary TOML values. */
export function discoverDshInstallation({env=process.env,home=os.homedir(),requireAdapter=true}={}){
 let configDir=env.CODEX_LIGHT_DSH_CONFIG||env.DSH_SUBAGENT_CONFIG;
 if(!configDir){const toml=path.join(env.CODEX_HOME||path.join(home,'.codex'),'config.toml');if(fs.existsSync(toml)){const stat=fs.statSync(toml);if(stat.size>1024*1024)throw failure('DSH_DISCOVERY_FAILED','Codex 配置过大，无法定位 DSH 桥');let selected=false;for(const line of fs.readFileSync(toml,'utf8').split(/\r?\n/)){if(/^\s*\[/.test(line))selected=/^\s*\[mcp_servers\.(?:dsh_subagent|"dsh_subagent")\.env\]\s*$/.test(line);if(!selected)continue;const match=/^\s*DSH_SUBAGENT_CONFIG\s*=\s*("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/.exec(line);if(match){try{configDir=JSON.parse(match[1]);}catch{throw failure('DSH_DISCOVERY_FAILED','DSH 桥路径配置无法读取');}break;}}}}
 configDir??=process.platform==='win32'?path.join(env.LOCALAPPDATA||path.join(home,'AppData','Local'),'dsh-subagent-mcp','config'):path.join(env.XDG_CONFIG_HOME||path.join(home,'.config'),'dsh-subagent-mcp');
 if(typeof configDir!=='string'||!path.isAbsolute(configDir)||/[\x00-\x1f\x7f]/.test(configDir))throw failure('DSH_DISCOVERY_FAILED','DSH 桥配置路径无效');
 const file=path.join(configDir,'installation.json');if(!fs.existsSync(file))throw failure('DSH_NOT_INSTALLED','未找到本机 DSH 桥安装记录');
 let installed;try{installed=fileJson(file);}catch{throw failure('DSH_INSTALLATION_INVALID','DSH 桥安装记录无效');}
 if(typeof installed.root!=='string'||!path.isAbsolute(installed.root)||!fs.existsSync(path.join(installed.root,'src','manager.mjs')))throw failure('DSH_BRIDGE_MISSING','DSH 桥程序不存在；普通 Codex 功能仍可使用');
 if(requireAdapter){let adapter;try{adapter=fileJson(path.join(installed.root,'src','provider-sources-adapter.json'));}catch{throw failure('DSH_BRIDGE_UPGRADE_REQUIRED','DSH 桥尚未安装配置来源适配器；普通 Codex 功能仍可使用');}if(adapter.version!==1||!fs.existsSync(path.join(installed.root,'src','provider-sources.mjs')))throw failure('DSH_BRIDGE_UPGRADE_REQUIRED','DSH 桥配置来源适配器版本不兼容');}
 const stateDir=installed.state,sourcePath=installed.env?.DSH_DESKTOP_PROVIDER_CONFIG,dshHome=installed.env?.DSH_HOME||path.join(home,'.dsh');
 for(const value of [stateDir,dshHome,sourcePath])if(typeof value!=='string'||!path.isAbsolute(value)||/[\x00-\x1f\x7f]/.test(value))throw failure('DSH_INSTALLATION_INVALID','DSH 桥未配置可导入的桌面来源');
 return {configDir,stateDir,home:dshHome,sourcePath,cli:installed.dsh};
}
export class DshConfigSourcesService {
 constructor({discover=discoverDshInstallation,managerFactory=options=>new ProviderSources(options),demo=false}={}){this.discover=discover;this.managerFactory=managerFactory;this.demo=demo;this.queue=Promise.resolve();}
 manager(){if(this.demo)throw failure('DSH_DEMO_DISABLED','演示模式不读取或修改本机 DSH 配置');return this.managerFactory(this.discover());}
 status(input={}){if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)throw failure('INVALID_INPUT','配置来源状态参数无效',400);try{return this.manager().status();}catch(error){return {available:false,revision:null,autoFollow:null,selectedSourceIds:[],sources:[],effective:null,drift:false,error:{code:error.code||'DSH_UNAVAILABLE',message:error.code?error.message:'本机 DSH 配置来源无法读取'},activation:{state:'unavailable',restartRequired:false},policy:'new-runtime-only'};}}
 execute(action,input){if(!['register','configure','refresh'].includes(action))throw failure('INVALID_INPUT','未知配置来源操作',400);const run=this.queue.then(()=>this.manager()[action](input));this.queue=run.catch(()=>{});return run;}
}
