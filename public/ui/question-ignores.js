// Read only notices for cards actually mounted. The host owns the receipt, so it
// survives reopening and a paired phone can dismiss the same question as the desktop.
export function createQuestionIgnores({read,write,onIgnored,scope,onError}) {
  const entries=new Map(),queued=new Set();
  const key=(threadId,itemId)=>JSON.stringify([threadId,itemId]);
  let scheduled=false;
  function apply(threadId,itemId) {
    const entry=entries.get(key(threadId,itemId));
    if(entry && !entry.ignored){
      entry.ignored=true;
      for(const listener of entry.listeners)listener(true);
    }
    onIgnored(threadId,itemId);
  }
  async function flush(){
    scheduled=false;
    const groups=new Map(),current=scope();
    for(const entry of queued){
      if(!entry.listeners.size||entry.ignored)continue;
      if(!groups.has(entry.threadId))groups.set(entry.threadId,[]);
      groups.get(entry.threadId).push(entry);
    }
    queued.clear();
    for(const [threadId,group] of groups)for(let offset=0;offset<group.length;offset+=64){
      const batch=group.slice(offset,offset+64);
      try{
        const {ignored}=await read(threadId,batch.map(e=>e.itemId));
        if(current!==scope())continue;
        const ids=new Set(ignored);
        for(const entry of batch)if(ids.has(entry.itemId))apply(threadId,entry.itemId);
      }catch(error){if(current===scope())onError(error);}
    }
  }
  function queue(entry){queued.add(entry);if(!scheduled){scheduled=true;queueMicrotask(flush);}}
  return {apply,refresh(){for(const entry of entries.values())queue(entry);},
    watch(threadId,itemId,listener){
      const id=key(threadId,itemId);
      let entry=entries.get(id);
      if(!entry){entry={threadId,itemId,ignored:false,listeners:new Set()};entries.set(id,entry);queue(entry);}
      entry.listeners.add(listener);listener(entry.ignored);
      return ()=>{entry.listeners.delete(listener);if(!entry.listeners.size){entries.delete(id);queued.delete(entry);}};
    },
    async ignore(threadId,itemId){
      const instance=scope();
      const receipt=await write(threadId,itemId,instance);
      if(scope()!==instance || receipt.threadId!==threadId || receipt.itemId!==itemId)throw new Error('提问状态未确认，请重新打开对话');
      apply(threadId,itemId);
    },
  };
}
