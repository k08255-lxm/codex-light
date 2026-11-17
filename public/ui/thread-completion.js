// A blue dot means a newly completed, unread turn. Activity and timestamps are not completion evidence.
export function createThreadCompletion() {
  const unread = new Set(), active = new Map(), settled = new Set();
  const keyFor=(threadId,turnId)=>JSON.stringify([threadId,turnId]);
  const validId=value=>typeof value==='string'&&value.length>0&&value.length<=256;
  const remember=key=>{settled.add(key);if(settled.size>1000)settled.delete(settled.values().next().value);};
  return {
    unread,
    observe({method,params={}}, viewedThreadId=null) {
      const threadId=params.threadId,turn=params.turn;
      if(!validId(threadId)||!validId(turn?.id)||!['turn/started','turn/completed'].includes(method))return;
      const key=keyFor(threadId,turn.id);
      if(settled.has(key))return;
      if(method==='turn/started'){
        const previous=active.get(threadId);
        // A newer start supersedes the old turn, including a late replay of its start/end.
        if(previous&&previous!==turn.id)remember(keyFor(threadId,previous));
        active.set(threadId,turn.id);unread.delete(threadId);
        if(active.size>1000)active.delete(active.keys().next().value);
      }else{
        if(!['completed','failed','interrupted'].includes(turn.status))return;
        remember(key);
        if(active.has(threadId)&&active.get(threadId)!==turn.id)return;
        active.delete(threadId);
        if(turn.status==='completed'&&threadId!==viewedThreadId){
          unread.add(threadId);if(unread.size>1000)unread.delete(unread.values().next().value);
        }else unread.delete(threadId);
      }
    },
    read(threadId){unread.delete(threadId);},
    reset(){unread.clear();active.clear();settled.clear();},
  };
}
