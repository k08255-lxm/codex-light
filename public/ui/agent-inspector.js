import {nativeAgents,agentLifecycle,agentAvatar,agentDisplayMetadata} from './agents.js';
import {dshStatusLabel} from '../dsh.js';
import {renderMarkdown} from '../markdown.js';
import {boundedText,ItemStore} from '../store.js';
import {icon} from '../icons.js';
import {renderActivityRecord,renderCompactionRecord,describeItem,itemState} from '../activity-feed.js';
import {readAgentThread} from '../agent-history.js';
import {asyncInputDefinition,asyncInputBodyText,createAsyncInputCard} from './async-input.js';

// One list, one detail view, one scrolling parent. Reads happen only on opening or refreshing.
export function createAgentInspector({document,state,host,dshTasks,dshLive,rpc,readDshTask,el,onAnswerAsync,artifactFactory}){
 const cache=new Map();let selected=null,scope=null;
 const asyncInputs=new Map();
 const readQueue=[];
 let readGeneration=0,activeReads=0,nextRefresh=0;
 const visible=()=>document.visibilityState!=='hidden'&&!host.closest('.hidden');
 const expandedTools=new Set();
 const scroller=host.closest('.inspector-body')||host.parentElement;
 const name=row=>row.native?(row.path?.split('/').filter(Boolean).at(-1)||row.id.slice(0,12)):(row.name||row.agentId);
 const identity=row=>row.native?`native:${row.id}`:`dsh:${row.agentId}`;
 function metadata(row){const value=agentDisplayMetadata(row);const node=el('span','agent-model-meta',value.parts.join(' · '));node.title=value.title;return node;}
 const lifecycle=row=>row.native?agentLifecycle(row):{label:row.status?dshStatusLabel(row):'状态未知',tone:/fail|error/.test(row.status)?'fail':/complete|done|success/.test(row.status)?'ok':/run|start|pending|interrupting/.test(row.status)?'run':'idle'};
 function stamp(value){if(value===null||value===undefined||value==='')return null;const numeric=Number(value);const ms=Number.isFinite(numeric)?numeric*(Math.abs(numeric)<1e11?1000:1):Date.parse(value);return Number.isFinite(ms)?ms:null;}
 function rows(){
  const native=nativeAgents(state.store.values()).map(row=>({...row,native:true}));
  for(const row of native){const saved=cache.get(`${scope}:${row.id}`)?.thread;const last=saved?.turns?.at(-1);if(saved){row.actualModel=saved.model;row.actualEffort=saved.reasoningEffort;row.actualProvider=saved.modelProvider;}if(last&&(!row.lastSeenMs||(cache.get(`${scope}:${row.id}`)?.checkedAt||0)>=row.lastSeenMs)){const mapped={completed:'completed',interrupted:'interrupted',failed:'errored',inProgress:'running'}[last.status];if(mapped){row.state=mapped;row.life=null;row.life=agentLifecycle({...row,life:null,state:mapped});row.life={...row.life,...({completed:{label:'已完成',tone:'ok'},interrupted:{label:'已中断',tone:'stop'},errored:{label:'出错',tone:'fail'},running:{label:'运行中',tone:'run'}}[mapped])};}if(last.startedAt!=null)row.firstSeenMs=stamp(last.startedAt);if(last.completedAt!=null)row.lastSeenMs=stamp(last.completedAt);const messages=(last.items||[]).filter(item=>item.type==='agentMessage');if(messages.length)row.message=messages.at(-1).text||row.message;}}
  return [...native,...dshTasks.values().filter(row=>row.threadId===state.thread?.id&&row.agentId)].sort((a,b)=>Number(lifecycle(b).tone==='run')-Number(lifecycle(a).tone==='run')||((b.native?b.lastSeenMs:stamp(b.updated_at))||0)-((a.native?a.lastSeenMs:stamp(a.updated_at))||0));
 }
 function runStart(row){const explicit=stamp(row.started_at);if(explicit!==null)return explicit;const dispatch=Number(row.runStartedAtMs);if(Number.isFinite(dispatch)&&dispatch>0)return dispatch;return row.runStartedFromFollowup?null:stamp(row.created_at);}
 function duration(row){
  const running=lifecycle(row).tone==='run',start=row.native?row.firstSeenMs:runStart(row),end=running?Date.now():row.native?row.lastSeenMs:stamp(row.updated_at);
  const text=el('span','agent-runtime');text.title='基于已报告的开始与结束时间';
  if(start===null||start===undefined||end===null||end===undefined||end<start){text.textContent='时长不详';text.title='未提供可靠的开始或结束时间';return text;}
  text.dataset.start=String(start);text.dataset.end=String(end);text.dataset.running=String(running);updateDuration(text);return text;
 }
 function updateDuration(node){const start=Number(node.dataset.start),running=node.dataset.running==='true',end=running?Date.now():Number(node.dataset.end);const total=Math.max(0,Math.floor((end-start)/1000)),hours=Math.floor(total/3600),minutes=Math.floor(total%3600/60),seconds=total%60;node.textContent=`${running?'运行':'用时'} ${hours?hours+'h':''}${minutes||hours?minutes+'m':''}${seconds}s`;}
 const clockTimer=setInterval(()=>{
  if(!visible())return;
  for(const node of host.querySelectorAll('.agent-runtime[data-running="true"]'))updateDuration(node);
  if(Date.now()>=nextRefresh)hydrate();
 },1000);
 clockTimer?.unref?.();
 function markdown(text,cwd){const body=el('div','agent-markdown');body.append(renderMarkdown(document,boundedText(text,65536),{cwd:cwd||state.thread?.cwd||state.cwd,complete:true}));return body;}
 function toolRecord(item,key,artifacts){const record=renderActivityRecord(document,item,{artifacts});record.open=expandedTools.has(`${scope}:${key}`);record.addEventListener('toggle',()=>{if(!record.isConnected)return;const id=`${scope}:${key}`;if(record.open)expandedTools.add(id);else expandedTools.delete(id);});return record;}
 function object(value){if(value&&typeof value==='object'&&!Array.isArray(value))return value;if(typeof value==='string'&&value.length<=65536){try{const parsed=JSON.parse(value);return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:null;}catch{}}return null;}
 function eventRecord(event){
  const data=object(event.details)||object(event.data)||object(event.content)||{};
  const call=object(data.call)||object(data.tool_call)||data;
  const args=object(call.arguments)||object(call.args)||object(call.input)||{};
  const command=call.command||args.command||args.cmd;
  const status=call.status||(/error|fail/i.test(event.type)?'failed':/start|running/i.test(event.type)?'inProgress':'completed');
  const changes=call.changes||args.changes;
  if(Array.isArray(changes))return {type:'fileChange',status,changes};
  if(typeof command==='string')return {type:'commandExecution',status,command,aggregatedOutput:event.text||call.output||'',exitCode:call.exit_code??call.exitCode,durationMs:call.durationMs,commandActions:call.commandActions};
  return {type:'dynamicToolCall',status,tool:String(call.name||call.tool||event.type||'工具'),arguments:call.arguments||call.args||call.input||event.details,result:event.text||event.summary||''};
 }
 function heading(row){const head=el('div','agent-row-head'),title=el('strong','agent-row-name',name(row)),life=lifecycle(row);title.title=row.path||row.name||row.id||row.agentId;const status=el('span','agent-state',life.label);status.dataset.tone=life.tone;head.append(title,status,duration(row));return head;}
 function entry(row){const button=el('button','agent-row');button.type='button';button.dataset.agentId=row.id||row.agentId;button.append(agentAvatar(document,row.id||row.agentId));const content=el('span','agent-row-copy');content.append(heading(row),metadata(row));const latest=row.native?row.message||row.prompt:row.progress||row.last_event||row.mcpProgress||row.partial_text||row.answer;if(latest){const line=el('span','agent-row-progress',String(latest).split(/\r?\n/).filter(Boolean).at(-1));line.title=boundedText(latest,1000);content.append(line);}button.append(content,icon(document,'right',{size:14}));button.addEventListener('click',()=>open(row.id||row.agentId,row.native?'native':'dsh'));return button;}
 function readNative(row,force=false){queueRead(row,force);}
 function queueRead(row,force=false){
  if(!scope||!state.connected||!visible())return;
  const key=`${scope}:${row.native?row.id:'dsh:'+row.agentId}`;
  let saved=cache.get(key);
  if(!saved){saved={thread:null,loading:false,queued:false,error:'',checkedAt:0,observed:''};cache.set(key,saved);}
  if(saved.loading||saved.queued)return;
  const active=lifecycle(row).tone==='run';
  const changed=row.native?(row.lastSeenMs||0)>saved.checkedAt:String(row.updated_at||'')!==saved.observed;
  const interval=saved.error?15000:5000;
  if(!force&&saved.checkedAt&&!changed&&!saved.error&&(!active||Date.now()-saved.checkedAt<interval))return;
  if(!force&&saved.error&&Date.now()-saved.checkedAt<interval)return;
  saved.queued=true;
  readQueue.push({row,saved,scope,generation:readGeneration});
  pumpReads();
 }
 function pumpReads(){
  while(activeReads<2&&readQueue.length){
   const job=readQueue.shift();
   if(job.generation!==readGeneration||job.scope!==scope||!state.connected||!visible()){job.saved.queued=false;continue;}
   activeReads++;job.saved.queued=false;job.saved.loading=true;
   readAgent(job).finally(()=>{activeReads--;pumpReads();});
  }
 }
 async function readAgent(job){
  const {row,saved}=job;
  try{
   if(row.native){
    const snapshot=await readAgentThread(rpc,row.id,{isCurrent:()=>job.generation===readGeneration&&job.scope===state.thread?.id});
    if(job.generation!==readGeneration||job.scope!==state.thread?.id)return;
    saved.imageStore??=new ItemStore(1000);
    saved.artifacts?.clear();
    if(!saved.artifacts&&artifactFactory)saved.artifacts=artifactFactory({threadId:row.id,resolveImage:(itemId,slot)=>saved.imageStore.image(itemId,slot)});
    saved.imageStore.clear();
    saved.thread={...snapshot.thread,turns:snapshot.thread.turns.map(turn=>({...turn,items:(turn.items||[]).map(item=>{saved.imageStore.upsert(item);return saved.imageStore.items.get(item.id);})}))};saved.complete=snapshot.complete;
   }else{
    await readDshTask(row.agentId);
    if(job.generation!==readGeneration||job.scope!==state.thread?.id)return;
    const failure=state.dshReadErrors.get(`${job.scope}:${row.agentId}`);
    if(failure)throw new Error(failure);
   }
   saved.error='';
   saved.observed=String((!row.native?dshTasks.values().find(task=>task.agentId===row.agentId)?.updated_at:null)||row.updated_at||'');
  }catch(error){
   if(job.generation===readGeneration)saved.error=error.message||String(error);
  }finally{
   saved.loading=false;saved.checkedAt=Date.now();
   if(job.generation===readGeneration&&job.scope===state.thread?.id)render();
  }
 }
 function hydrate(){
  if(!visible()||!state.connected||scope!==state.thread?.id)return;
  nextRefresh=Date.now()+5000;
  for(const row of rows())queueRead(row);
 }
 function appendSequence(body,items,key,cwd,running,threadId=null,artifacts=null){
  let operations=[];
  const flush=tail=>{
   if(!operations.length)return;
   const batch=operations;operations=[];
   const active=tail&&running&&batch.some(item=>itemState(item)==='running');
   const id=`${scope}:${key}:group:${batch[0].id}`;
   const group=el('details','agent-operation-group');group.open=expandedTools.has(id);group.dataset.running=String(active);
   group.addEventListener('toggle',()=>{if(!group.isConnected)return;if(group.open)expandedTools.add(id);else expandedTools.delete(id);});
   const summary=el('summary','agent-operation-summary');
   summary.append(el('span','',`${batch.length} 项操作${active?' · 运行中':''}`));
   if(active)summary.append(el('span','agent-operation-latest',describeItem(batch.at(-1)).verb));
   summary.append(icon(document,'down',{size:14}));group.append(summary);
   const list=el('div','agent-operation-items');
   for(const item of batch){const record=toolRecord(item,`${key}:item:${item.id}`,artifacts);record.dataset.running=String(active&&itemState(item)==='running');list.append(record);}
   group.append(list);body.append(group);
  };
  for(const item of items){
   if(item.type==='contextCompaction'){flush(false);body.append(renderCompactionRecord(document,item));continue;}
   if(!['agentMessage','userMessage'].includes(item.type)){operations.push(item);continue;}
   flush(false);
   const text=item.type==='agentMessage'?asyncInputBodyText(item,item.text):(item.content||[]).filter(part=>part.type==='text').map(part=>part.text).join('\n');
   if(text){const content=markdown(text,cwd);if(item.type==='userMessage')content.classList.add('agent-user-input');body.append(content);}
   if(asyncInputDefinition(item)){
    const inputKey=JSON.stringify([threadId,item.id]);let input=asyncInputs.get(inputKey);
    if(!input){input=createAsyncInputCard(document,item,{threadId,onAnswerAsync});asyncInputs.set(inputKey,input);}
    else input.update(item,{threadId,onAnswerAsync});
    body.append(input.node);
   }
  }
  flush(true);
 }
 function renderNativeDetail(row,body){
  const saved=cache.get(`${scope}:${row.id}`);
  if(saved?.error)body.append(el('p','inline-error',saved.error));
  if(!saved?.thread){
   if(row.prompt){const input=markdown(row.prompt);input.classList.add('agent-user-input');body.append(input);}
   if(row.message)body.append(markdown(row.message));
   if(!body.children.length)body.append(el('p','muted',saved?.loading||saved?.queued?'正在读取…':'尚无内容'));
   return;
  }
  const items=saved.thread.turns.flatMap(turn=>turn.items||[]);
  if(items.length>100)body.append(el('p','muted','显示最近 100 条记录'));
  appendSequence(body,items.slice(-100),row.id,saved.thread.cwd,lifecycle(row).tone==='run',row.id,saved.artifacts);
 }
 function renderDshDetail(row,body){
  const snapshot=dshLive.snapshot();
  const live=snapshot.selectedAgentId===row.agentId?snapshot.selected:null;
  const finalText=live?.final_text||row.finalText||live?.answer||row.answer||'';
  const events=(live?.events||row.liveEvents||[]).slice(-100);
  const items=events.map((event,index)=>{
   const id=String(event.event_id||event.seq||index);
   if(/tool|command|function|file.?change/i.test(event.type)||event.details||object(event.text)||object(event.summary))return {...eventRecord(event),id};
   return {id,type:'agentMessage',text:event.text||event.summary||''};
  });
  if(row.prompt||row.task){const task=markdown(row.prompt||row.task);task.classList.add('agent-user-input');body.append(task);}
  appendSequence(body,items,row.agentId,row.cwd,lifecycle(row).tone==='run');
  if(finalText&&!items.some(item=>item.type==='agentMessage'&&item.text===finalText))body.append(markdown(finalText));
  if(!events.length&&!finalText){
   const text=live?.partial_text||row.partial_text||live?.progress||row.progress;
   if(text)body.append(markdown(text));
  }
  for(const error of new Set([row.error,row.callError,live?.event_error,live?.status_error,state.dshReadErrors.get(`${scope}:${row.agentId}`)].filter(Boolean)))body.append(el('p','inline-error',boundedText(error,2000)));
  if(live?.has_more||live?.syncing_history)body.append(el('p','muted','事件记录尚未完整'));
  if(!body.children.length)body.append(el('p','muted','尚无内容'));
 }
 function render(){
  const thread=state.thread?.id||null;
  if(scope!==thread){
   scope=thread;selected=null;readGeneration++;nextRefresh=0;
   readQueue.length=0;for(const saved of cache.values()){saved.artifacts?.clear();saved.imageStore?.clear();}cache.clear();expandedTools.clear();
  }
  const list=rows(),row=list.find(value=>identity(value)===selected);
  host.closest('.inspector')?.classList.toggle('agent-detail-mode',!!row);
  const scroll=scroller.scrollTop;
  const focused=document.activeElement;
  const action=host.contains(focused)?focused.dataset.agentAction:null;
  for(const strip of host.querySelectorAll('.artifact-strip'))strip.release?.();
  host.replaceChildren();
  if(!row){
   selected=null;
   if(!list.length)host.append(el('p','muted','当前对话暂无子代理'));
   else for(const value of list)host.append(entry(value));
  }else{
   const toolbar=el('header','agent-detail-toolbar');
   const back=el('button','btn icon-only ghost');back.type='button';
   back.title='返回子代理列表';back.setAttribute('aria-label',back.title);back.dataset.agentAction='back';
   back.append(icon(document,'left',{size:17}));
   back.addEventListener('click',()=>{selected=null;dshLive.selectAgent(null);render();host.querySelector('button')?.focus();});
   const refresh=el('button','btn icon-only ghost');refresh.type='button';
   refresh.title='刷新';refresh.setAttribute('aria-label',refresh.title);refresh.dataset.agentAction='refresh';
   refresh.append(icon(document,'refresh',{size:16}));
   refresh.disabled=!state.connected;
   refresh.addEventListener('click',()=>{queueRead(row,true);if(!row.native)dshLive.selectAgent(row.agentId);});
   toolbar.append(back,agentAvatar(document,row.id||row.agentId),heading(row),refresh);
   const body=el('div','agent-detail-content');
   body.append(metadata(row));
   if(row.native)renderNativeDetail(row,body);else renderDshDetail(row,body);
   host.append(toolbar,body);
  }
  scroller.scrollTop=scroll;
  if(focused&&host.contains(focused))focused.focus({preventScroll:true});
  if(action)[...host.querySelectorAll('[data-agent-action]')].find(node=>node.dataset.agentAction===action)?.focus({preventScroll:true});
  hydrate();
 }
 function open(id,kind){
  if(scope!==(state.thread?.id||null))render();
  const row=rows().find(value=>(value.native?value.id:value.agentId)===id&&(!kind||(value.native?'native':'dsh')===kind));
  if(!row)return false;
  selected=identity(row);
  if(!row.native)dshLive.selectAgent(row.agentId);
  render();queueRead(row);scroller.scrollTop=0;host.querySelector('button')?.focus();
  return true;
 }
 function refresh(){for(const row of rows())queueRead(row,true);}
 return {render,open,refresh};
}
