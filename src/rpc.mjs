import { EventEmitter } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import {validServerRequestId,serverRequestKey,findServerRequest,removeServerRequest,serverRequestThread} from './server-requests.mjs';

const appVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const APP_SERVER_ARGS = Object.freeze(['app-server','--listen','stdio://','-c','features.step_model_switching=true','-c','thread_unload_delay_secs=0']);
const failure = (message, code) => Object.assign(new Error(message), { code });
function historyReply(parts, tail, pending) {
  let prefix='';
  for (const part of parts) {
    prefix+=part.slice(0,128-prefix.length);
    if (prefix.length===128) break;
  }
  prefix+=tail.slice(0,128-prefix.length);
  const id=/^\s*\{\s*(?:"jsonrpc"\s*:\s*"2\.0"\s*,\s*)?"id"\s*:\s*(\d+)\s*,\s*"result"\s*:/.exec(prefix)?.[1];
  const request=id && pending.get(Number(id));
  return request && ['thread/items/list','thread/turns/list','thread/read'].includes(request.method) ? request : null;
}
export class RpcClient extends EventEmitter {
  constructor({ command = process.env.CODEX_LIGHT_CODEX || 'codex', args = [...APP_SERVER_ARGS], cwd = process.cwd(), timeout = 60000, closeTimeout = 1500, spawnProcess = spawn, env, mapRequest, mapResponse } = {}) {
    super(); Object.assign(this, {command,args,cwd,timeout,closeTimeout,spawnProcess,env,mapRequest,mapResponse});
    this.pending = new Map(); this.requests = new Map(); this.sequence = 0; this.connected = false; this.closed = false; this.lineParts = []; this.lineLength = 0; this.lastError = null;
  }
  // Older engines may silently ignore unknown fork parameters. Check this executable's
  // protocol once before sending a mutation that could otherwise copy later turns.
  async supportsTurnFork(toEnginePath = value => value) {
    if (!this.forkSchema) this.forkSchema = this.readTurnForkSchema(toEnginePath).catch(error => {
      this.forkSchema = null;
      throw error;
    });
    return this.forkSchema;
  }
  async readTurnForkSchema(toEnginePath) {
    const index = this.args.lastIndexOf('app-server');
    if (index < 0) return false;
    const dir = await mkdtemp(path.join(os.tmpdir(), 'codecang-fork-schema-'));
    try {
      const args = [...this.args.slice(0,index),'app-server','generate-json-schema','--experimental','--out',await toEnginePath(dir)];
      await promisify(execFile)(this.command,args,{cwd:this.cwd,env:this.env,windowsHide:true,timeout:15000,maxBuffer:256*1024});
      const schema = JSON.parse(await readFile(path.join(dir,'v2','ThreadForkParams.json'),'utf8'));
      const type = schema.properties?.lastTurnId?.type;
      return type === 'string' || (Array.isArray(type) && type.includes('string'));
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw Object.assign(new Error('无法读取当前引擎的分支协议，请检查引擎后重试。'),{code:'FORK_SCHEMA_UNAVAILABLE',outcome:'notExecuted'});
    } finally {
      await rm(dir,{recursive:true,force:true,maxRetries:3});
    }
  }
  async start() {
    if (this.started) throw failure('Codex 连接不能重复启动', 'ALREADY_STARTED');
    this.started = true;
    try {
      if (/\.(cmd|bat)$/i.test(this.command)) throw failure('请选择 Codex 原生 .exe 路径，不要选择 .cmd/.bat 包装器。', 'INVALID_COMMAND');
      const child = this.child = this.spawnProcess(this.command, this.args, { cwd:this.cwd, ...(this.env?{env:this.env}:{}), windowsHide:true, shell:false, stdio:['pipe','pipe','pipe'] });
      child.stdout.setEncoding('utf8'); child.stdout.on('data', data => this.consume(data));
      child.stderr.setEncoding('utf8'); child.stderr.on('data', () => {}); // Never send raw stderr/config/credentials to UI or disk.
      child.on('error', error => this.fail(failure(`无法启动 Codex：${error.code || error.message}`, 'SPAWN_FAILED')));
      child.on('exit', (code,signal) => this.fail(failure(`Codex 连接已结束（${code ?? signal}）。请重启 GUI；不会自动重发任务。`, 'PROCESS_EXITED')));
      child.stdin.on('error', error => this.fail(error));
      const result = await this.call('initialize', { clientInfo:{name:'codex_light_local',title:'码舱 CodeCang (unofficial)',version:appVersion}, capabilities:{experimentalApi:true,requestAttestation:false,requiredHumanApproval:true} });
      this.write({method:'initialized',params:{}}); this.connected = true; this.version = result?.userAgent || null;
      this.codexHome = typeof result?.codexHome==='string'?result.codexHome:null;
      this.emit('event',{method:'bridge/status',params:{connected:true}}); return result;
    } catch (error) { this.fail(error); await this.terminate(); throw error; }
  }
  write(message) {
    if (this.closed || !this.child?.stdin?.writable) throw failure('Codex 未连接', 'NOT_CONNECTED');
    if (this.child.stdin.writableLength > 1024 * 1024) throw failure('Codex 输入队列已满，此请求未发送', 'INPUT_BACKPRESSURE');
    this.child.stdin.write(JSON.stringify(message)+'\n');
  }
  async call(method,params={},options={}) {
    if(Object.keys(options).some(key=>!['timeoutMs','beforeSend','signal'].includes(key))||(options.beforeSend!==undefined&&(method!=='turn/start'||typeof options.beforeSend!=='function'))||(options.signal!==undefined&&(method!=='thread/list'||!options.signal||typeof options.signal.addEventListener!=='function'||typeof options.signal.removeEventListener!=='function'))||(options.timeoutMs!==undefined&&options.timeoutMs!==null)||(options.timeoutMs===null&&method!=='command/exec'))return Promise.reject(failure('不支持的内部请求时限','INVALID_TIMEOUT'));
    if(this.closed) return Promise.reject(failure('Codex 未连接', 'NOT_CONNECTED'));
    if(this.pending.size >= 256) return Promise.reject(failure('待处理请求过多，此请求未发送', 'TOO_MANY_REQUESTS'));
    const aborted=()=>Object.assign(failure('对话搜索已取消','SEARCH_ABORTED'),{name:'AbortError'});
    if(options.signal?.aborted)throw aborted();
    if(this.mapRequest)params=await this.mapRequest(params,method);
    if(options.signal?.aborted)throw aborted();
    if(this.closed)return Promise.reject(failure('Codex disconnected while preparing the request','NOT_CONNECTED'));
    if(this.pending.size>=256)return Promise.reject(failure('Too many pending requests','TOO_MANY_REQUESTS'));
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      let timer;
      const cleanup=()=>{clearTimeout(timer);this.pending.delete(id);options.signal?.removeEventListener('abort',onAbort);};
      const succeed=value=>{cleanup();resolve(value);},fail=error=>{cleanup();reject(error);};
      // Codex has no negotiated cancellation method for thread/list. Drop the
      // bridge waiter/timer, ignore late replies, and never interrupt a turn.
      const onAbort=()=>fail(aborted());
      timer=options.timeoutMs===null?null:setTimeout(()=>fail(failure('请求超时，结果未知；请刷新状态，不要重复提交。','RPC_TIMEOUT')),this.timeout);
      this.pending.set(id,{method,resolve:succeed,reject:fail,timer});
      options.signal?.addEventListener('abort',onAbort,{once:true});
      if(options.signal?.aborted){onAbort();return;}
      try{options.beforeSend?.();this.write({id,method,params});}catch(e){fail(e);}
    });
  }
  consume(data) {
    if(this.closed) return;
    // Image-bearing replies can span thousands of pipe chunks. Scan each chunk once.
    for(let start=0;start<data.length;){
      const end=data.indexOf('\n',start);
      if(this.discardHistoryLine){
        if(end<0)return;
        this.discardHistoryLine=false;start=end+1;continue;
      }
      const part=data.slice(start,end<0?data.length:end);
      this.lineLength+=part.length;
      if(this.lineLength>32*1024*1024){
        const request=historyReply(this.lineParts,part,this.pending);
        if(!request){this.fail(failure('协议消息过大，连接已停止','MESSAGE_TOO_LARGE'));this.child?.kill();return;}
        this.lineParts=[];this.lineLength=0;
        request.reject(failure('这一页历史数据过大，请缩小读取范围。','HISTORY_PAGE_TOO_LARGE'));
        if(end<0){this.discardHistoryLine=true;return;}
        start=end+1;continue;
      }
      if(end<0){this.lineParts.push(part);return;}
      let line=part;
      if(this.lineParts.length){this.lineParts.push(part);line=this.lineParts.join('');this.lineParts=[];}
      this.lineLength=0;start=end+1;
      if(!line.trim())continue;
      let msg;try{msg=JSON.parse(line);}catch{this.emit('event',{method:'bridge/warning',params:{message:'忽略了一条无效协议消息'}});continue;}
      if(!msg || typeof msg!=='object' || Array.isArray(msg))continue;
      // Approval payloads are native engine data. Preserve their exact paths so
      // validated approval responses cannot accidentally grant a translated root.
      if(this.mapResponse&&!(msg.method&&msg.id!==undefined))msg=this.mapResponse(msg);
      if(msg.id!==undefined && !msg.method) {
        const p=this.pending.get(msg.id);if(!p)continue;clearTimeout(p.timer);this.pending.delete(msg.id);
        if(msg.error){const error=failure(msg.error.message || 'Codex RPC 错误',msg.error.code);p.reject(error);}else p.resolve(msg.result);
      }else if(typeof msg.method==='string'){
        if(msg.id!==undefined) {
          if(!validServerRequestId(msg.id)){this.fail(failure('Codex 请求标识无效，连接已停止','INVALID_SERVER_REQUEST'));this.child?.kill();return;}
          const previous=findServerRequest(this.requests,msg.id);
          if(previous){if(isDeepStrictEqual(previous,msg))continue;this.fail(failure('Codex 重复使用待处理请求标识，连接已停止','DUPLICATE_SERVER_REQUEST'));this.child?.kill();return;}
          if(this.requests.size>=256) { this.fail(failure('待处理授权请求过多，连接已停止','TOO_MANY_APPROVALS'));this.child?.kill();return; }
          this.requests.set(serverRequestKey(msg.id),msg);
        }
        if(msg.method==='serverRequest/resolved')removeServerRequest(this.requests,msg.params?.requestId);
        if(msg.method==='turn/completed'||msg.method==='turn/interrupted')this.settleTurnRequests(msg.params?.threadId,msg.params?.turn?.id||msg.params?.turnId,{unscoped:msg.method==='turn/completed'});
        if(msg.method==='thread/closed'&&typeof msg.params?.threadId==='string'&&msg.params.threadId)for(const [key,request]of this.requests)if(serverRequestThread(request)===msg.params.threadId){this.requests.delete(key);this.emit('event',{method:'serverRequest/resolved',params:{requestId:request.id,threadId:msg.params.threadId}});}
        this.emit('event',msg);
      }
    }
  }
  settleTurnRequests(threadId,turnId,{unscoped=false}={}){
    if(!threadId)return;
    for(const [key,req] of this.requests)if(serverRequestThread(req)===threadId &&
      (req.params?.turnId ? turnId&&req.params.turnId===turnId : unscoped&&req.method!=='mcpServer/elicitation/request')){
      this.requests.delete(key);this.emit('event',{method:'serverRequest/resolved',params:{requestId:req.id,threadId}});
    }
  }
  respond(id,result,error) {
    const request=findServerRequest(this.requests,id);if(!request)throw failure('该审批已结束或不存在','STALE_APPROVAL');
    this.write(error?{id:request.id,error}:{id:request.id,result});removeServerRequest(this.requests,id);
    this.emit('event',{method:'serverRequest/resolved',params:{requestId:request.id,threadId:serverRequestThread(request)}});
  }
  fail(error) {
    if(this.closed)return;this.lastError=error.message;this.closed=true;this.connected=false;this.lineParts=[];this.lineLength=0;
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();
    for(const request of this.requests.values())this.emit('event',{method:'serverRequest/resolved',params:{requestId:request.id,threadId:serverRequestThread(request)}});this.requests.clear();
    this.emit('event',{method:'bridge/status',params:{connected:false,error:error.message}});
  }
  terminate() {
    if(this.termination)return this.termination;
    const child=this.child;
    if(!child?.pid || child.exitCode!==null || child.signalCode) return Promise.resolve();
    this.termination=new Promise((resolve,reject)=>{
      let escalation,deadline;
      const done=()=>{clearTimeout(grace);clearTimeout(escalation);clearTimeout(deadline);resolve();};
      child.once('exit',done);
      const grace=setTimeout(()=>{
        child.kill();
        escalation=setTimeout(()=>{
          child.kill('SIGKILL');
          deadline=setTimeout(()=>{child.removeListener('exit',done);reject(failure('本应用的 Codex 进程尚未退出，无法确认会话已释放','CHILD_CLOSE_FAILED'));},this.closeTimeout);
        },this.closeTimeout);
      },this.closeTimeout);
      try { child.stdin.end(); } catch { child.kill(); }
    });
    return this.termination;
  }
  async close(){this.fail(failure('GUI 已关闭 Codex 连接','CLIENT_CLOSED'));await this.terminate();}
}
