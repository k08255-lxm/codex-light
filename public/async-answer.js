import {outcomeFromError} from './submissions.js';

// Async questions are assistant messages, not blocking approval requests. Reply through the
// ordinary thread input protocol, without borrowing the current composer's draft or settings.
export function createAsyncAnswerSender({state,sessionFor,performMutation,hasPending=()=>false,getEchoIds=()=>[],onSent=()=>{},onChange=()=>{}}){
  const sending=new Set();
  return async function answer({threadId,itemId,text}){
    if(typeof threadId!=='string'||!threadId||typeof itemId!=='string'||!itemId||typeof text!=='string'||!text.trim())throw new Error('没有可发送的回答。');
    if(!state.connected||!state.serverInstance)throw new Error('连接已断开，回答尚未发送。');
    if(state.sending||hasPending(threadId)||sending.has(threadId))throw new Error('此对话还有消息等待确认，请稍后提交。');
    const activeTurnId=sessionFor(threadId)?.activeTurnId;
    const method=activeTurnId?'turn/steer':'turn/start';
    const params={threadId,input:[{type:'text',text}],...(activeTurnId?{expectedTurnId:activeTurnId}:{})};
    const beforeIds=getEchoIds(threadId);
    sending.add(threadId);state.sending=true;onChange();
    try{
      const result=await performMutation(method,params);
      if(!(method==='turn/steer'?result?.turnId:result?.turn?.id))return {status:'unknown',message:'回答已提交，正在确认发送状态。'};
      onSent({threadId,itemId,text,method,result,beforeIds});
      return {status:'sent'};
    }catch(error){
      if(outcomeFromError(error)==='unknown')return {status:'unknown',message:'发送结果尚未确认，请勿重复提交。'};
      throw error;
    }finally{sending.delete(threadId);state.sending=false;onChange();}
  };
}
