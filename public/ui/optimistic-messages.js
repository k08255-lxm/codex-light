// Ephemeral display state only. The durable mutation ledger remains the authority for retries.
export class OptimisticMessages {
 constructor(){this.rows=new Map();this.claimed=new Set();}
 begin({threadId=null,generation,text,images=[],files=[],beforeIds=[],method='turn/start'}){
  const row={id:globalThis.crypto.randomUUID(),threadId,generation,text,images:images.map(x=>({id:x.id,name:x.name})),files:files.map(x=>({id:x.id,name:x.name})),beforeIds:[...beforeIds],method,status:'sending',requestId:null,turnId:null,error:''};
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
