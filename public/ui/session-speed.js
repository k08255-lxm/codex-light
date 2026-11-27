import {mountStatPopover} from './stat-popover.js';

const rate=new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1});
function duration(ms){
  if(ms==null)return '—';
  if(ms<60000)return rate.format(ms/1000)+' 秒';
  const seconds=Math.round(ms/1000);
  return Math.floor(seconds/60)+' 分 '+seconds%60+' 秒';
}
const speed=value=>value==null?'—':rate.format(value)+' tok/s';

export function mountSessionSpeed(document,read){
  const get=id=>document.getElementById(id),button=get('session-speed'),panel=get('speed-details');
  let threadId=null,value=null,pending=null,queued=null,timer=null,problem='';
  const popover=mountStatPopover(button,panel,{onOpen:()=>refresh()});
  function draw(){
    const label=value?.tps!=null?speed(value.tps):value?.turnTps!=null?'均速 '+speed(value.turnTps):'会话速度';
    get('speed-label').textContent=label;
    button.setAttribute('aria-label',label==='会话速度'?label:label+'，查看会话速度');
    get('speed-reply').textContent=duration(value?.replyMs);
    get('speed-tools').textContent=duration(value?.toolMs);
    get('speed-ttft').textContent=duration(value?.ttftMs);
    get('speed-tps').textContent=speed(value?.tps);
    get('speed-turn').textContent=speed(value?.turnTps);
    get('speed-turn-row').hidden=value?.tps!=null||value?.turnTps==null;
    const known=value&&['replyMs','toolMs','ttftMs','tps','turnTps'].some(k=>value[k]!=null);
    get('speed-status').textContent=problem||(pending&&!known?'正在读取…':!known?'此对话暂无速度记录。':
      value.tps!=null?'TPS 按已报告的输出 token 和首段至消息结束的用时估算。':value.turnTps!=null?'整轮均速包含工具和等待时间。':'按有记录的时段统计。')+
      (value?.partialHistory&&value.ttftMs!=null?' TTFT 取最近可读取的记录。':'');
  }
  function refresh(history=true){
    if(!threadId)return;
    clearTimeout(timer);timer=null;
    if(pending){queued=Boolean(queued||history);return;}
    const id=threadId,task=Promise.resolve().then(()=>read(id,history));
    pending=task;draw();
    task.then(result=>{if(pending===task){value=result;problem='';}},()=>{if(pending===task)problem='速度统计暂时无法读取。';}).finally(()=>{
      if(pending!==task)return;
      pending=null;draw();
      if(queued!==null){const history=queued;queued=null;refresh(history);}
    });
  }
  return {refresh,activity(item){
    if(threadId && !timer && (popover.open || item?.type==='agentMessage'))timer=setTimeout(()=>refresh(false),1000);
  },close:popover.close,get open(){return popover.open;},select(id){
    if(id===threadId)return;
    clearTimeout(timer);timer=null;popover.close();threadId=id;pending=null;queued=null;value=null;problem='';
    button.classList.toggle('hidden',!id);draw();if(id)refresh();
  }};
}
