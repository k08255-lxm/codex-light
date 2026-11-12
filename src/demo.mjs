import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
export class DemoClient extends EventEmitter {
 constructor(){super();this.connected=true;this.requests=new Map();this.threads=new Map();this.items=new Map();this.turns=new Map();this.timers=new Map();this.version='Demo · 无模型调用';this.modelTurns=[];}
 async start(){return {};}
 page(items,p={}){const offset=p.cursor?Number(p.cursor):0;if(!Number.isSafeInteger(offset)||offset<0)throw new Error('演示分页游标无效');const limit=p.limit||30;return {data:items.slice(offset,offset+limit),nextCursor:offset+limit<items.length?String(offset+limit):null};}
 async call(method,p){
  switch(method){
   case 'remoteControl/status/read':return {status:'disabled',serverName:'演示模式',installationId:'demo',environmentId:null};
   case 'remoteControl/enable':case 'remoteControl/disable':case 'remoteControl/pairing/start':case 'remoteControl/pairing/status':case 'remoteControl/client/list':case 'remoteControl/client/revoke':throw Object.assign(new Error('演示模式不连接官方远程服务，也不创建配对'),{code:-32601});
   case 'model/list':return {data:[{model:'demo',displayName:'演示模型（不调用 AI）',supportedReasoningEfforts:[{reasoningEffort:'high'}],defaultReasoningEffort:'high'},{model:'demo-five',displayName:'演示五档模型（不调用 AI）',supportedReasoningEfforts:['low','medium','high','xhigh','max'].map(reasoningEffort=>({reasoningEffort})),defaultReasoningEffort:'medium'},{model:'demo-six',displayName:'演示六档模型（不调用 AI）',supportedReasoningEfforts:['low','medium','high','xhigh','max','ultra'].map(reasoningEffort=>({reasoningEffort})),defaultReasoningEffort:'high'}],nextCursor:null};
   case 'mcpServerStatus/list':return {data:[{name:'dsh_subagent (demo)',authStatus:'unsupported',tools:{}}],nextCursor:null};
   case 'skills/list':return {data:[]};
   case 'thread/loaded/list':return {data:[...this.threads.keys()],nextCursor:null};
   case 'thread/unsubscribe':return {status:this.threads.has(p.threadId)?'unsubscribed':'notLoaded'};
   case 'thread/compact/start':throw Object.assign(new Error('演示模式不压缩真实上下文'),{code:-32601});
   case 'account/read':return {account:null,requiresOpenaiAuth:false};
   case 'account/rateLimits/read':return {rateLimits:null,rateLimitsByLimitId:null,ordinaryUsageAllowed:null};
   case 'thread/name/set':{const t=this.threads.get(p.threadId);if(!t)throw new Error('对话不存在');t.name=p.name;return {};}
   case 'thread/archive':case 'thread/unarchive':{const t=this.threads.get(p.threadId);if(!t)throw new Error('对话不存在');t.archived=method==='thread/archive';return method==='thread/unarchive'?{thread:t}:{};}
   case 'thread/fork':{const source=this.threads.get(p.threadId);if(!source)throw new Error('对话不存在');const thread={...source,id:randomUUID(),name:(source.name||'对话')+' · 分支',archived:false};this.threads.set(thread.id,thread);this.items.set(thread.id,structuredClone(this.items.get(source.id)||[]));this.turns.set(thread.id,structuredClone((this.turns.get(source.id)||[]).filter(t=>t.status!=='inProgress')));return {thread};}
   case 'thread/list':return this.page([...this.threads.values()].filter(t=>!!t.archived===!!p.archived).filter(t=>!p.searchTerm||(t.name||'').includes(p.searchTerm)).sort((a,b)=>b.updatedAt-a.updatedAt),p);
   case 'thread/start':{const thread={id:randomUUID(),cwd:p.cwd,model:p.model||'demo',reasoningEffort:null,name:'新对话',preview:'',updatedAt:Date.now()/1000};this.threads.set(thread.id,thread);this.items.set(thread.id,[]);this.turns.set(thread.id,[]);return {thread,model:thread.model,reasoningEffort:thread.reasoningEffort};}
   case 'thread/resume':case 'thread/read':{const thread=this.threads.get(p.threadId);if(!thread)throw new Error('对话不存在');return {thread:{...thread,turns:p.excludeTurns?[]:this.turns.get(p.threadId)},model:thread.model,reasoningEffort:thread.reasoningEffort};}
   case 'thread/turns/list':return this.page([...(this.turns.get(p.threadId)||[])].reverse(),p);
   case 'thread/items/list':{let items=[...(this.items.get(p.threadId)||[])];if(p.turnId)items=items.filter(e=>e.turnId===p.turnId);if(p.sortDirection!=='asc')items.reverse();return this.page(items,p);}
   case 'review/start':return this.call('turn/start',{threadId:p.threadId,input:[{type:'text',text:'演示：本地未提交改动审查，不运行真实模型'}]});
   case 'turn/start':{
    const thread=this.threads.get(p.threadId);if(!thread)throw new Error('对话不存在');
    if(this.turns.get(p.threadId).some(t=>t.status==='inProgress'))throw Object.assign(new Error('演示对话已有任务在运行'),{code:-32600});
    if(p.model)thread.model=p.model;if(typeof p.effort==='string')thread.reasoningEffort=p.effort;this.modelTurns.push({threadId:p.threadId,model:thread.model,effort:p.effort,effortWasProvided:Object.hasOwn(p,'effort'),inheritedEffort:thread.reasoningEffort});if(this.modelTurns.length>50)this.modelTurns.shift();
    const turn={id:randomUUID(),status:'inProgress',items:[]};this.turns.get(p.threadId).push(turn);thread.name=(p.input.find(item=>item.type==='text')?.text || '图片演示').slice(0,35);thread.updatedAt=Date.now()/1000;
    const emit=(method,params)=>this.emit('event',{method,params:{threadId:p.threadId,turnId:turn.id,...params}});
    const add=item=>{turn.items.push(item);this.items.get(p.threadId).push({turnId:turn.id,item});};
    const user={id:randomUUID(),type:'userMessage',content:p.input};add(user);emit('item/completed',{item:user});emit('turn/started',{turn});
    const item={id:randomUUID(),type:'agentMessage',text:''};add(item);emit('item/started',{item});
    const chunks=['这是本地演示，没有调用 Codex 或 DeepSeek，也没有修改文件。\n\n','实际模式会通过 Codex app-server 复用本机登录与 MCP 配置。','Codex 可经已有 dsh_subagent 调度 DeepSeek；这里只替换界面，不更换模型供应商。'];
    const timers=new Set();this.timers.set(turn.id,timers);
    chunks.forEach((delta,index)=>{const timer=setTimeout(()=>{timers.delete(timer);item.text+=delta;emit('item/agentMessage/delta',{itemId:item.id,delta});if(index===chunks.length-1){turn.status='completed';this.timers.delete(turn.id);emit('item/completed',{item});emit('turn/completed',{turn});}},200*(index+1));timers.add(timer);});return {turn};
   }
   case 'turn/steer':{
    const turn=this.turns.get(p.threadId)?.find(t=>t.status==='inProgress');
    if(!turn||turn.id!==p.expectedTurnId)throw Object.assign(new Error('运行任务已变化'),{code:-32602});
    const item={id:randomUUID(),type:'userMessage',content:p.input};turn.items.push(item);this.items.get(p.threadId).push({turnId:turn.id,item});
    this.emit('event',{method:'item/completed',params:{threadId:p.threadId,turnId:turn.id,item}});return {turnId:turn.id};
   }
   case 'turn/interrupt':{
    const turn=this.turns.get(p.threadId)?.find(t=>t.id===p.turnId);if(!turn)throw Object.assign(new Error('此对话没有该任务'),{code:-32602});
    if(turn.status!=='inProgress')return {};
    for(const timer of this.timers.get(turn.id)||[])clearTimeout(timer);this.timers.delete(turn.id);turn.status='interrupted';this.emit('event',{method:'turn/completed',params:{threadId:p.threadId,turn}});return {};
   }
   default:throw Object.assign(new Error('演示不支持该方法'),{code:-32601});
  }
 }
 respond(id){this.requests.delete(String(id));}
 close(){for(const timers of this.timers.values())for(const timer of timers)clearTimeout(timer);this.timers.clear();this.connected=false;}
}
