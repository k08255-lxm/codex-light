import path from 'node:path';
import {stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {isAbsoluteWorkingDirectory} from './security.mjs';
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
const only=(x,keys)=>{if(!object(x)||Object.keys(x).some(k=>!keys.includes(k)))throw new Error('终端参数无效');};
function size(x){only(x,['rows','cols']);for(const k of ['rows','cols'])if(!Number.isInteger(x[k])||x[k]<2||x[k]>500)throw new Error('终端大小须为 2–500');return {rows:x.rows,cols:x.cols};}
// Connection-local ownership only. No arbitrary executable, environment or sandbox override.
export class TerminalService extends EventEmitter {
 constructor(rpc,{platform=process.platform,windowsDirectory=process.env.SystemRoot||'C:\\Windows',validateCwd=async cwd=>{if(!(await stat(cwd)).isDirectory())throw new Error('工作目录不存在');},maxSessions=3}={}){super();Object.assign(this,{rpc,platform,windowsDirectory,validateCwd,maxSessions});this.sessions=new Map();this.closed=false;}
 async open(input){only(input,['cwd','size']);if(this.closed||!this.rpc.connected)throw new Error('Codex 未连接');if(!isAbsoluteWorkingDirectory(input.cwd,this.platform))throw new Error('需要明确本机绝对工作目录');const dimensions=size(input.size);if([...this.sessions.values()].filter(s=>['running','stopping'].includes(s.state)).length>=this.maxSessions)throw new Error('最多同时打开三个终端');await this.validateCwd(input.cwd);if(this.closed||!this.rpc.connected)throw new Error('终端服务已关闭或断线');if([...this.sessions.values()].filter(s=>['running','stopping'].includes(s.state)).length>=this.maxSessions)throw new Error('最多同时打开三个终端');while(this.sessions.size>=24){const oldest=[...this.sessions.values()].find(s=>!['running','stopping'].includes(s.state));if(!oldest)throw new Error('终端记录已满');this.sessions.delete(oldest.processId);}
 const processId=randomUUID();const session={processId,cwd:input.cwd,state:'running',sequence:0,output:[],outputBytes:0};this.sessions.set(processId,session);
 const command=this.platform==='win32'?[path.win32.join(this.windowsDirectory,'System32','WindowsPowerShell','v1.0','powershell.exe'),'-NoLogo','-NoProfile']:['/bin/sh'];
 // Preserve configured sandbox. A backend refusal is shown, never retried with higher permissions.
 const params={command,processId,tty:true,size:dimensions,cwd:input.cwd,disableTimeout:true,disableOutputCap:true};
 Promise.resolve().then(()=>this.rpc.call('command/exec',params,{timeoutMs:null})).then(result=>this.finish(session,'exited',{exitCode:result.exitCode}),error=>this.finish(session,'error',{error:error.message}));
 return {processId,cwd:input.cwd,state:session.state};
 }
 finish(session,state,extra={}){if(!['running','stopping'].includes(session.state))return;Object.assign(session,{state},extra);this.emit('event',{method:'bridge/terminalState',params:{processId:session.processId,state,...extra}});}
 observe(event){if(event.method!=='command/exec/outputDelta')return;const p=event.params,s=this.sessions.get(p?.processId);if(!s||s.outputRejected||!['running','stopping'].includes(s.state)||typeof p.deltaBase64!=='string')return;const bytes=Buffer.from(p.deltaBase64,'base64');if(bytes.length>1024*1024){s.outputRejected=true;s.state='stopping';s.error='终端输出消息超过限制，已请求终止；等待实际退出';this.emit('event',{method:'bridge/terminalState',params:{processId:s.processId,state:'stopping',error:s.error}});void this.rpc.call('command/exec/terminate',{processId:s.processId}).catch(()=>{s.error='终端输出超限且终止结果未知；连接结束前仍计为活动终端';this.emit('event',{method:'bridge/terminalState',params:{processId:s.processId,state:s.state,error:s.error}});});return;}const row={sequence:++s.sequence,deltaBase64:bytes.toString('base64'),stream:p.stream,capReached:p.capReached===true};s.output.push(row);s.outputBytes+=bytes.length;while(s.outputBytes>256*1024&&s.output.length){s.outputBytes-=Buffer.from(s.output.shift().deltaBase64,'base64').length;}this.emit('event',{method:'bridge/terminalOutput',params:{processId:s.processId,...row}});}
 owned(id,running=true){const s=this.sessions.get(id);if(!s||(running&&s.state!=='running'))throw new Error('终端不存在或已结束，不能写入');return s;}
 snapshot(input){only(input,['processId']);const s=this.owned(input.processId,false);return {...s,output:[...s.output]};}
 async write(input){only(input,['processId','text']);this.owned(input.processId);if(typeof input.text!=='string'||Buffer.byteLength(input.text)>16384)throw new Error('单次终端输入超过限制');await this.rpc.call('command/exec/write',{processId:input.processId,deltaBase64:Buffer.from(input.text).toString('base64')});return {};}
 async resize(input){only(input,['processId','size']);this.owned(input.processId);await this.rpc.call('command/exec/resize',{processId:input.processId,size:size(input.size)});return {};}
 async terminate(input){only(input,['processId']);const session=this.owned(input.processId);session.state='stopping';this.emit('event',{method:'bridge/terminalState',params:{processId:session.processId,state:'stopping'}});await this.rpc.call('command/exec/terminate',{processId:input.processId});return {};}
 disconnected(){for(const s of this.sessions.values())this.finish(s,'disconnected',{error:'连接已结束；不会自动重开或重发输入'});}
 async close(){this.closed=true;await Promise.allSettled([...this.sessions.values()].filter(s=>['running','stopping'].includes(s.state)).map(s=>this.rpc.call('command/exec/terminate',{processId:s.processId})));this.disconnected();this.sessions.clear();}
}
