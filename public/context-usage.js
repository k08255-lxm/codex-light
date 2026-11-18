export const contextFields = [
  ['inputTokens','输入'], ['cachedInputTokens','缓存读取'], ['cacheWriteInputTokens','缓存写入'],
  ['outputTokens','输出'], ['reasoningOutputTokens','推理'], ['totalTokens','合计'],
];

const counter = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const breakdown = values => Object.fromEntries(contextFields.map(([field]) => [field,counter(values?.[field])]));

export function contextSnapshot(params) {
  if (typeof params?.threadId !== 'string' || !params.threadId || params.threadId.length > 256) return null;
  if (!params.tokenUsage || typeof params.tokenUsage !== 'object') return null;
  const {last,total,modelContextWindow} = params.tokenUsage;
  return {threadId:params.threadId,turnId:typeof params.turnId === 'string' && params.turnId.length <= 256 ? params.turnId : null,
    used:counter(last?.totalTokens),window:counter(modelContextWindow) || null,last:breakdown(last),total:breakdown(total)};
}

/** The meter describes the latest reported context, never cumulative usage. */
export function contextView(snapshot) {
  if (!snapshot || snapshot.used === null || snapshot.window === null) {
    return {known:false,label:'上下文未知',detail:snapshot?.used != null ? `最近一次请求 ${snapshot.used.toLocaleString('zh-CN')} tokens。模型窗口未知。` : '本对话尚未收到上下文用量'};
  }
  const ratio = Math.min(1,snapshot.used/snapshot.window);
  const percentUsed = Math.round(ratio*100);
  const remaining = Math.max(0,snapshot.window-snapshot.used);
  return {known:true,ratio,percentUsed,percentLeft:100-percentUsed,remaining,label:`${percentUsed}%`,
    detail:`上下文已使用约 ${percentUsed}% · ${snapshot.used.toLocaleString('zh-CN')} / ${snapshot.window.toLocaleString('zh-CN')} tokens`};
}
