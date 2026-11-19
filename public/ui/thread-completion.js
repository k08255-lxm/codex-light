// A blue dot means a newly completed, unread turn. Activity and timestamps are not completion evidence.
export function createThreadCompletion(onCountChange = () => {}) {
  const unread = new Map(), active = new Map(), settled = new Set(), internalThreads = new Set();
  let count = 0;
  const keyFor=(threadId,turnId)=>JSON.stringify([threadId,turnId]);
  const validId=value=>typeof value==='string'&&value.length>0&&value.length<=256;
  const remember=key=>{settled.add(key);if(settled.size>1000)settled.delete(settled.values().next().value);};
  function read(threadId) {
    const turns = unread.get(threadId);
    if (!turns) return;
    unread.delete(threadId);
    count -= turns.size;
    onCountChange(count);
  }
  function ignoreInternal(threadId) {
    if (!validId(threadId) || internalThreads.has(threadId)) return;
    internalThreads.add(threadId);
    active.delete(threadId);
    read(threadId);
  }
  function trackThread(thread) {
    if (thread?.ephemeral || thread?.parentThreadId || thread?.source?.subAgent) ignoreInternal(thread.id);
  }
  function trackActive(threadId, turnId) {
    if (!validId(threadId) || !validId(turnId) || internalThreads.has(threadId) || active.get(threadId) === turnId || settled.has(keyFor(threadId,turnId))) return;
    const previous = active.get(threadId);
    if (previous && previous !== turnId) remember(keyFor(threadId,previous));
    active.set(threadId,turnId);
    if (active.size > 1000) active.delete(active.keys().next().value);
  }
  return {
    unread,
    trackActive,
    trackThread,
    get count() { return count; },
    observe({method,params={}}, viewedThreadId=null) {
      if (method === 'thread/started') { trackThread(params.thread); return; }
      if (method === 'item/started' || method === 'item/completed') {
        if (params.item?.type === 'subAgentActivity') ignoreInternal(params.item.agentThreadId);
        return;
      }
      const threadId=params.threadId,turn=params.turn;
      if(internalThreads.has(threadId)||!validId(threadId)||!validId(turn?.id)||!['turn/started','turn/completed'].includes(method))return;
      const key=keyFor(threadId,turn.id);
      if(settled.has(key))return;
      if(method==='turn/started'){
        trackActive(threadId,turn.id);
      }else{
        if(!['completed','failed','interrupted'].includes(turn.status))return;
        remember(key);
        if(active.has(threadId)&&active.get(threadId)!==turn.id)return;
        active.delete(threadId);
        if (threadId === viewedThreadId) { read(threadId); return; }
        if (turn.status !== 'completed') return;
        const turns = unread.get(threadId) || new Set();
        if (turns.has(turn.id)) return;
        turns.add(turn.id); unread.set(threadId, turns);
        onCountChange(++count);
      }
    },
    read,
    reset(){unread.clear();active.clear();settled.clear();internalThreads.clear();count=0;onCountChange(0);},
  };
}

export function createTaskbarBadge(post) {
  let completed = 0, questions = 0, attention = false;
  let lastCount, lastAttention;
  function sync() {
    const count = completed + questions;
    if (count === lastCount && attention === lastAttention) return;
    post({type:'desktopTaskbarBadge', count, attention});
    lastCount = count; lastAttention = attention;
  }
  return {
    setCompleted(count) { completed = count; sync(); },
    setQuestions(count, enabled) { questions = count; attention = enabled && count > 0; sync(); },
  };
}
