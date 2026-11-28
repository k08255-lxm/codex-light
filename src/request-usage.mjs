// Codex reports the last model request alongside a thread-wide cumulative counter.
// A repeated cumulative value (for example a rate-limit update) identifies the same receipt.
export const requestKey = row => JSON.stringify([row.threadId,row.endTokens]);
export function requestReceipt({threadId,turnId,endTokens,timestamp,tokens,model,provider}) {
  if(typeof threadId!=='string'||!threadId||threadId.length>256||
    !Number.isSafeInteger(endTokens)||!(tokens?.totalTokens>0)||!Number.isSafeInteger(tokens.totalTokens)||
    tokens.totalTokens>endTokens||!Number.isFinite(Date.parse(timestamp)))return null;
  for(const key of ['inputTokens','outputTokens','cachedInputTokens','cacheWriteInputTokens','reasoningOutputTokens']){
    const value=tokens[key];if(value!=null&&(!Number.isSafeInteger(value)||value<0||value>tokens.totalTokens))return null;
  }
  if(tokens.inputTokens!=null&&tokens.outputTokens!=null&&tokens.inputTokens+tokens.outputTokens!==tokens.totalTokens)return null;
  return {threadId,turnId,endTokens,timestamp:new Date(timestamp).toISOString(),tokens,model,provider};
}
