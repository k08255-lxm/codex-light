export const MAX_READ_RECEIPTS = 4096;
export const MAX_READ_TURNS = 64;
export const validCompletionId = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const keyFor = (threadId, turnId) => JSON.stringify([threadId, turnId]);

// A blue dot means a newly completed, unread turn. Activity and timestamps are not completion evidence.
export function createThreadCompletion(onCountChange = () => {}) {
  const unread = new Map(), active = new Map(), settled = new Set(), remoteReads = new Set(), internalThreads = new Set();
  let count = 0;
  const validId = validCompletionId;
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
        if (turn.status !== 'completed' || remoteReads.has(key)) return;
        const turns = unread.get(threadId) || new Set();
        if (turns.has(turn.id)) return;
        turns.add(turn.id); unread.set(threadId, turns);
        onCountChange(++count);
      }
    },
    syncRead(reads) {
      const previousCount = count;
      for (const {threadId, turnIds} of reads) {
        const turns = unread.get(threadId);
        for (const turnId of turnIds) {
          remoteReads.add(keyFor(threadId, turnId));
          if (remoteReads.size > MAX_READ_RECEIPTS) remoteReads.delete(remoteReads.values().next().value);
          if (turns?.delete(turnId)) count--;
        }
        if (turns && !turns.size) unread.delete(threadId);
      }
      if (count !== previousCount) onCountChange(count);
      return count !== previousCount;
    },
    read,
    reset(){unread.clear();active.clear();settled.clear();remoteReads.clear();internalThreads.clear();count=0;onCountChange(0);},
  };
}

export function createThreadReadReporter(send) {
  const pending = new Map(), queued = new Set();
  let scope = null, connected = false, inFlight = false, retry = null;
  async function flush() {
    if (!connected || inFlight || retry !== null || !pending.size) return;
    const [threadId, turns] = pending.entries().next().value;
    const turnIds = Array.from(turns).slice(0, MAX_READ_TURNS);
    const currentScope = scope;
    inFlight = true;
    try {
      await send({scope, threadId, turnIds});
      if (scope === currentScope) {
        for (const turnId of turnIds) turns.delete(turnId);
        if (!turns.size) pending.delete(threadId);
      }
    } catch (error) {
      if (scope === currentScope && connected) {
        if (error?.code === 'THREAD_READ_SCOPE_CHANGED') connected = false;
        else retry = setTimeout(() => { retry = null; void flush(); }, 2000);
      }
    } finally {
      inFlight = false;
      void flush();
    }
  }
  return {
    connect(nextScope) {
      const changed = scope !== null && scope !== nextScope;
      if (changed) { pending.clear(); queued.clear(); }
      scope = nextScope;
      connected = true;
      clearTimeout(retry);
      retry = null;
      void flush();
      return changed;
    },
    disconnect() {
      connected = false;
      clearTimeout(retry);
      retry = null;
    },
    record(threadId, turnIds) {
      if (!scope || !validCompletionId(threadId)) return;
      const turns = pending.get(threadId) ?? new Set();
      for (const turnId of turnIds) {
        if (!validCompletionId(turnId)) continue;
        const key = keyFor(threadId, turnId);
        if (queued.has(key)) continue;
        queued.add(key);
        if (queued.size > MAX_READ_RECEIPTS) queued.delete(queued.values().next().value);
        turns.add(turnId);
      }
      if (turns.size) pending.set(threadId, turns);
      void flush();
    },
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
