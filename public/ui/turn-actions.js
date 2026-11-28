import {icon} from '../icons.js';
import {mountStatPopover} from './stat-popover.js';
import {compact,showTokens} from './format.js';

const count = value => Number.isSafeInteger(value) && value >= 0;
const number = new Intl.NumberFormat('zh-CN',{maximumFractionDigits:9});
const format = value => typeof value==='number' && Number.isFinite(value) ? number.format(value) : '—';

// One batch for newly rendered turns. Retain results across virtual unmounts,
// and discard responses from the previous conversation after clear().
export function createTurnUsageSource(read) {
  const entries=new Map(), waiting=new Set();
  let scheduled=false;
  async function flush(){
    scheduled=false;
    const batch=[...waiting];waiting.clear();
    for(let i=0;i<batch.length;i+=30){
      const rows=batch.slice(i,i+30);
      try{
        const result=await read(rows[0].threadId,rows.map(row=>row.turnId));
        if(!Array.isArray(result?.turns))throw new Error('用量数据格式无效');
        const byId=new Map(result.turns.map(row=>[row.turnId,row]));
        for(const row of rows)finish(row,{value:byId.get(row.turnId)||null});
      }catch(error){for(const row of rows)finish(row,{error:error.message||'无法读取用量'});}
    }
  }
  function finish(row,status){
    if(entries.get(row.turnId)!==row)return;
    row.loading=false;row.status=status;row.listener?.(status);
    if(row.stale){row.stale=false;queue(row);}
  }
  function queue(row){
    if(row.loading)return;
    row.loading=true;waiting.add(row);
    if(!scheduled){scheduled=true;queueMicrotask(flush);}
  }
  return {
    watch(threadId,turnId,listener){
      let row=entries.get(turnId);
      if(!row||row.threadId!==threadId){
        row={threadId,turnId};entries.set(turnId,row);queue(row);
      }
      row.listener=listener;
      if(row.status)listener(row.status);
      return ()=>{if(row.listener===listener)row.listener=null;};
    },
    refresh(threadId,turnId){
      const row=entries.get(turnId);
      if(row?.threadId!==threadId)return;
      if(row.loading)row.stale=true;else queue(row);
    },
    recovered(){
      for(const row of entries.values()){
        if(!row.listener){entries.delete(row.turnId);continue;}
        if(row.loading)row.stale=true;else queue(row);
      }
    },
    clear(){entries.clear();waiting.clear();}
  };
}

const titles={input:'输入 · 缓存未命中',inputIncludingCacheWrite:'输入（含缓存写入）',cacheRead:'输入 · 缓存命中',cacheWrite:'输入 · 缓存写入',output:'输出',reasoning:'推理'};
function breakdown(row){
  const t=row.tokens||{},cost=row.estimatedCost||{};
  const fullInput=[t.inputTokens,t.cachedInputTokens,t.cacheWriteInputTokens].every(count)
    && t.cachedInputTokens+t.cacheWriteInputTokens<=t.inputTokens;
  const parts=cost.components?.length?cost.components.map(part=>({...part,label:titles[part.kind]})):[
    {kind:'input',tokens:fullInput?t.inputTokens-t.cachedInputTokens-t.cacheWriteInputTokens:null,label:titles.input},
    {kind:'cacheRead',tokens:t.cachedInputTokens,label:titles.cacheRead},
    {kind:'cacheWrite',tokens:t.cacheWriteInputTokens,label:titles.cacheWrite},
    {kind:'output',tokens:t.outputTokens,label:titles.output}
  ];
  if(!fullInput&&count(t.inputTokens))parts.unshift({label:'输入合计',tokens:t.inputTokens});
  if(!parts.some(p=>p.kind==='reasoning')&&count(t.reasoningOutputTokens)&&t.reasoningOutputTokens>0)
    parts.push({kind:'reasoning',label:'其中推理',tokens:t.reasoningOutputTokens});
  return parts.filter(p=>p.kind!=='cacheWrite'||p.tokens!==0);
}

export function createTurnActions(document,{threadId,turnId,source,onCopy,onFork,getContext,ensurePrices}){
  function el(tag,cls,text){
    const n=document.createElement(tag);if(cls)n.className=cls;
    if(text!==undefined)n.textContent=text;return n;
  }
  const node=el('div','turn-actions');
  node.setAttribute('role','group');node.setAttribute('aria-label','回答操作');
  function action(title,glyph){
    const b=el('button');b.type='button';b.title=title;b.setAttribute('aria-label',title);
    b.append(icon(document,glyph,{size:16}));node.append(b);return b;
  }
  const copy=action('复制回答','copy'),fork=action('分支到新聊天','branch'),usage=action('本轮用量','usage');
  const amount=el('span','','本轮用量');usage.append(amount);
  const feedback=el('span','turn-actions-feedback');feedback.setAttribute('role','status');node.append(feedback);
  const panel=el('div','turn-usage-popover');panel.setAttribute('popover','auto');
  panel.setAttribute('role','dialog');panel.setAttribute('aria-label','本轮用量');
  panel.id='turn-usage-'+(++nextPopoverId);
  usage.setAttribute('aria-controls',panel.id);usage.setAttribute('aria-expanded','false');usage.setAttribute('aria-haspopup','dialog');
  node.append(panel);
  let text='',status=null,released=false,feedbackTimer;
  let pricesPending=false,pricesChecked=false,priceError='';
  function details(){
    const row=status?.value,cost=row?.estimatedCost;
    const head=el('div','turn-usage-head');head.append(el('strong','','本轮用量'));
    if(cost?.usd!=null)head.append(el('strong','turn-usage-amount',(cost.complete?'':'小计 ')+'$'+format(cost.usd)));
    panel.replaceChildren(head);
    if(!row){panel.append(el('p','fine',status?.error||(!status?'正在读取…':'此轮未记录用量。')));return;}
    if(row.model)panel.append(el('p','fine',row.model));
    const table=el('table'),thead=el('thead'),tr=el('tr');
    for(const title of ['项目','tokens','单价¹','金额¹'])tr.append(el('th','',title));
    thead.append(tr);table.append(thead);
    const body=el('tbody');
    for(const part of breakdown(row)){
      const line=el('tr'),quantity=el('td');showTokens(quantity,part.tokens);
      line.append(el('th','',part.label),quantity,el('td','',format(part.pricePerMillion)),el('td','',format(part.usd)));body.append(line);
    }
    table.append(body);panel.append(table,el('p','fine','¹ 美元，单价按每百万 tokens 计算。实际扣款以账单为准。'));
    if(priceError)panel.append(el('p','fine',priceError));
    else if(!cost?.complete)panel.append(el('p','fine',!row.model?'这轮未记录模型，可在用量页导入原始日志。':cost?.reason||'用量尚未完整记录。'));
    const latest=getContext?.();
    const context=row.context||(latest?.threadId===threadId&&latest.turnId===turnId?latest:null);
    if(count(context?.used)&&context?.window>0){
      const note=el('p','turn-usage-context','本轮结束时上下文占用 '+compact(context.used)+' / '+compact(context.window)+' tokens');
      note.title=format(context.used)+' / '+format(context.window)+' tokens';panel.append(note);
    }
  }
  const popover=mountStatPopover(usage,panel,{onOpen(){
    details();pricesChecked=false;source.refresh(threadId,turnId);void loadPrices();
  }});
  const unwatch=source.watch(threadId,turnId,next=>{
    status=next;
    const total=next.value?.tokens?.totalTokens;
    showTokens(amount,total,{suffix:' tokens',unknown:'本轮用量'});
    if(popover.open){details();popover.position();void loadPrices();}
  });
  async function loadPrices(){
    if(!ensurePrices||pricesPending||pricesChecked||!status?.value?.model||status.value.estimatedCost?.usd!=null)return;
    pricesPending=true;pricesChecked=true;
    try{await ensurePrices();priceError='';if(!released)source.refresh(threadId,turnId);}
    catch{priceError='参考价格暂时无法刷新。';if(popover.open){details();popover.position();}}
    finally{pricesPending=false;}
  }
  copy.addEventListener('click',async()=>{
    try{if(onCopy)await onCopy(text);else await document.defaultView.navigator.clipboard.writeText(text);feedback.textContent='已复制';}
    catch{feedback.textContent='复制失败';}
    if(!released){clearTimeout(feedbackTimer);feedbackTimer=setTimeout(()=>{feedback.textContent='';},2000);}
  });
  fork.addEventListener('click',async()=>{
    if(fork.disabled)return;
    fork.disabled=true;
    try{await onFork(threadId,turnId);}finally{fork.disabled=false;}
  });
  return {node,update(value,complete){text=value;copy.title=complete?'复制回答':'复制已保留的回答';copy.setAttribute('aria-label',copy.title);},
    release(){released=true;clearTimeout(feedbackTimer);unwatch();popover.close();}};
}
let nextPopoverId=0;
