import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import {validServerRequestId,serverRequestKey,findServerRequest,removeServerRequest,serverRequestThread} from './server-requests.mjs';

const appVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const failure = (message, code) => Object.assign(new Error(message), { code });
export class RpcClient extends EventEmitter {
  constructor({ command = process.env.CODEX_LIGHT_CODEX || 'codex', args = ['app-server', '--listen', 'stdio://', '-c', 'thread_unload_delay_secs=0'], cwd = process.cwd(), timeout = 60000, closeTimeout = 1500, spawnProcess = spawn } = {}) {
    super(); Object.assign(this, {command,args,cwd,timeout,closeTimeout,spawnProcess});
    this.pending = new Map(); this.requests = new Map(); this.sequence = 0; this.connected = false; this.closed = false; this.buffer = ''; this.lastError = null;
  }
  async start() {
    if (this.started) throw failure('Codex 连接不能重复启动', 'ALREADY_STARTED');
    this.started = true;
    try {
      if (/\.(cmd|bat)$/i.test(this.command)) throw failure('请选择 Codex 原生 .exe 路径，不要选择 .cmd/.bat 包装器。', 'INVALID_COMMAND');
      const child = this.child = this.spawnProcess(this.command, this.args, { cwd:this.cwd, windowsHide:true, shell:false, stdio:['pipe','pipe','pipe'] });
      child.stdout.setEncoding('utf8'); child.stdout.on('data', data => this.consume(data));
      child.stderr.setEncoding('utf8'); child.stderr.on('data', () => {}); // Never send raw stderr/config/credentials to UI or disk.
      child.on('error', error => this.fail(failure(`无法启动 Codex：${error.code || error.message}`, 'SPAWN_FAILED')));
      child.on('exit', (code,signal) => this.fail(failure(`Codex 连接已结束（${code ?? signal}）。请重启 GUI；不会自动重发任务。`, 'PROCESS_EXITED')));
      child.stdin.on('error', error => this.fail(error));
      const result = await this.call('initialize', { clientInfo:{name:'codex_light_local',title:'Codex Light (unofficial)',version:appVersion}, capabilities:{experimentalApi:true,requestAttestation:false,requiredHumanApproval:true} });
      this.write({method:'initialized',params:{}}); this.connected = true; this.version = result?.userAgent || null;
      this.emit('event',{method:'bridge/status',params:{connected:true}}); return result;
    } catch (error) { this.fail(error); await this.terminate(); throw error; }
  }
  write(message) {
    if (this.closed || !this.child?.stdin?.writable) throw failure('Codex 未连接', 'NOT_CONNECTED');
    if (this.child.stdin.writableLength > 1024 * 1024) throw failure('Codex 输入队列已满，此请求未发送', 'INPUT_BACKPRESSURE');
    this.child.stdin.write(JSON.stringify(message)+'\n');
  }
  call(method,params={},options={}) {
    if(Object.keys(options).some(key=>key!=='timeoutMs')||(options.timeoutMs!==undefined&&options.timeoutMs!==null)||(options.timeoutMs===null&&method!=='command/exec'))return Promise.reject(failure('不支持的内部请求时限','INVALID_TIMEOUT'));
    if(this.closed) return Promise.reject(failure('Codex 未连接', 'NOT_CONNECTED'));
    if(this.pending.size >= 256) return Promise.reject(failure('待处理请求过多，此请求未发送', 'TOO_MANY_REQUESTS'));
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=options.timeoutMs===null?null:setTimeout(()=>{this.pending.delete(id);reject(failure('请求超时，结果未知；请刷新状态，不要重复提交。','RPC_TIMEOUT'));},this.timeout);
      this.pending.set(id,{resolve,reject,timer});
      try{this.write({id,method,params});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}
    });
  }
  consume(data) {
    if(this.closed) return;
    this.buffer += data;
    if(this.buffer.length>32*1024*1024) {this.fail(failure('协议消息过大，连接已停止','MESSAGE_TOO_LARGE'));this.child?.kill();return;}
    let end;
    while((end=this.buffer.indexOf('\n'))>=0) {
      const line=this.buffer.slice(0,end);this.buffer=this.buffer.slice(end+1);if(!line.trim())continue;
      let msg;try{msg=JSON.parse(line);}catch{this.emit('event',{method:'bridge/warning',params:{message:'忽略了一条无效协议消息'}});continue;}
      if(!msg || typeof msg!=='object' || Array.isArray(msg))continue;
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
        if(msg.method==='turn/completed') {
          const threadId=msg.params?.threadId, turnId=msg.params?.turn?.id;
          for(const [id,req] of this.requests) if(threadId && serverRequestThread(req)===threadId && (req.params.turnId ? turnId && req.params.turnId===turnId : req.method!=='mcpServer/elicitation/request')) {
            this.requests.delete(id);
            this.emit('event',{method:'serverRequest/resolved',params:{requestId:req.id,threadId}});
          }
        }
        if(msg.method==='thread/closed'&&typeof msg.params?.threadId==='string'&&msg.params.threadId)for(const [key,request]of this.requests)if(serverRequestThread(request)===msg.params.threadId){this.requests.delete(key);this.emit('event',{method:'serverRequest/resolved',params:{requestId:request.id,threadId:msg.params.threadId}});}
        this.emit('event',msg);
      }
    }
  }
  respond(id,result,error) {
    const request=findServerRequest(this.requests,id);if(!request)throw failure('该审批已结束或不存在','STALE_APPROVAL');
    this.write(error?{id:request.id,error}:{id:request.id,result});removeServerRequest(this.requests,id);
    this.emit('event',{method:'serverRequest/resolved',params:{requestId:request.id,threadId:serverRequestThread(request)}});
  }
  fail(error) {
    if(this.closed)return;this.lastError=error.message;this.closed=true;this.connected=false;this.buffer='';
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
