const validId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value);
const titleText=value=>Array.from(String(value||'Codex 任务').replace(/[\x00-\x1f\x7f]/g,' ')).slice(0,40).join('');

// Foreground and background consume the same server-confirmed task projection.
export function createTaskMonitor({post,title=()=>''}){
  const active=new Map(),settled=new Set(),known=new Set();
  let connected=false,enabled=false;
  const key=task=>task.threadId+'\n'+task.turnId;
  const valid=task=>validId(task?.threadId)&&validId(task?.turnId);
  function send(task){
    if(!enabled)return;
    const data={threadId:task.threadId,turnId:task.turnId,title:titleText(title(task.threadId)),state:task.state};
    if(task.phase)data.phase=task.phase;
    if(task.details && ['running','waiting'].includes(task.state))data.details=task.details;
    post(data);known.add(task.threadId);
    if(known.size>1000)known.delete(known.values().next().value);
  }
  function remember(id){settled.add(id);if(settled.size>1000)settled.delete(settled.values().next().value);}
  function refresh(){if(connected)for(const task of active.values())send(task);}
  function disconnected(){
    if(connected)for(const task of active.values())send({...task,state:'disconnected',phase:null});
    connected=false;
  }
  function apply({connected:live,running,finished,baseline=false}){
    if(!live){disconnected();return;}
    if(!Array.isArray(running)||!Array.isArray(finished))return;
    const next=new Map(running.filter(task=>valid(task)&&['running','waiting'].includes(task.state)).map(task=>[task.threadId,task]));
    const results=new Map();
    for(const task of finished){
      if(!valid(task)||!['completed','failed','interrupted'].includes(task.state))continue;
      const id=key(task),previous=active.get(task.threadId);
      if(!settled.has(id)&&!next.has(task.threadId)&&(!baseline||previous)){
        results.set(task.threadId,task);
      }
      remember(id);
    }
    for(const [threadId,task] of active){
      if(!next.has(threadId)&&!results.has(threadId)&&known.has(threadId)){
        post({threadId,state:'idle'});known.delete(threadId);
      }
      if(next.has(threadId)&&next.get(threadId).turnId!==task.turnId)remember(key(task));
    }
    for(const task of results.values())send(task);
    for(const [threadId,task] of next){
      const previous=active.get(threadId);
      if(!connected||previous?.turnId!==task.turnId||previous.state!==task.state||previous.phase!==task.phase||JSON.stringify(previous.details)!==JSON.stringify(task.details))send(task);
    }
    active.clear();for(const [id,task] of next)active.set(id,task);
    connected=true;
  }
  return {apply,refresh,disconnected,
    setEnabled(value){if(enabled===value)return;enabled=value===true;if(enabled)refresh();},
    reset(){for(const threadId of known)post({threadId,state:'idle'});active.clear();settled.clear();known.clear();connected=false;},
  };
}

export function mountTaskNotifications({document,window,snapshot,title,resolveTarget,openThread,notice}){
  const bridge=window.CodexLightNative,panel=document.getElementById('mobile-task-notifications');
  if(!bridge||!['getTaskNotificationStatus','setTaskNotificationsEnabled','updateTaskNotification','openTaskNotificationSettings'].every(name=>typeof bridge[name]==='function'))return null;
  const toggle=document.getElementById('mobile-task-enabled'),status=document.getElementById('mobile-task-status');
  const promotion=document.getElementById('mobile-task-promotion-status'),promotionSettings=document.getElementById('mobile-task-promotion-settings');
  const backgroundPanel=document.getElementById('mobile-task-background-panel'),background=document.getElementById('mobile-task-background'),backgroundStatus=document.getElementById('mobile-task-background-status');
  let supportsTaskPhase=false,supportsTaskDetails=false;
  const monitor=createTaskMonitor({post:data=>{
    if(!supportsTaskPhase)delete data.phase;
    if(!supportsTaskDetails)delete data.details;
    bridge.updateTaskNotification(JSON.stringify(data));
  },title});
  let failed=false,pendingOpen=null,opening=false,lastOpenError=null,wasReady=false;
  async function tryOpen(){
    if(!pendingOpen||opening||!snapshot().canOpen)return;
    const threadId=pendingOpen;opening=true;
    try{
      const target=await resolveTarget(threadId);
      if(pendingOpen!==threadId||!snapshot().canOpen)return;
      if(target!==threadId)bridge.updateTaskNotification(JSON.stringify({threadId,state:'idle'}));
      if(target)await openThread(target);
      else notice('这条任务通知对应的对话已隐藏、已归档或已不存在。');
      if(pendingOpen!==threadId)return;
      bridge.taskNotificationOpened?.(threadId);pendingOpen=null;lastOpenError=null;
    }
    catch(error){if(pendingOpen===threadId&&lastOpenError!==threadId){notice('无法打开通知对应的对话：'+error.message,true);lastOpenError=threadId;}}
    finally{opening=false;if(pendingOpen&&pendingOpen!==threadId)void tryOpen();}
  }
  function report(error){monitor.setEnabled(false);status.textContent='任务通知同步失败：'+(error?.message||'原生接口不可用');if(!failed)notice(status.textContent,true);failed=true;}
  function run(action){try{action();}catch(error){report(error);}}
  function refreshStatus(){run(()=>{
    const result=JSON.parse(bridge.getTaskNotificationStatus());
    supportsTaskPhase=result.supportsTaskPhase===true;
    supportsTaskDetails=result.supportsTaskDetails===true;
    panel.hidden=result.supported!==true;if(panel.hidden){monitor.setEnabled(false);return;}
    toggle.checked=result.enabled===true;monitor.setEnabled(result.enabled===true&&result.reason==='ready');
    const labels={disabled:'开启后显示运行任务、等待处理和任务结果。',permission_required:'尚未获得系统通知权限，请在系统设置中允许。',channel_blocked:'任务通知渠道已关闭，请在系统设置中开启。'};
    status.textContent=labels[result.reason]||result.taskSummary||'任务通知已开启。';failed=false;
    if(promotion){
      const messages = {
        promoted: 'Android 已将运行中的任务提升为实时通知。显示位置由手机系统决定。',
        standard: '运行中的任务已发到通知栏，系统暂未将它提升为实时通知。',
        ineligible: '运行中的任务已发到通知栏，当前系统判定这条通知不符合实时通知条件。',
        ready: '系统允许实时通知。开始任务后可在这里查看它是否已被提升。',
        blocked: '系统暂不允许码舱发送实时通知，可在「实时通知设置」中查看。',
        channel_min: '「任务状态」通知类别的重要性为最低，无法显示实时通知。可在「系统通知设置」中调整。',
        unsupported: 'Android 16 以下仅支持普通任务通知。'
      };
      promotion.hidden = result.promotion !== 'unsupported' && result.reason !== 'ready';
      promotion.textContent = promotion.hidden ? '' : messages[result.promotion] || (result.promotedCandidate
        ? '运行时由系统决定是否提升实时通知。' : '此设备使用普通任务通知。');
      if (promotionSettings) promotionSettings.hidden = !result.promotedCandidate || typeof bridge.openLiveUpdateSettings !== 'function';
    }
    if(backgroundPanel){
      backgroundPanel.hidden=typeof bridge.setBackgroundNotifications!=='function';
      const backgroundMessages={off:'后台同步已停止。深度休眠或离开可访问电脑的网络时，系统可能暂停同步。',connecting:'正在连接配对电脑…',active:'后台同步已连接。',engine_offline:'已连接电脑，等待 Codex 恢复。',network_error:'暂时无法访问配对电脑，正在重试。',unauthorized:'配对授权已失效，请重新连接电脑。',incompatible:'电脑版本不支持后台同步，请更新电脑端。',permission_required:'请先允许应用发送系统通知。',unavailable:'系统暂未启动后台同步，请回到应用后重试。',expired:'本次后台同步已结束，可再次开启。'};
      backgroundStatus.textContent=backgroundMessages[result.background]||backgroundMessages.off;
      background.checked=['connecting','active','engine_offline','network_error'].includes(result.background);
    }
  });}
  const reconcile=()=>{
    const ready=snapshot().canOpen===true,released=ready&&!wasReady;
    wasReady=ready;
    if(released)void tryOpen();
  };
  const refresh=()=>run(()=>{if(snapshot().connected)monitor.refresh();else monitor.disconnected();});
  toggle.addEventListener('change',()=>run(()=>{
    if(typeof bridge.setRealtimeNotifications==='function')
      bridge.setRealtimeNotifications(toggle.checked,document.getElementById('preference-approval')?.checked===true);
    else bridge.setTaskNotificationsEnabled(toggle.checked);
  }));
  document.getElementById('mobile-task-system-settings').addEventListener('click',()=>run(()=>bridge.openTaskNotificationSettings()));
  promotionSettings?.addEventListener('click',()=>run(()=>bridge.openLiveUpdateSettings?.()));
  background?.addEventListener('change',()=>run(()=>bridge.setBackgroundNotifications?.(background.checked,document.getElementById('preference-approval')?.checked===true)));
  window.addEventListener('codexlight-task-notification-status',refreshStatus);
  window.addEventListener('focus',()=>{refreshStatus();void tryOpen();});
  window.CodexLightTaskNotifications={open(threadId){if(validId(threadId)){pendingOpen=threadId;void tryOpen();}}};
  refreshStatus();reconcile();
  window.setInterval(refresh,30000);
  if(backgroundPanel)window.setInterval(()=>{if(!document.getElementById('settings-notifications')?.classList.contains('hidden'))refreshStatus();},5000);
  return {get details(){return supportsTaskDetails;},apply:data=>run(()=>monitor.apply(data)),reconcile,refresh,disconnected:()=>run(()=>monitor.disconnected()),reset:()=>run(()=>{pendingOpen=null;monitor.reset();})};
}
