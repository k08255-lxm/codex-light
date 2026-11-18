import {HistoryPager,historyCapabilities} from './state.js';

const unsupported=error=>error?.code===-32601||/method (?:not found|not supported)|unknown method/i.test(error?.message||'');
const turnsUnavailable=error=>unsupported(error)||error?.missingFullTurns===true||([-32600,-32602].includes(error?.code)&&/itemsView|items_view|full.*unsupported/i.test(error?.message||''));
const includeUnavailable=error=>[-32600,-32602].includes(error?.code)&&/(?:includeTurns.*(?:unsupported|unavailable|not supported|paginat)|(?:unknown|unsupported|unrecognized).*includeTurns|paginat.*(?:thread|history|includeTurns))/i.test(error?.message||'');
function reportedThread(result){
  const thread={...result.thread};
  for(const key of ['model','modelProvider','reasoningEffort']){
    const value=thread[key]??result[key];
    if(typeof value==='string'&&value.trim()&&value.length<=256&&!/[\x00-\x1f]/.test(value))thread[key]=value.trim();
  }
  return thread;
}

  function boundedThread(thread) {
    let remaining = 1000;
    const turns = [];
    for (const turn of [...thread.turns].reverse()) {
      const items = Array.isArray(turn.items) ? turn.items : [];
      const kept = items.slice(-remaining); remaining -= kept.length;
      turns.unshift({ ...turn, items:kept });
      if (!remaining) break;
    }
    const total = thread.turns.reduce((sum,turn) => sum + (turn.items?.length || 0),0);
    return { thread:{...thread,turns}, complete:total <= 1000 && turns.length === thread.turns.length && thread.turns.every(turn => Array.isArray(turn.items) && turn.itemsView !== 'notLoaded') };
  }
export async function readAgentThread(rpc,threadId,{capabilities=historyCapabilities(),isCurrent=()=>true}={}) {
  async function callNative(method,params){
    if(!isCurrent())throw Object.assign(new Error('读取所属对话已切换'),{stale:true});
    const result=await rpc(method,params);
    if(!isCurrent())throw Object.assign(new Error('读取所属对话已切换'),{stale:true});
    return result;
  }
  return readAgentSnapshot(callNative,threadId,capabilities);
}

const OLDER_TURNS=3;
const OLDER_ITEMS=100;

/** Inspector history keeps cursors for the selected child, independently of its live tail. */
export class AgentHistory {
  constructor(rpc,threadId,isCurrent=()=>true){
    this.rpc=rpc;this.threadId=threadId;this.isCurrent=isCurrent;
    this.thread=null;this.mode=null;this.cursor=null;this.pager=null;this.buffer=[];
  }
  get hasOlder(){return this.buffer.length>0||this.cursor!==null||!!this.pager?.hasMore;}
  async call(method,params){
    if(!this.isCurrent())throw Object.assign(new Error('读取所属对话已切换'),{stale:true});
    const result=await this.rpc(method,{threadId:this.threadId,...params});
    if(!this.isCurrent())throw Object.assign(new Error('读取所属对话已切换'),{stale:true});
    return result;
  }
  async readThread(includeTurns){
    let result;
    try{result=await this.call('thread/read',{includeTurns});}
    catch(error){if(includeTurns||!includeUnavailable(error))throw error;result=await this.call('thread/read',{});}
    if(result?.thread?.id!==this.threadId)throw new Error('子代理历史返回了其他对话');
    const thread=reportedThread(result),{turns,...metadata}=thread;
    this.thread=metadata;return thread;
  }
  async turns(limit,cursor){
    const data=await this.call('thread/turns/list',{limit,sortDirection:'desc',itemsView:'full',...(cursor?{cursor}:{})});
    if(!Array.isArray(data?.data)||data.data.some(turn=>typeof turn?.id!=='string'||!turn.id||!Array.isArray(turn.items)||['notLoaded','summary'].includes(turn.itemsView)))throw Object.assign(new Error('当前引擎未提供完整回合分页'),{missingFullTurns:true});
    const next=data.nextCursor??null;
    if(next!==null&&(typeof next!=='string'||!next||next===cursor))throw new Error('子代理历史游标没有前进，可重试');
    return {turns:[...data.data].reverse(),next};
  }
  async flat(){
    const thread=await this.readThread(true);
    if(!Array.isArray(thread.turns))throw new Error('子代理历史返回格式无效');
    return thread.turns.map((turn,index)=>({...turn,ordinal:index+1,items:turn.items||[]}));
  }
  async items(pager){
    const batch=await pager.next({max:OLDER_ITEMS});
    const groups=new Map(),metadata=new Map(batch.turns.map(turn=>[turn.id,turn]));
    for(const item of batch.items){
      const id=item._turnId||'unattributed';
      if(!groups.has(id))groups.set(id,{...metadata.get(id),id,items:[]});
      groups.get(id).items.push(item);
    }
    return [...groups.values()];
  }
  async newest(){
    const starting=!this.mode;
    if(starting)await this.readThread(false);
    if(!this.mode||this.mode==='turns'){
      try{
        const page=await this.turns(starting?OLDER_TURNS:1,null);
        if(starting){this.mode='turns';this.cursor=page.next;}
        return {thread:this.thread,turns:page.turns};
      }catch(error){if(!starting||!turnsUnavailable(error))throw error;}
    }
    if(!this.mode||this.mode==='items'){
      const caps=historyCapabilities();caps.unsupported.add('turns');
      // Do not let the general pager's full-read fallback discard the latest-turn boundary.
      const pager=new HistoryPager(async(method,{threadId,...params})=>{
        if(method==='thread/read')throw Object.assign(new Error('无条目分页'),{noItems:true});
        const result=await this.call(method,params);
        if(!Array.isArray(result?.data))throw Object.assign(new Error('无条目分页'),{noItems:true});
        if(params.cursor&&result.nextCursor===params.cursor)throw new Error('子代理历史游标没有前进，可重试');
        return result;
      },this.threadId,caps);
      try{
        const turns=await this.items(pager);
        if(starting){this.mode='items';this.pager=pager;this.buffer=turns.slice(0,-OLDER_TURNS);}
        return {thread:this.thread,turns:turns.slice(starting?-OLDER_TURNS:-1)};
      }catch(error){if(!starting||!error.noItems&&!unsupported(error))throw error;}
    }
    const all=await this.flat();
    if(starting){this.mode='read';this.cursor=all.length>OLDER_TURNS?all.at(-OLDER_TURNS).id:null;}
    return {thread:this.thread,turns:all.slice(starting?-OLDER_TURNS:-1)};
  }
  async older(){
    if(this.buffer.length)return this.buffer.splice(0);
    if(this.mode==='items'&&this.pager.hasMore)return this.items(this.pager);
    if(!this.cursor)return [];
    if(this.mode==='turns'){
      const page=await this.turns(OLDER_TURNS,this.cursor);this.cursor=page.next;return page.turns;
    }
    const all=await this.flat(),end=all.findIndex(turn=>turn.id===this.cursor);
    if(end<0)throw new Error('此前读取的任务已不存在，请刷新子代理详情');
    const start=Math.max(0,end-OLDER_TURNS),turns=all.slice(start,end);
    this.cursor=start>0?turns[0].id:null;return turns;
  }
}

export function mergeAgentTurns(current, incoming, {older=false}={}){
  const previous=new Map(current.map(turn=>[turn.id,turn]));
  const patch=new Map(incoming.map(turn=>{
    const old=previous.get(turn.id);
    const merged=new Map((older?turn.items:old?.items||[]).map(item=>[item.id,item]));
    for(const item of older?old?.items||[]:turn.items||[])merged.set(item.id,item);
    return [turn.id,{...(older?{...turn,...old}:{...old,...turn}),items:[...merged.values()]}];
  }));
  const order=older?[...patch.keys()].filter(id=>!previous.has(id)).concat([...previous.keys()]):[...previous.keys(),...patch.keys()];
  return [...new Set(order)].map(id=>patch.get(id)||previous.get(id));
}
  async function readAgentSnapshot(callNative,threadId,capabilities){
    try {
      const result = await callNative('thread/read',{threadId:threadId,includeTurns:true});
      if (result.thread?.id !== threadId || !Array.isArray(result.thread.turns)) throw new Error('子代理历史返回格式无效');
      return boundedThread(reportedThread(result));
    } catch (error) {
      if (!includeUnavailable(error)) throw error;
    }
    const result = await callNative('thread/read',{threadId:threadId});
    if (result.thread?.id !== threadId) throw new Error('子代理元数据返回了其他会话');
    const pager = new HistoryPager((method,params) => callNative(method,params),threadId,capabilities);
    const metadata = new Map();
    let items = [], more = true;
    for (let page = 0; page < 10 && more && items.length < 1000; page++) {
      const batch = await pager.next({max:Math.min(200,1000-items.length)});
      items = [...batch.items,...items]; more = batch.hasMore;
      for (const turn of batch.turns) metadata.set(turn.id,{...turn,items:[]});
    }
    // items/list carries item timing, while turns/list supplies native turn windows and status.
    if (!metadata.size) {
      try {
        let cursor = null;
        for (let page = 0; page < 10; page++) {
          const response = await callNative('thread/turns/list',{threadId:threadId,limit:100,sortDirection:'desc',itemsView:'notLoaded',...(cursor?{cursor}:{})});
          for (const turn of response.data || []) metadata.set(turn.id,{...turn,items:[]});
          cursor = response.nextCursor || null;
          if (!cursor) break;
          if (page === 9) more = true;
        }
      } catch (error) { if (!unsupported(error)) throw error; }
    }
    const order = [];
    for (const item of items) {
      if (!item._turnId) continue;
      if (!order.includes(item._turnId)) order.push(item._turnId);
      if (!metadata.has(item._turnId)) metadata.set(item._turnId,{id:item._turnId,items:[]});
      metadata.get(item._turnId).items.push(item);
    }
    const missing=[...metadata.keys()].filter(id=>!order.includes(id));
    const turns=[...order,...missing].map(id=>metadata.get(id));
    turns.sort((a,b)=>{
      if(Number.isFinite(a.startedAt)&&Number.isFinite(b.startedAt))return a.startedAt-b.startedAt;
      return Number(a.status==='inProgress')-Number(b.status==='inProgress');
    });
    const ordered=missing.length===0||turns.every(turn=>Number.isFinite(turn.startedAt));
    return {thread:{...reportedThread(result),turns},complete:!more && items.length < 1000&&ordered};
  }
