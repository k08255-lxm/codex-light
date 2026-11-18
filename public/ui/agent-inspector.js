import {nativeAgents,agentLifecycle,agentAvatar,agentDisplayMetadata} from './agents.js';
import {dshStatusLabel} from '../dsh.js';
import {renderMarkdown} from '../markdown.js';
import {boundedText,ItemStore} from '../store.js';
import {icon} from '../icons.js';
import {renderActivityRecord,renderCompactionRecord,describeItem,itemState} from '../activity-feed.js';
import {AgentHistory,mergeAgentTurns} from '../agent-history.js';
import {asyncInputDefinition,asyncInputBodyText,createAsyncInputCard,asyncAnswerHistory} from './async-input.js';
import {captureHistoryAnchor,restoreHistoryAnchor,mountHistoryAutoLoad} from './history-auto-load.js';

// One list, one detail view, one scrolling parent. Reads happen only on opening or refreshing.
export function createAgentInspector({document,state,host,dshTasks,dshLive,rpc,readDshTask,el,onAnswerAsync,artifactFactory,onLocalLink}){
 const cache=new Map();let selected=null,scope=null,scopeServer=null,listScroll=0,olderRequest=null;
 const partKeys=new WeakMap();
 const asyncInputs=new Map();
 const readQueue=[];
 let readGeneration=0,activeReads=0,nextRefresh=0;
 const visible=()=>document.visibilityState!=='hidden'&&!host.closest('.hidden');
 const expandedTools=new Set();
 const scroller=host.closest('.inspector-body')||host.parentElement;
 const earlier=el('button','btn subtle agent-history-older','加载更早的任务');earlier.type='button';
 const historyStatus=el('p','muted agent-history-status');historyStatus.setAttribute('role','status');
 const historyControls=el('div','agent-history-controls');historyControls.append(earlier,historyStatus);
 const historyLoader=mountHistoryAutoLoad({container:scroller,button:earlier,status:historyStatus,
  label:'加载更早的任务',endLabel:'已到任务历史开头',getKey:()=>`${scopeServer}:${scope}:${selected}`,
  canLoad:()=>state.connected&&visible()&&!!selected&&(selected.startsWith('native:')?
   cache.get(`${scope}:${selected.slice(7)}`)?.history?.hasOlder:
   dshLive.snapshot().selected?.has_older===true),load:loadOlder});
 function renderParts(parent,draw){
  const previous=new Map([...parent.children].map(node=>[partKeys.get(node)?.key,node]));
  const next=[];
  const part=(key,make,version=null)=>{
   const old=previous.get(key),node=old&&partKeys.get(old).version===version?old:make();
   partKeys.set(node,{key,version});next.push(node);return node;
  };
  draw(part);
  const retained=new Set(next);
  for(const node of [...parent.children])if(!retained.has(node)){
   for(const strip of node.querySelectorAll('.artifact-strip'))strip.release?.();
   node.remove();
  }
  next.forEach((node,index)=>{if(parent.children[index]!==node)parent.insertBefore(node,parent.children[index]||null);});
 }
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
 function markdown(text,cwd,threadId=state.thread?.id){const body=el('div','agent-markdown');const directory=cwd||(threadId===state.thread?.id?state.thread?.cwd||state.cwd:'');body.append(renderMarkdown(document,boundedText(text,65536),{cwd:directory,complete:true,...(onLocalLink?{onLocalLink:(ref,node)=>onLocalLink(ref,node,threadId)}:{})}));return body;}
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
  readQueue.push({row,saved,scope,server:scopeServer,generation:readGeneration});
  pumpReads();
 }
 function pumpReads(){
  while(activeReads<2&&readQueue.length){
   const job=readQueue.shift();
   if(job.generation!==readGeneration||job.scope!==scope||job.server!==state.serverInstance||!state.connected||!visible()){job.saved.queued=false;continue;}
   activeReads++;job.saved.queued=false;job.saved.loading=true;
   readAgent(job).finally(()=>{activeReads--;pumpReads();});
  }
 }
 async function readAgent(job){
  const {row,saved}=job;
  try{
   if(row.native){
    saved.history??=new AgentHistory(rpc,row.id,()=>job.generation===readGeneration&&job.scope===state.thread?.id&&job.server===state.serverInstance);
    const snapshot=await saved.history.newest();
    if(job.generation!==readGeneration||job.scope!==state.thread?.id||job.server!==state.serverInstance)return;
    mergeNative(saved,row.id,snapshot.thread,snapshot.turns);
   }else{
    await readDshTask(row.agentId);
    if(job.generation!==readGeneration||job.scope!==state.thread?.id||job.server!==state.serverInstance)return;
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
 function mergeNative(saved,id,thread,turns,older=false){
  saved.imageStore??=new ItemStore(Infinity,{preserveBodies:true});
  if(!saved.artifacts&&artifactFactory)saved.artifacts=artifactFactory({threadId:id,resolveImage:(itemId,slot)=>saved.imageStore.image(itemId,slot)});
  const clean=turns.map(turn=>({...turn,items:(turn.items||[]).filter(item=>item?.id).map(item=>{
   if(!older||!saved.imageStore.items.has(item.id))saved.imageStore.upsert(item);
   return saved.imageStore.items.get(item.id);
  }).filter(Boolean)}));
  saved.thread={...saved.thread,...thread,turns:mergeAgentTurns(saved.thread?.turns||[],clean,{older})};
 }
 async function loadOlder(){
  const active=selected,owner=scope,server=scopeServer,generation=readGeneration;
  const request={active,owner,server};olderRequest=request;
  try{
   if(active?.startsWith('native:')){
    const id=active.slice(7),saved=cache.get(`${scope}:${id}`);
    const turns=await saved.history.older();
    if(owner!==scope||server!==scopeServer||generation!==readGeneration)return;
    mergeNative(saved,id,saved.history.thread,turns,true);
   }else await dshLive.loadOlder?.();
   if(owner===scope&&server===scopeServer&&active===selected)render({older:true});
  }finally{if(olderRequest===request)olderRequest=null;}
 }
 function hydrate(){
  if(!visible()||!state.connected||scope!==state.thread?.id)return;
  nextRefresh=Date.now()+5000;
  for(const row of rows())queueRead(row);
 }
 function appendSequence(part,items,key,cwd,running,threadId=null,artifacts=null,history=null){
  let operations=[];
  const flush=tail=>{
   if(!operations.length)return;
   const batch=operations;operations=[];
   const active=tail&&running&&batch.some(item=>itemState(item)==='running');
   const groupKey=`${key}:group:${batch[0].id}`,id=`${scope}:${groupKey}`;
   const group=part(groupKey,()=>{
    const node=el('details','agent-operation-group');node.open=expandedTools.has(id);
    node.addEventListener('toggle',()=>{if(!node.isConnected)return;if(node.open)expandedTools.add(id);else expandedTools.delete(id);});
    const summary=el('summary','agent-operation-summary');
    summary.append(el('span',''),el('span','agent-operation-latest'),icon(document,'down',{size:14}));
    node.append(summary,el('div','agent-operation-items'));node.dataset.itemId=groupKey;return node;
   });
   group.dataset.running=String(active);
   const summary=group.children[0],latest=summary.children[1];
   const title=`${batch.length} 项操作${active?' · 运行中':''}`;
   if(summary.children[0].textContent!==title)summary.children[0].textContent=title;
   latest.hidden=!active;const verb=active?describeItem(batch.at(-1)).verb:'';
   if(latest.textContent!==verb)latest.textContent=verb;
   renderParts(group.children[1],emit=>{
    for(const item of batch){
     const itemKey=`${key}:item:${item.id}`;
     const record=emit(itemKey,()=>toolRecord(item,itemKey,artifacts),JSON.stringify(item));
     record.dataset.itemId=itemKey;record.dataset.running=String(active&&itemState(item)==='running');
    }
   });
  };
  for(const item of items){
   if(history?.echoes.has(item.id))continue;
   const itemKey=`${key}:item:${item.id}`;
   if(item.type==='contextCompaction'){flush(false);part(itemKey,()=>renderCompactionRecord(document,item),JSON.stringify(item));continue;}
   if(!['agentMessage','userMessage'].includes(item.type)){operations.push(item);continue;}
   flush(false);
   const text=item.type==='agentMessage'?asyncInputBodyText(item,item.text):(item.content||[]).filter(part=>part.type==='text').map(part=>part.text).join('\n');
   if(text)part(itemKey,()=>{const content=markdown(text,cwd,threadId||state.thread?.id);if(item.type==='userMessage')content.classList.add('agent-user-input');content.dataset.itemId=itemKey;return content;},JSON.stringify([item.type,cwd,text]));
   if(asyncInputDefinition(item)){
    const inputKey=JSON.stringify([threadId,item.id]);let input=asyncInputs.get(inputKey);
    const options={threadId,onAnswerAsync,confirmedAnswers:history?.answered.get(item.id)};
    if(!input){input=createAsyncInputCard(document,item,options);asyncInputs.set(inputKey,input);}
    else input.update(item,options);
    part(`${itemKey}:input`,()=>input.node);
   }
  }
  flush(true);
 }
 function renderNativeDetail(row,part){
  const saved=cache.get(`${scope}:${row.id}`);
  if(saved?.error)part('native-error',()=>el('p','inline-error',saved.error),saved.error);
  if(!saved?.thread){
   if(row.prompt)part('prompt',()=>{const input=markdown(row.prompt,row.cwd,row.id);input.classList.add('agent-user-input');return input;},JSON.stringify([row.cwd,row.prompt]));
   if(row.message)part('native-preview',()=>markdown(row.message,row.cwd,row.id),JSON.stringify([row.cwd,row.message]));
   if(!row.prompt&&!row.message&&!saved?.error){const text=saved?.loading||saved?.queued?'正在读取…':'尚无内容';part('empty',()=>el('p','muted',text),text);}
   return;
  }
  const turns=saved.thread.turns,history=asyncAnswerHistory(turns,row.id);
  if(!turns.length)part('empty-native-history',()=>el('p','muted','尚未读取到任务记录'));
  for(const turn of turns){
   const visible=turn.items||[];
   const group=part(`turn:${turn.id}`,()=>{const node=el('section','agent-run');node.dataset.turnId=turn.id;return node;});
   renderParts(group,emit=>{
    emit('heading',()=>{
     const head=el('header','agent-run-heading'),title=el('strong','',turn.id==='unattributed'?'任务记录（未提供轮次）':`任务 ${turn.ordinal||turn.id.slice(0,8)}`);title.title=turn.id;head.append(title,el('span','',({inProgress:'进行中',completed:'已完成',failed:'失败',interrupted:'已停止'})[turn.status]||''));
     const started=stamp(turn.startedAt);if(started!==null){const time=el('time','',new Date(started).toLocaleString());time.dateTime=new Date(started).toISOString();head.append(time);}
     return head;
    },JSON.stringify([turn.ordinal,turn.status,turn.startedAt]));
    appendSequence(emit,visible,`${row.id}:${turn.id}`,saved.thread.cwd,turn.status==='inProgress',row.id,saved.artifacts,history);
   });
  }
 }
 function renderDshDetail(row,part){
  const snapshot=dshLive.snapshot();
  const live=snapshot.selectedAgentId===row.agentId?snapshot.selected:null;
  const finalText=live?.final_text||row.finalText||live?.answer||row.answer||'';
  const events=live?.events?.length?live.events:row.liveEvents||[];
  const toItem=(event,index)=>{
   const id=String(event.event_id||event.seq||index);
   if(event.type==='user/message')return {id,type:'userMessage',content:[{type:'text',text:event.text||''}]};
   if(/tool|command|function|file.?change/i.test(event.type)||event.details||object(event.text)||object(event.summary))return {...eventRecord(event),id};
   return {id,type:'agentMessage',text:event.text||event.summary||''};
  };
  const items=events.map(toItem);
  const prompt=row.prompt||row.task;
  if(prompt&&!events.some(event=>event.type==='user/message'))part('prompt',()=>{const node=markdown(prompt,row.cwd);node.classList.add('agent-user-input');return node;},JSON.stringify([row.cwd,prompt]));
  const groups=[];
  for(const [index,event]of events.entries()){
   const task=Number.isSafeInteger(event.taskTurn)&&event.taskTurn>0?event.taskTurn:null;
   let group=groups.at(-1);
   if(!group||group.task!==task){
    group={task,id:task&&!groups.some(value=>value.task===task)?`turn:${task}`:`event:${items[index].id}`,items:[],status:''};groups.push(group);
   }
   group.items.push(items[index]);
   if(event.taskStatus)group.status=event.taskStatus;
  }
  for(const [index,group]of groups.entries()){
   const section=part(`task:${group.id}`,()=>{const node=el('section','agent-run');node.dataset.taskTurn=String(group.task??'unknown');node.dataset.turnId=`dsh:${row.agentId}:${group.id}`;return node;});
   renderParts(section,emit=>{
    emit('heading',()=>{const head=el('header','agent-run-heading');head.append(el('strong','',group.task?`任务 ${group.task}`:'任务记录（未提供轮次）'));if(group.status)head.append(el('span','',dshStatusLabel({status:group.status})));return head;},group.status);
    appendSequence(emit,group.items,`${row.agentId}:run:${group.id}`,row.cwd,index===groups.length-1&&lifecycle(row).tone==='run');
   });
  }
  if(finalText&&!items.some(item=>item.type==='agentMessage'&&item.text===finalText))part('result',()=>markdown(finalText,row.cwd),JSON.stringify([row.cwd,finalText]));
  let progress;
  if(!events.length&&!finalText){
   progress=live?.partial_text||row.partial_text||live?.progress||row.progress;
   if(progress)part('progress',()=>markdown(progress,row.cwd),JSON.stringify([row.cwd,progress]));
  }
  const errors=new Set([row.error,row.callError,live?.event_error,live?.status_error,state.dshReadErrors.get(`${scope}:${row.agentId}`)].filter(Boolean));
  for(const error of errors)part(`error:${error}`,()=>el('p','inline-error',boundedText(error,2000)));
  const incomplete=live?.has_more||live?.syncing_history;
  if(incomplete)part('incomplete',()=>el('p','muted','正在同步任务事件'));
  if(live?.history_supported===false)part('history-source',()=>el('p','muted','此 DSH 桥仅支持顺序读取，旧任务正在按记录补齐。'));
  if(!events.length&&!prompt&&!finalText&&!progress&&!errors.size&&!incomplete)part('empty',()=>el('p','muted','尚无内容'));
 }
 function render({older=false}={}){
  const thread=state.thread?.id||null;
  if(scope!==thread||scopeServer!==state.serverInstance){
   scope=thread;scopeServer=state.serverInstance;selected=null;listScroll=0;readGeneration++;nextRefresh=0;historyLoader.reset();
   readQueue.length=0;for(const saved of cache.values()){saved.artifacts?.clear();saved.imageStore?.clear();}cache.clear();expandedTools.clear();
  }
  const list=rows(),row=list.find(value=>identity(value)===selected);
  const previousView=host.firstElementChild;
  const sameDetail=!!row&&partKeys.get(previousView)?.key===`toolbar:${selected}`;
  const loadingOlder=olderRequest?.active===selected&&olderRequest.owner===scope&&olderRequest.server===scopeServer;
  const follow=sameDetail&&!older&&!loadingOlder&&scroller.scrollHeight-scroller.clientHeight-scroller.scrollTop<48;
  const anchor=sameDetail&&!follow?captureHistoryAnchor(scroller):null;
  host.closest('.inspector')?.classList.toggle('agent-detail-mode',!!row);
  const focused=document.activeElement;
  const focusedItem=host.contains(focused)?focused?.closest?.('[data-item-id]')?.dataset.itemId:null;
  renderParts(host,part=>{
   if(!row){
    selected=null;
    if(!list.length)part('empty-list',()=>el('p','muted','当前对话暂无子代理'));
    for(const value of list)part(identity(value),()=>entry(value),JSON.stringify(value));
    return;
   }
   const toolbar=part(`toolbar:${selected}`,()=>{
    const node=el('header','agent-detail-toolbar');
    const previous=el('button','btn icon-only ghost');previous.type='button';
    previous.title='返回子代理列表';previous.setAttribute('aria-label',previous.title);previous.dataset.agentAction='back';
    previous.append(icon(document,'left',{size:17}));previous.addEventListener('click',back);
    const refresh=el('button','btn icon-only ghost');refresh.type='button';
    refresh.title='刷新';refresh.setAttribute('aria-label',refresh.title);refresh.dataset.agentAction='refresh';
    refresh.append(icon(document,'refresh',{size:16}));
    refresh.addEventListener('click',()=>{
     const current=rows().find(value=>identity(value)===selected);
     if(current){queueRead(current,true);if(!current.native)dshLive.selectAgent(current.agentId);}
    });
    node.append(previous,agentAvatar(document,row.id||row.agentId),heading(row),refresh);return node;
   });
   const headingVersion=JSON.stringify([name(row),row.path,lifecycle(row),row.firstSeenMs,row.lastSeenMs,row.started_at,row.updated_at,row.runStartedAtMs]);
   if(toolbar._headingVersion!==headingVersion){toolbar.children[2].replaceWith(heading(row));toolbar._headingVersion=headingVersion;}
   toolbar.children[3].disabled=!state.connected;
   const body=part(`body:${selected}`,()=>el('div','agent-detail-content'));
   renderParts(body,emit=>{
    const hasOlder=row.native?cache.get(`${scope}:${row.id}`)?.history?.hasOlder:dshLive.snapshot().selected?.has_older;
    if(hasOlder||historyStatus.textContent)emit('history-controls',()=>historyControls);
    earlier.hidden=!hasOlder;
    emit('metadata',()=>metadata(row),JSON.stringify(agentDisplayMetadata(row)));
    if(row.native)renderNativeDetail(row,emit);else renderDshDetail(row,emit);
   });
  });
  if(anchor)restoreHistoryAnchor(scroller,anchor);else if(follow)scroller.scrollTop=scroller.scrollHeight;
  if(focusedItem&&!host.contains(focused)){
   const replacement=[...host.querySelectorAll('[data-item-id]')].find(node=>node.dataset.itemId===focusedItem);
   replacement?.querySelector('summary,button')?.focus({preventScroll:true});
  }
  hydrate();
 }
 function isDetailOpen(){return !!selected&&scope===(state.thread?.id||null);}
 function back(){
  if(!isDetailOpen())return false;
  const previous=selected;selected=null;historyLoader.reset();
  if(previous.startsWith('dsh:'))dshLive.selectAgent(null);
  render();scroller.scrollTop=listScroll;
  const target=[...host.querySelectorAll('.agent-row')].find(node=>partKeys.get(node)?.key===previous)||host.querySelector('button');
  target?.focus({preventScroll:true});return true;
 }
 function open(id,kind){
  if(scope!==(state.thread?.id||null))render();
  const row=rows().find(value=>(value.native?value.id:value.agentId)===id&&(!kind||(value.native?'native':'dsh')===kind));
  if(!row)return false;
  const previous=selected;if(!previous)listScroll=scroller.scrollTop;
  selected=identity(row);if(previous!==selected)historyLoader.reset();
  if(!row.native)dshLive.selectAgent(row.agentId);else if(previous?.startsWith('dsh:'))dshLive.selectAgent(null);
  render();queueRead(row);scroller.scrollTop=scroller.scrollHeight;host.querySelector('button')?.focus({preventScroll:true});
  return true;
 }
 function refresh(){for(const row of rows())queueRead(row,true);}
 return {render,open,isDetailOpen,back,refresh};
}
