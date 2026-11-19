// Ephemeral display state only. The durable mutation ledger remains the authority for retries.
export class OptimisticMessages {
 constructor(){this.rows=new Map();this.claimed=new Set();}
 begin({threadId=null,generation,text,images=[],files=[],beforeIds=[],afterItemId=null,method='turn/start'}){
  const row={id:globalThis.crypto.randomUUID(),threadId,generation,text,images:images.map(x=>({id:x.id,name:x.name})),files:files.map(x=>({id:x.id,name:x.name})),beforeIds:[...beforeIds],afterItemId,method,status:'sending',requestId:null,turnId:null,error:''};
  this.rows.set(row.id,row);return row;
 }
 patch(id,values){const row=this.rows.get(id);if(row)Object.assign(row,values);return row;}
 resolve(requestId,decision,result,error=''){
  const row=[...this.rows.values()].find(x=>x.requestId===requestId);if(!row)return;
  if(decision==='succeeded'){
   if(row.method==='thread/start')this.patch(row.id,{threadId:result?.thread?.id||row.threadId,status:'notExecuted',error:'对话已创建，消息尚未发送。'});
   else this.patch(row.id,{status:'accepted',turnId:result?.turn?.id||result?.turnId||row.turnId,error:''});
  }else this.patch(row.id,{status:decision==='notExecuted'?'notExecuted':decision==='failed'?'failed':'unknown',error});
 }
 visible(threadId,generation){return [...this.rows.values()].filter(x=>x.threadId?x.threadId===threadId:!threadId&&x.generation===generation);}
 timeline(threadId,items){
  this.reconcile(threadId,items);
  const pending=[...this.rows.values()].filter(row=>row.threadId===threadId&&row.status==='accepted'&&row.turnId);
  if(!pending.length)return items;
  const result=[...items],tails=new Map();
  for(const row of pending){
   const first=result.findIndex(item=>item._turnId===row.turnId);
   const anchor=tails.get(row.afterItemId)||row.afterItemId;
   const after=result.findIndex(item=>item.id===anchor);
   let index=after>=0?after+1:result.length;
   if(row.method==='turn/start'){
    if(first>=0)index=first;
    else if(after<0&&row.afterItemId===null)index=0;
   }else if(first>=0&&result[after]?._turnId!==row.turnId){
    // A restored page can replace the original anchor or reveal the turn's prompt after submission.
    index=result.findLastIndex(item=>item._turnId===row.turnId)+1;
   }
   const id='sent:'+row.id;
   const content=[{type:'text',text:[row.text,...row.images.concat(row.files).map(file=>'附件 · '+file.name)].filter(Boolean).join('\n')}];
   result.splice(index,0,{id,type:'userMessage',content,_turnId:row.turnId,_local:true,_complete:true});
   tails.set(row.afterItemId,id);
  }
  return result;
 }
 reconcile(threadId,items){
  for(const row of this.rows.values()){
   if(row.threadId!==threadId||row.status!=='accepted'||!row.turnId)continue;
   const native=items.find(item=>{
    if(item.type!=='userMessage'||item._local||item._turnId!==row.turnId||row.beforeIds.includes(item.id)||this.claimed.has(item.id))return false;
    const parts=item.content||[];const texts=parts.filter(x=>x.type==='text').map(x=>x.text?.trim()||'');
    if(row.text&&!texts.some(text=>text===row.text.trim()))return false;
    // An attachment-only start has a unique server turn; a steer additionally needs content evidence.
    if(!row.text&&row.method==='turn/steer'&&!parts.some(x=>['image','localImage'].includes(x.type)||x.imageRef!==undefined||x.type==='text'&&x.text?.includes('用户选择的本地附件')))return false;
    return true;
   });
   if(native){this.claimed.add(native.id);this.rows.delete(row.id);}
  }
 }
 remove(id){this.rows.delete(id);}
}
