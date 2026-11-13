import {HistoryPager,historyCapabilities} from './state.js';

const unsupported=error=>error?.code===-32601||/method (?:not found|not supported)|unknown method/i.test(error?.message||'');
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
