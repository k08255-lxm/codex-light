import {stat} from 'node:fs/promises';
import {isAbsoluteWorkingDirectory} from './security.mjs';

const MAX_FIELD_LENGTH=512;
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const bounded=value=>typeof value==='string'&&value.length>0&&value.length<=MAX_FIELD_LENGTH?value:null;
const disconnected=()=>Object.assign(new Error('Codex 尚未连接，无法读取配置默认值'),{code:'NOT_CONNECTED',status:503});

// Only the three bounded defaults leave this module; raw config, origins and layers never do.
export function projectSessionDefaults(response){
 const config=response?.config;
 if(!plain(config))throw Object.assign(new Error('Codex 配置响应格式无法识别'),{code:'CONFIG_INVALID_RESPONSE'});
 return {model:bounded(config.model),modelProvider:bounded(config.model_provider),reasoningEffort:bounded(config.model_reasoning_effort)};
}

export async function validateSessionDirectory(cwd){
 let info;try{info=await stat(cwd);}catch{throw new TypeError('工作目录不存在或不是文件夹');}
 if(!info.isDirectory())throw new TypeError('工作目录不存在或不是文件夹');
 return cwd;
}

export class SessionDefaultsService{
 constructor({rpc,demo=false,validateDirectory=validateSessionDirectory}={}){
  if(!rpc||typeof rpc.call!=='function')throw new TypeError('rpc.call required');
  this.rpc=rpc;this.demo=demo;this.validateDirectory=validateDirectory;
 }
 async read(input){
  if(!plain(input))throw new TypeError('默认配置参数必须是普通对象');
  for(const key of Object.keys(input))if(key!=='cwd')throw new TypeError(`不支持参数 ${key}`);
  const cwd=Object.hasOwn(input,'cwd')?input.cwd:undefined;
  if(cwd!==undefined){
   if(typeof cwd!=='string'||!cwd||cwd.length>8192||/[\0\r\n]/.test(cwd))throw new TypeError('工作目录必须是非空绝对路径');
   if(!isAbsoluteWorkingDirectory(cwd))throw new TypeError('工作目录必须为本机绝对路径');
  }
  if(this.demo)throw new Error('演示模式不读取真实配置默认值');
  if(!this.rpc.connected)throw disconnected();
  if(cwd)await this.validateDirectory(cwd);
  if(!this.rpc.connected)throw disconnected();
  // Read-only: includeLayers is always false so no layer or origin data is requested.
  const response=await this.rpc.call('config/read',{includeLayers:false,...(cwd?{cwd}:{})});
  return projectSessionDefaults(response);
 }
}
