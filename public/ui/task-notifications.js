const validId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value);
const titleText=value=>Array.from(String(value||'Codex 任务').replace(/[\x00-\x1f\x7f]/g,' ')).slice(0,40).join('');

// Only current, confirmed turns are monitored. Reconnect snapshots never invent completion.
export function createTaskMonitor({post,title=()=>'',waiting=()=>false}){
  const tasks=new Map(),settled=new Set(),known=new Set();
  let connected=false,enabled=false;
  const key=(threadId,turnId)=>threadId+'\n'+turnId;
  function send(task){if(enabled){post({threadId:task.threadId,turnId:task.turnId,title:titleText(title(task.threadId)),state:task.state});known.add(task.threadId);if(known.size>1000)known.delete(known.values().next().value);}}
  function start(threadId,turnId){
    if(!validId(threadId)||!validId(turnId)||settled.has(key(threadId,turnId)))return;
    const old=tasks.get(threadId);
    if(old&&old.turnId!==turnId)remember(old);
    const task={threadId,turnId,state:connected?(waiting(threadId,turnId)?'waiting':'running'):'disconnected'};
    tasks.set(threadId,task);send(task);
    if(tasks.size>1000)tasks.delete(tasks.keys().next().value);
  }
  function remember(task){settled.add(key(task.threadId,task.turnId));if(settled.size>1000)settled.delete(settled.values().next().value);}
  function refresh(){
    for(const task of tasks.values()){
      if(task.state==='disconnected')continue;
      task.state=waiting(task.threadId,task.turnId)?'waiting':'running';send(task);
    }
  }
  return {
    setEnabled(value){enabled=value===true;if(enabled)refresh();},
    reconcile(rows,isConnected){
      connected=isConnected===true;
      const active=new Map(rows.filter(row=>validId(row?.threadId)&&validId(row?.activeTurnId)).map(row=>[row.threadId,row.activeTurnId]));
      // The server emits its idle session snapshot before the terminal turn event.
      // Stop the heartbeat, but retain identity so that event can still report its real outcome.
      for(const [threadId,task]of tasks)if(!active.has(threadId)&&task.state!=='disconnected'){task.state='disconnected';send(task);}
      for(const [threadId,turnId]of active)start(threadId,turnId);
    },
    observe(message){
      const p=message?.params||{},threadId=p.threadId,turnId=p.turn?.id;
      if(message?.method==='turn/started'){connected=true;start(threadId,turnId);}
      if(message?.method!=='turn/completed'||!validId(threadId)||!validId(turnId))return;
      const task=tasks.get(threadId);if(!task||task.turnId!==turnId)return;
      task.state=['completed','failed','interrupted'].includes(p.turn?.status)?p.turn.status:'disconnected';
      send(task);remember(task);tasks.delete(threadId);
    },
    disconnected(){connected=false;for(const task of tasks.values()){task.state='disconnected';send(task);}},
    refresh,
    reset(){for(const threadId of known)post({threadId,state:'idle'});tasks.clear();settled.clear();known.clear();connected=false;},
  };
}

export function mountTaskNotifications({document,window,snapshot,title,waiting,openThread,notice}){
  const bridge=window.CodexLightNative,panel=document.getElementById('mobile-task-notifications');
  if(!bridge||!['getTaskNotificationStatus','setTaskNotificationsEnabled','updateTaskNotification','openTaskNotificationSettings'].every(name=>typeof bridge[name]==='function'))return null;
  const toggle=document.getElementById('mobile-task-enabled'),status=document.getElementById('mobile-task-status');
  const monitor=createTaskMonitor({post:data=>bridge.updateTaskNotification(JSON.stringify(data)),title,waiting});
  let failed=false,pendingOpen=null,opening=false,lastOpenError=null;
  async function tryOpen(){
    if(!pendingOpen||opening||!snapshot().canOpen)return;
    const threadId=pendingOpen;opening=true;
    try{await openThread(threadId);bridge.taskNotificationOpened?.(threadId);if(pendingOpen===threadId)pendingOpen=null;lastOpenError=null;}
    catch(error){if(lastOpenError!==threadId){notice('无法打开通知对应的对话：'+error.message,true);lastOpenError=threadId;}}
    finally{opening=false;}
  }
  function report(error){monitor.setEnabled(false);status.textContent='任务通知同步失败：'+(error?.message||'原生接口不可用');if(!failed)notice(status.textContent,true);failed=true;}
  function run(action){try{action();}catch(error){report(error);}}
  function refreshStatus(){run(()=>{
    const result=JSON.parse(bridge.getTaskNotificationStatus());
    panel.hidden=result.supported!==true;if(panel.hidden){monitor.setEnabled(false);return;}
    toggle.checked=result.enabled===true;monitor.setEnabled(result.enabled===true&&result.reason==='ready');
    const labels={disabled:'开启后显示运行任务、等待处理和任务结果。',permission_required:'尚未获得系统通知权限，请在系统设置中允许。',channel_blocked:'任务通知渠道已关闭，请在系统设置中开启。'};
    status.textContent=labels[result.reason]||(result.promotedCandidate?'任务通知已开启。系统支持且允许时，运行状态可尝试显示为状态胶囊。':'任务通知已开启，使用系统通知栏显示任务状态。');failed=false;
  });}
  const reconcile=()=>run(()=>{const data=snapshot();monitor.reconcile(data.threads,data.connected);void tryOpen();});
  const refresh=()=>run(()=>{if(snapshot().connected)monitor.refresh();else monitor.disconnected();});
  toggle.addEventListener('change',()=>run(()=>{bridge.setTaskNotificationsEnabled(toggle.checked);}));
  document.getElementById('mobile-task-system-settings').addEventListener('click',()=>run(()=>bridge.openTaskNotificationSettings()));
  window.addEventListener('codexlight-task-notification-status',refreshStatus);
  window.addEventListener('focus',()=>{refreshStatus();void tryOpen();});
  window.CodexLightTaskNotifications={open(threadId){if(validId(threadId)){pendingOpen=threadId;void tryOpen();}}};
  refreshStatus();reconcile();
  window.setInterval(refresh,30000);
  return {observe:message=>run(()=>monitor.observe(message)),reconcile,refresh,disconnected:()=>run(()=>monitor.disconnected()),reset:()=>run(()=>{pendingOpen=null;monitor.reset();})};
}
