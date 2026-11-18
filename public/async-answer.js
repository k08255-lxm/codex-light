import {outcomeFromError} from './submissions.js';
import {rememberAsyncAnswer} from './ui/async-input.js';

// Async questions are assistant messages, not blocking approval requests. Reply through the
// ordinary thread input protocol, without borrowing the current composer's draft or settings.
export function createAsyncAnswerSender({state,sessionFor,performMutation,getCwd=id=>(state.thread?.id===id?state.thread:state.threads?.find(thread=>thread.id===id))?.cwd,getPermission=()=>({}),hasPending=()=>false,getEchoIds=()=>[],onSent=()=>{},onChange=()=>{}}){
  const sending=new Set();
  return async function answer({threadId,itemId,text}){
    if(typeof threadId!=='string'||!threadId||typeof itemId!=='string'||!itemId||typeof text!=='string'||!text.trim())throw new Error('没有可发送的回答。');
    if(!state.connected||!state.serverInstance)throw new Error('连接已断开，回答尚未发送。');
    if(state.sending||hasPending(threadId)||sending.has(threadId))throw new Error('此对话还有消息等待确认，请稍后提交。');
    const serverInstance=state.serverInstance;
    const beforeIds=getEchoIds(threadId);
    let submitted=false;
    sending.add(threadId);state.sending=true;onChange();
    try{
      let activeTurnId=sessionFor(threadId)?.activeTurnId,cwd,permission;
      if(!activeTurnId){cwd=await getCwd(threadId);if(cwd)permission=await getPermission(threadId,cwd);activeTurnId=sessionFor(threadId)?.activeTurnId;}
      if(!state.connected||state.serverInstance!==serverInstance)throw new Error('连接环境已变化，回答尚未发送。');
      if(!activeTurnId&&(typeof cwd!=='string'||!cwd))throw new Error('无法确认该问题所属对话的工作目录，请重新打开对话后再回答。');
      const method=activeTurnId?'turn/steer':'turn/start';
      const params={threadId,input:[{type:'text',text}],...(activeTurnId?{expectedTurnId:activeTurnId}:{cwd,...permission})};
      submitted=true;
      const result=await performMutation(method,params);
      if(!(method==='turn/steer'?result?.turnId:result?.turn?.id))return {status:'unknown',message:'回答已提交，正在确认发送状态。'};
      if(method==='turn/start')rememberAsyncAnswer(threadId,itemId,result.turn.id);
      onSent({threadId,itemId,text,method,result,beforeIds});
      return {status:'sent'};
    }catch(error){
      if(submitted&&outcomeFromError(error)==='unknown')return {status:'unknown',message:'发送结果尚未确认，请勿重复提交。'};
      throw error;
    }finally{sending.delete(threadId);state.sending=false;onChange();}
  };
}
