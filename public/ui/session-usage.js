import {showTokens,percent,usd} from './format.js';
import {mountStatPopover} from './stat-popover.js';

export function mountSessionUsage(document,readCost){
  const get=id=>document.getElementById(id);
  const button=get('session-usage'),panel=get('session-usage-details');
  let threadId=null,total=null,cost=null,request=0,pending=false,queued=null,error='';
  const popover=mountStatPopover(button,panel,{onOpen:()=>refresh()});

  function draw(){
    const input=total?.inputTokens,cached=total?.cachedInputTokens,count=total?.totalTokens;
    const split=input!=null&&cached!=null&&cached<=input;
    const hit=split&&input>0?percent(cached/input,1):null;
    showTokens(get('session-token-label'),count,{suffix:' tok',unknown:'Token 用量'});
    get('session-hit-label').textContent=hit?'· 缓存命中 '+hit:'';
    showTokens(get('session-token-total'),count,{suffix:' tok'});
    get('session-cache-hit').textContent=hit??'—';
    showTokens(get('session-input'),split?input-cached:null,{suffix:' tok'});
    showTokens(get('session-cached'),cached,{suffix:' tok'});
    showTokens(get('session-output'),total?.outputTokens,{suffix:' tok'});
    const partial=cost&&(cost.partial||count==null||cost.coveredTokens!==count);
    const amount=usd(cost?.usd);
    get('session-cost').textContent=cost?.usd==null?'—':(partial?'已知部分 ':'')+amount;
    const caption=cost?.usd==null?'费用 —':(partial?'已知部分 ':'≈')+amount;
    const status=error||(cost?.usd!=null
      ? partial?'仅含有用量和参考单价的记录。':'按各模型的参考单价估算。'
      : cost?cost.reason||'暂无可计价的模型用量记录。':'正在读取费用…');
    get('session-cost-label').textContent='· '+caption;
    get('session-cost-label').title='本次对话预估费用（USD） · '+status;
    get('session-cost-status').textContent=status;
    button.setAttribute('aria-label',[get('session-token-label').textContent,hit&&'缓存命中 '+hit,'预估费用 '+(cost?.usd==null?'未知':(partial?'已知部分 ':'')+amount),'查看用量明细'].filter(Boolean).join('，'));
  }
  async function refresh(history=true){
    if(!threadId)return;
    if(pending){queued=Boolean(queued||history);return;}
    pending=true;
    const ticket=++request;error='';draw();
    try{const result=await readCost(threadId,history);if(ticket===request)cost=result;}
    catch{if(ticket===request){cost=null;error='费用暂时无法读取。';}}
    if(ticket===request){pending=false;draw();if(queued!==null){const next=queued;queued=null;void refresh(next);}}
  }
  return {close:popover.close,get open(){return popover.open;},refresh,update(id,next){
    const selected=id!==threadId;
    if(selected){request++;pending=false;queued=null;popover.close();cost=null;error='';threadId=id;}
    const changed=total?.totalTokens!==next?.totalTokens;total=next;button.classList.toggle('hidden',!id);draw();
    if(id&&(selected||changed))void refresh(selected);
  }};
}
