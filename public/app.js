import { confirmApp } from './app-confirm-dialog.js';
import { createBackHandler, dismissBackLayer } from './ui/back-navigation.js';
import { createNavigationHistory } from './ui/navigation-history.js';
import { createThreadCompletion, createTaskbarBadge, createThreadReadReporter } from './ui/thread-completion.js';
import { mountMobileLayout } from './ui/mobile-layout.js';
import { mountTaskNotifications } from './ui/task-notifications.js';
import { createQuestionNotifications } from './ui/question-notifications.js';
import { createDesktopCompanion } from './ui/desktop-companion.js';
import { mountConversationScroll } from './ui/conversation-scroll.js';
import { mountOfflineSnapshot } from './ui/offline-snapshot.js';
import { mountDesktopClosePreference } from './ui/desktop-close-preference.js';
import {mountStorageView} from './ui/storage-view.js';
import { mountWelcomeGreeting } from './ui/welcome-greeting.js';
import { redeemPairing } from './ui/pairing.js';
import { mountUpdateIndicator, mountAndroidUpdateIndicator } from './ui/update-indicator.js';
import { mountContextDetails } from './ui/context-details.js';
import {mountSessionSpeed} from './ui/session-speed.js';
import {mountSessionUsage} from './ui/session-usage.js';
import {mountMobileAbout} from './ui/mobile-about.js';
import {createQuestionIgnores} from './ui/question-ignores.js';
import { bootstrapToken } from './ui/access.js';
import { mountConfigSettingsPanel } from './config-settings-panel.js';
import { mountSettingsSearch } from './ui/settings-search.js';
import { mountSkillsView } from './ui/skills-view.js';
import { createNotifications } from './ui/notifications.js';
import { mountAccountLoginPanel } from './account-login-panel.js';
import { mountStatistics } from './ui/stats-view.js';
import { mountAccount } from './ui/account-view.js';
import { mountAbout } from './ui/about-view.js';
import { mountAccountQuota } from './account-quota.js';
import { createAccountIdentityController } from './account-identity.js';
import { mountArtifacts, mountLightbox } from './ui/artifacts.js';
import { createFilePreview } from './ui/file-preview.js';
import { resolveRelativePath } from './markdown.js';
import { pastedFiles, classifyPaste, isImageFile } from './ui/paste.js';
import { renderApprovals } from './ui/approvals-view.js';
import { createDshView } from './ui/dsh-view.js';
import { createRemoteView } from './ui/remote-view.js';
import { createSlashMenu } from './ui/slash-menu.js';
import { createComposer } from './ui/composer.js';
import { createAsyncAnswerSender } from './async-answer.js';
import { createPreferences } from './ui/preferences-view.js';
import { mountTitleSettings } from './ui/title-settings.js';
import { mountDshConfig } from './ui/dsh-config-view.js';
import { mountDshConnection } from './ui/dsh-connection-view.js';
import { mountLanAccess } from './ui/lan-view.js';
import { watchKeyboard } from './ui/viewport.js';
import { mountPluginsPanel } from './plugins.js';
import { requestKey, requestThread, validRequestId } from './approval-schemas.js';
import { icon, hydrateIcons } from './icons.js';
import { reasoningChoices, effortLabel, effortAccessibleLabel, restoredReasoning, resetReasoning, switchedReasoning, reasoningParameter, configuredReasoningView, defaultModelView, activeModelId } from './reasoning.js';
import { ItemStore, boundedText, itemText } from './store.js';
import { DshTaskStore } from './dsh.js';
import { DshLiveMonitor } from './dsh-live.js';
import { PendingMutations, pendingForScope, PendingReconciler, outcomeFromError, lookupDecision, canReleaseUnknownSkill, sendAvailability, ConnectionBootstrap, SessionDefaultsBridge } from './submissions.js';
import { mountHistoryAutoLoad, mountThreadAutoLoad, captureHistoryAnchor, restoreHistoryAnchor } from './ui/history-auto-load.js';
import { mountRuntimePanel } from './runtime-panel.js';
import { mountWslRuntimePanel } from './wsl-runtime-panel.js';
import { mountEngineOnboarding } from './engine-onboarding.js';
import { AttachmentDraft, FileAttachmentDraft, validateFileSelection, validateImageSelection } from './attachments.js';
import { mountConversation, renderDiff } from './activity-feed.js';
import { TurnLedger, buildTurns, FollowUpQueue, contextSnapshot, HistoryPager, historyCapabilities } from './state.js';
import { projectPathKey, projectThreadGroups, threadProjectPath } from './projects.js';
import { createSessionControls } from './session-controls.js';
import { mountProjectNavigation } from './project-navigation.js';
import { editProjectName } from './project-name-dialog.js';
import { mountPanelResize } from './ui/panel-resize.js';
import { mountLiveChanges, pillChanges, mountScrollToBottom } from './ui/live-changes.js';
import { createDelegationMonitor } from './delegation-monitor.js';
if(new URL(location.href).searchParams.get('preview')==='source')document.title='码舱 CodeCang · 源码预览';
const attachmentDraft = new AttachmentDraft();
const fileAttachmentDraft = new FileAttachmentDraft();
const attachmentPreviews = new Map();
const dshTasks = new DshTaskStore();
const $ = id => document.getElementById(id);
hydrateIcons(document);
const contextDetails=mountContextDetails(document);
const sessionSpeed=mountSessionSpeed(document,(threadId,history)=>api('/api/statistics/session-speed',history?{threadId}:{threadId,liveOnly:true}));
const sessionUsage=mountSessionUsage(document,(threadId,history)=>api('/api/statistics/session-cost',history?{threadId}:{threadId,preferCachedHistory:true}));
mountWelcomeGreeting(document.querySelector('#welcome h1'));
let localSession; try { localSession = sessionStorage; } catch { localSession = {getItem(){throw new Error('会话存储不可用');},setItem(){throw new Error('会话存储不可用');},removeItem(){throw new Error('会话存储不可用');}}; }
const readSession = key => { try { return localSession.getItem(key); } catch { return null; } };
// Token bootstrap: loopback keeps a session copy; LAN (phone) keeps it in memory only.
let pairingError=null;
try { await redeemPairing(location, url=>history.replaceState(null,'',url)); } catch(error) { pairingError=error; }
const access = bootstrapToken(location, localSession, url => history.replaceState(null, '', url));
const token = access.token;
// LAN pages cannot use local management (shutdown, runtime, desktop, LAN links). Applied before any request.
function applyAccessMode(lan) {
  state.lan = !!lan; document.documentElement.dataset.access = lan ? 'lan' : 'local';
  const paired = state.lan || androidUpdateHost;
  $('about-root').hidden = paired; $('mobile-about').hidden = !paired;
  const next = paired ? mobileAbout : desktopAbout;
  if (aboutView !== next) {
    aboutView.deactivate(); aboutView = next;
    if (currentRoute === 'settings' && state.settingsPage === 'about') void aboutView.activate();
  }
}
const pendingMutations = new PendingMutations(localSession);
let draftModelChoice = readDraftModelChoice();
let modelCatalogLoading = true;
const sessionDefaults = new SessionDefaultsBridge(body => api('/api/session/defaults', body), {onChange:snapshot=>{populateEfforts();updateControls();if(snapshot.error)notice('无法读取 Codex 配置默认模型/强度：'+snapshot.error+'。没有改用模型目录默认值；可打开模型列表显式重试，发送时不会强行写入默认值。',true);}});
const state = { connected: false, demo: false, desktop: false, reasoning: restoredReasoning(null), cwd: '', thread: null, threads: [], nextThreads: null, nextItems: null, models: [], modelGeneration: 0, turnId: null, sending: false, busy: false, openGeneration: 0, searchGeneration: 0, requests: new Map(), store: new ItemStore(Infinity, { preserveBodies: true }), nodes: new Map(), rendering: false, historyFallback: false, activeTurns: new Map(), terminalTurns: new Set(), shuttingDown: false, eventController: null, dshConnection: null, dshRefreshing: false, serverInstance: null, pendingQueries: new Set(), interruptingTurns: new Set(), uploadingImages: false, loadingThread: false, dshReads: new Map(), dshReadErrors: new Map(), dshReadSequence: 0, dshReadGeneration: 0, dshOpenDetails: new Set(), settingsPage: 'general', archivedThreads: [], archivedCursor: null, archivedGeneration: 0, accountLoading: false, usageLoading: false, renameTarget: null, cliVersion: null, ledger: new TurnLedger(), nextTurns: null, contexts: new Map(), threadSessions: [] };
// Follow-up messages typed while a task runs. Per thread, survives navigation, never persisted.
const followUps = new FollowUpQueue();
const reasoningWrites = new Map();
let threadReasoning=null, openingReasoning=null;
const liveSettingsUpdates = new Map();
// Retain confirmed sends until native history catches up, including active background turns.
const unindexedThreads = new Map();
const sessionControls=createSessionControls({document,defaults:()=>sessionDefaults.snapshot().value,threadId:()=>state.thread?.id,model:()=>effectiveModel().model,onFastChange:tier=>queueLiveTurnSettings({serviceTier:tier}),notice:(...args)=>notice(...args),permissionStore:input=>api('/api/session/permission',input)});
const queuedPreviews = new Map();
let runtimePanel=null,pendingReconciler=null,pendingReconcilerSignature='',pendingReconcilerActive=false,pendingReconcileQueued=false;
const projectsState={projects:[],selectedId:null,draftCwd:'',canPickFolder:false,busy:false,error:'',generation:0,dialogGeneration:0};
let navigationDepth=30, restoredOrder=null, savedOrder=null, desiredOrder=null, failedOrder=null, savingOrder=false;
let projectsLoaded=false, normalThreadsLoaded=false, animateProjectOrder=false;
async function saveProjectOrder(order) {
  desiredOrder=JSON.stringify({order,depth:navigationDepth});
  if(savingOrder||desiredOrder===savedOrder||desiredOrder===failedOrder)return;
  savingOrder=true;
  try {
    while(desiredOrder!==savedOrder){
      const next=desiredOrder;
      await api('/api/projects/navigation',JSON.parse(next));
      savedOrder=next;failedOrder=null;
    }
  } catch(error) { failedOrder=desiredOrder;notice('项目排列未能保存：'+error.message,true); }
  finally { savingOrder=false; }
}
const recentThreads = new Map();
const desktopWebView = window.chrome?.webview;
const desktopCompanion = createDesktopCompanion(desktopWebView && (message => desktopWebView.postMessage(message)));
const taskbarBadge = createTaskbarBadge(message => window.chrome?.webview?.postMessage(message));
const threadCompletion = createThreadCompletion(taskbarBadge.setCompleted);
const threadReadReporter = createThreadReadReporter(input => api('/api/thread-reads', input, {timeoutMs: 5000}));
let threadReadFrame = null, renderedThreadReads = null;
taskbarBadge.setCompleted(0);
const threadSearchCache = new Map();
let searchStatus = { text: '', busy: false };
let threadSearchController=null;
const pendingReconcileErrors=new Map();
let pendingReadGeneration=0;
const mutationContexts=new Map();
const runtimeRecoveryCandidates=new Map();
const allPendingRecords=()=>pendingMutations.values();
const scopedPending=(scope,options={})=>pendingForScope(allPendingRecords(),scope,options);
const chatPendingRecords=()=>scopedPending('chat',{threadId:state.thread?.id||null});
const threadPendingRecords=(threadId=state.thread?.id||null)=>scopedPending('thread',{threadId});
const reconcilableRecords=()=>allPendingRecords().filter(row=>row.status!=='inFlight'||row.restored);
// The sidebar has one state owner. Layout, aria, focus, overlay and navigation all call this controller.
// sidebar-controller:start
const sidebarController = (() => {
  const app=$('app'), sidebar=$('sidebar'), overlay=$('sidebar-overlay');
  const sidebarButton=$('rail-sidebar'), sidebarHome=document.createComment('sidebar toggle home');
  sidebarButton.before(sidebarHome);
  const media=window.matchMedia('(max-width:760px)');
  let open=false, returnFocus=null, mode='chat', motionTimer=null, initialized=false;
  function settleMotion(){window.clearTimeout(motionTimer);app.classList.remove('sidebar-animating');}
  function animateToggle(){settleMotion();app.classList.add('sidebar-animating');motionTimer=window.setTimeout(settleMotion,320);}
  const desktopOpen={chat:true,settings:true};
  const narrow=()=>media.matches;
  const closeButton=()=>$('settings-dialog').classList.contains('hidden')?$('close-sidebar'):$('settings-sidebar-close');
  const focusable=()=>[...sidebar.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])')].filter(node=>node.getClientRects().length);
  function sync(){
    const topActions=narrow()?document.querySelector('.stage:not(.hidden) .stage-actions, .stage:not(.hidden) .page-controls'):null;
    if(topActions){if(sidebarButton.parentNode!==topActions)topActions.prepend(sidebarButton);}
    else if(sidebarButton.previousSibling!==sidebarHome)sidebarHome.after(sidebarButton);
    const effectiveOpen=open;
    const overlayOpen=narrow()&&effectiveOpen;
    app.classList.toggle('sidebar-open',overlayOpen);
    app.classList.toggle('sidebar-collapsed',!narrow()&&!effectiveOpen);
    sidebar.classList.remove('route-hidden');
    overlay.classList.toggle('hidden',!overlayOpen);
    sidebar.inert=!effectiveOpen;
    if(effectiveOpen)sidebar.removeAttribute('aria-hidden');else sidebar.setAttribute('aria-hidden','true');
    const button=$('rail-sidebar');button.hidden=false;button.setAttribute('aria-expanded',String(effectiveOpen));const label=effectiveOpen?'收起侧栏':'展开侧栏';button.setAttribute('aria-label',label);button.title=label;
  }
  function set(next,{focus=true}={}){
    const wasOpen=open;open=!!next;
      if(initialized&&wasOpen!==open)animateToggle();
    if(!narrow()&&Object.hasOwn(desktopOpen,mode))desktopOpen[mode]=open;
    if(open&&!wasOpen&&narrow())returnFocus=document.activeElement;
    sync();
    if(initialized&&wasOpen!==open)scheduleThreadRead();
    if(open&&narrow()&&focus)requestAnimationFrame(()=>{if(open&&narrow())closeButton()?.focus();});
    const activeInside=sidebar.contains(document.activeElement);
    if(!open&&(focus||activeInside))requestAnimationFrame(()=>{
      if(open)return;
      const remembered=returnFocus;returnFocus=null;
      const active=document.activeElement;
      if(!focus&&active&&active!==document.body&&!sidebar.contains(active))return;
      const target=remembered?.isConnected&&remembered.getClientRects().length?remembered:$('rail-sidebar');
      target?.focus();
    });
  }
  sidebar.addEventListener('keydown',event=>{
    if(event.key!=='Tab'||!narrow()||!open)return;
    const nodes=focusable();if(!nodes.length){event.preventDefault();return;}
    const first=nodes[0],last=nodes.at(-1),active=document.activeElement;
    if(event.shiftKey&&(active===first||!sidebar.contains(active))){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&(active===last||!sidebar.contains(active))){event.preventDefault();first.focus();}
  });
  window.addEventListener('resize',settleMotion);
    media.addEventListener('change',()=>{settleMotion();open=['chat','settings'].includes(mode)&&!narrow()?desktopOpen[mode]:false;sync();});
  set(!narrow(),{focus:false});initialized=true;
  return {
    toggle:()=>set(!open),
    open:({desktopOnly=false}={})=>set(!desktopOnly||!narrow(),{focus:false}),
    close:()=>set(false),
    closeForNavigation:()=>{if(narrow()&&open)set(false,{focus:false});},
    setRoute(next){
      if(mode===next){sync();return;}
      const wasOpen=open;
      if(!narrow()&&Object.hasOwn(desktopOpen,mode))desktopOpen[mode]=open;
      mode=next;returnFocus=null;
      open=!narrow()&&Object.hasOwn(desktopOpen,mode)?desktopOpen[mode]:false;
      if(wasOpen!==open)animateToggle();
      sidebar.setAttribute('aria-label',mode==='settings'?'设置导航':'项目与对话');sync();
    },
    sync,
    isNarrow:narrow,
    isOverlayOpen:()=>narrow()&&open,
  };
})();
// sidebar-controller:end
const dshLive = new DshLiveMonitor({
  historyPaging:true,
  api: (path, body) => api(path, body),
  onChange: () => scheduleDshRender(),
  onList: ({ threadId, list, checkedAt }) => {
    if (threadId !== state.thread?.id) return;
    if (dshTasks.ingestLiveList(threadId, list, { checkedAt, source: 'DSH 当前对话' })) {scheduleDshRender();scheduleRender();}
  },
  onEvents: ({ threadId, agentId, events, checkedAt, nextCursor, hasMore, syncingHistory }) => {
    if (threadId !== state.thread?.id) return;
    if (dshTasks.ingestLiveEvents(threadId, agentId, events, { checkedAt, cursor: nextCursor, hasMore, syncingHistory, source: 'DSH 自动事件' })) scheduleDshRender();
  },
  onStatus: ({ threadId, agentId, status, checkedAt }) => {
    if (threadId !== state.thread?.id) return;
    if (dshTasks.ingestLiveStatus(threadId, agentId, status, { checkedAt, source: 'DSH 自动状态' })) scheduleDshRender();
  },
});
function el(tag, className, text) { const e = document.createElement(tag); if (className) e.className = className; if (text != null) e.textContent = text; return e; }
const filePreview=createFilePreview({document,openImage:view=>lightbox.open(view),downloadFile:async({path,...scope},name,{signal})=>{
  const bridge=window.CodexLightNative;
  if(bridge?.isNativeApp?.()){
    if(typeof bridge.saveProjectFile!=='function')throw new Error('请更新 Android 客户端以保存文件，或在浏览器中打开。');
    if(bridge.saveProjectFile(JSON.stringify(scope),path,name)===false)throw new Error('无法打开系统保存窗口，请重试。');
    return '请在系统窗口选择保存位置。';
  }
  const response=await fetch('/api/files/download',{method:'POST',signal,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({...scope,path})});
  if(!response.ok){const result=await response.json();throw new Error(result.error?.message||result.error||'文件下载失败');}
  const blob=await response.blob();signal.throwIfAborted();
  const url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download=name;document.body.append(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),60000);
  return '已交给浏览器下载。';
},fetchPreview:async(input,{signal})=>{
  const response=await fetch('/api/files/preview',{method:'POST',signal,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(input)});
  const result=await response.json();if(!response.ok)throw new Error(typeof result.error==='string'?result.error:result.error?.message||'文件预览失败');return result;
}});
let localFileClick = 0;
async function previewLocalFile(ref,node,threadId=state.thread?.id){
  const click=++localFileClick;
  if(!ref.absolute&&ref.fullPath===ref.path&&threadId){
    try{
      const {thread}=await rpc('thread/read',{threadId,includeTurns:false});
      if(click!==localFileClick||!node.isConnected)return;
      if(thread?.id!==threadId||!thread.cwd)throw new Error('未取得该对话的工作目录');
      ref={...ref,fullPath:resolveRelativePath(ref.path,thread.cwd)};
    }catch(error){if(click===localFileClick)notice('无法解析文件链接：'+error.message,true);return;}
  }
  if(ref.revealResolvedLocalPath){ref.revealResolvedLocalPath(ref.fullPath);return;}
  filePreview.open(ref,{threadId},node);
}
// Image previews go only through the authenticated, thread-scoped preview API; the token never enters a URL.
async function fetchArtifactPreview(path, threadId = state.thread?.id, workspaceOnly = false) {
  if (!threadId) throw new Error('需要已保存的对话才能预览');
  if (!token) throw new Error('缺少本地访问令牌');
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch('/api/artifacts/preview', { method: 'POST', signal: controller.signal, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId, path, ...(workspaceOnly ? {workspaceOnly:true} : {}) }) });
    if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || (response.status === 404 ? '图片不存在或已移动' : `无法预览（${response.status}）`)); }
    const type = response.headers.get('Content-Type') || '';
    if (!/^image\//.test(type)) throw new Error('服务返回的不是图片');
    const width = Number(response.headers.get('X-Artifact-Width')) || null, height = Number(response.headers.get('X-Artifact-Height')) || null;
    const localPath=decodeURIComponent(response.headers.get('X-Artifact-Local-Path')||'');
    return { blob: await response.blob(), width, height, localPath };
  } catch (error) { throw new Error(error.name === 'AbortError' ? '预览超时' : error.message); }
  finally { clearTimeout(timer); }
}
const lightbox = mountLightbox(document);
const artifactView = mountArtifacts({ document, fetchPreview: fetchArtifactPreview, getScope:()=>state.thread?.id||null, onOpen: view => lightbox.open(view), resolveImage: (itemId, slot) => state.store.image(itemId, slot) });
const conversationScroll=mountConversationScroll($('conversation'));
const questionIgnores=createQuestionIgnores({scope:()=>state.serverInstance,
  read:(threadId,itemIds)=>api('/api/questions/ignored',{threadId,itemIds}),
  write:(threadId,itemId,serverInstance)=>api('/api/questions/ignore',{threadId,itemId,serverInstance}),
  onIgnored:(threadId,itemId)=>questionNotifications?.answered(threadId,itemId),
  onError:error=>notice('暂时无法读取已忽略的提问：'+error.message,true)});
const conversation = mountConversation($('messages'), { scrollController:conversationScroll,questionIgnores,
  onFork:(threadId,lastTurnId)=>forkCurrentThread(lastTurnId,threadId),
  readTurnUsage:(threadId,turnIds)=>api('/api/statistics/turns',{threadId,turnIds}),
  ensurePrices:()=>api('/api/pricing/ensure',{}),getContext:()=>state.contexts.get(state.thread?.id), onLocalLink: previewLocalFile, getCwd: () => state.thread?.cwd || state.cwd, getThreadId:()=>state.thread?.id, onAnswerAsync:payload=>answerAsync(payload), artifacts: artifactView, onOpenAgent:(id,kind)=>{showDetails(true);dshView.openAgent(id,kind);} });
setInterval(() => { if (conversation.hasRunningClock() && document.visibilityState === 'visible') conversation.tick(); }, 1000);
/** Leaves a thread's subscription. Active work is retained by the bridge; that is not an error. */
function releaseThread(threadId) {
  if (!threadId || !state.connected) return;
  rpc('thread/unsubscribe', { threadId }).catch(error => notice('离开对话时未能释放会话订阅：' + error.message + '。关闭应用时会统一释放。', true));
}
function resetThreadView() {
  renderedThreadReads = null;
  historyAutoLoad?.reset(); state.store.clear(); state.ledger.clear(); conversation.clear(); state.nextItems = null; state.nextTurns = null; state.historyFallback = false; state.pager = null;
  liveChanges.update(pillChanges([]), state.thread?.id || null);
  composer.renderOptimistic();
}
const projectNavigation=mountProjectNavigation($('thread-list'),{
  onSelect:group=>selectProject(group),
  onOpenThread:id=>{const thread=state.threads.find(row=>row.id===id);if(thread&&!state.sending)openThread(thread).catch(error=>notice(error.message,true));},
  onRemove:group=>removeProject(group),
  onAction:(group,action)=>handleProjectAction(group,action),
  canManageThread,
  onThreadAction:(thread,action)=>{
    if (action === 'rename') openRename(thread);
    else if (action === 'summarize') summarizeThreadTitle(thread);
    else removeThread(thread, action);
  },
});
mountPanelResize({document,window});
const connectionBootstrap=new ConnectionBootstrap(async current=>{
 modelCatalogLoading=true;updateControls();
 const models=loadModels(current).finally(()=>{if(current()){modelCatalogLoading=false;updateControls();}});
 const results=await Promise.allSettled([models,loadThreads(false,current)]);
 if(!current())return;
 for(const result of results)if(result.status==='rejected')notice('连接已建立，但目录加载失败：'+result.reason.message+'。可点击重新检查连接重试读取，不会发送任务。',true);
},error=>notice('连接目录加载失败：'+error.message,true));
const notifications = createNotifications({targets: [$('notice'), $('settings-notice')], activeTarget: () => $('settings-dialog').classList.contains('hidden') ? $('notice') : $('settings-notice')});
function notice(text, error = false) { notifications.show(text, error); }
let taskNotifications=null;
let questionNotifications=null;
let lastEventAt=0;
let taskNavigationReady=false;
let offlineSnapshot=null;
function activity(text, running = false) { $('activity').textContent = text; $('activity').classList.toggle('running', running); }
async function api(path, body, {timeoutMs=90000,signal}={}) {
  if (!token) { const error = new Error(access.lan ? '请在电脑的“设置 → 远程控制”中生成局域网或公网配对码，再用手机扫码连接。' : '缺少本地访问令牌，请使用启动器重新打开窗口。'); error.outcome = 'notExecuted'; throw error; }
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(path, { method: body === undefined ? 'GET' : 'POST', signal: signal?AbortSignal.any([controller.signal,signal]):controller.signal, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    const statusDocument = path === '/api/app-update/status' || (body === undefined && (path === '/api/status' || path.startsWith('/api/operations?')));
    if (!r.ok || (data.error && !statusDocument)) { const error = new Error(typeof data.error === 'string' ? data.error : data.error?.message || `HTTP ${r.status}`); error.code = data.code ?? data.error?.code; error.outcome = data.outcome; error.notExecuted = data.notExecuted; error.requestId = data.requestId; throw error; }
    if(data.persistenceWarning){state.persistenceWarning=String(data.persistenceWarning);notice(state.persistenceWarning,true);}
    return data;
  } finally { clearTimeout(timeout); }
}
const rpc = (method, params = {},options) => api('/api/rpc', { method, params },options);
const delegationMonitor=createDelegationMonitor({rpc,api,onChange:()=>scheduleRender(),onError:(error,context)=>{
  if(context.threadId===state.thread?.id)state.dshReadErrors.set(`${context.threadId}:${context.agentId}`,error.message||String(error));
}});
function syncDelegationMonitor(){
  delegationMonitor.update({threadId:state.thread?.id||null,items:state.store.values(),turns:[...state.ledger.turns.values()],
    activeTurnId:state.busy?state.turnId:null,connected:state.connected,visible:currentRoute==='chat'&&document.visibilityState!=='hidden',dshTasks});
}
// View controllers that other startup code calls into are created before the first status sync.
const remoteView = createRemoteView({ document, state, $, el, rpc, notice, confirm: text => confirm(text), performMutation, scopedPending, rowsNode });
const { remoteControls, applyRemoteStatus, remoteReset, refreshRemote } = remoteView;
const pluginLogicalCalls = new Map();
const pluginPendingHost = document.createElement('div'); pluginPendingHost.id='plugins-pending'; $('settings-plugins').before(pluginPendingHost);
function renderPluginPending(){
 const records=scopedPending('plugin');pluginPendingHost.classList.toggle('hidden',state.settingsPage!=='plugins'||!records.length);const fragment=document.createDocumentFragment();
 for(const marker of records){const row=el('div','pending-inline');row.setAttribute('role','status');const status=el('span','pending-inline-status','正在更新插件状态…');const failure=pendingReconcileErrors.get(marker.requestId);if(failure)status.title=failure;row.append(status);fragment.append(row);}pluginPendingHost.replaceChildren(fragment);
}
async function pluginApi(path,body){
 if(path!=='/api/plugins/apply')return api(path,body);
 const logicalId=body?.requestId;if(typeof logicalId!=='string')throw new Error('缺少插件逻辑请求标识');
 if(pluginLogicalCalls.has(logicalId))return pluginLogicalCalls.get(logicalId);
 if(pendingMutations.storageError||scopedPending('plugin').length)throw new Error('插件状态仍在自动同步；暂停相同的重复操作');
 if(pluginLogicalCalls.size>=100)pluginLogicalCalls.delete(pluginLogicalCalls.keys().next().value);
 const {requestId,...params}=body;const operation=performMutation('plugin/apply',params);pluginLogicalCalls.set(logicalId,operation);return operation;
}
const pluginPanel = mountPluginsPanel($('settings-plugins'), {rpc,api:pluginApi,getContext:()=>({connected:state.connected,cwd:state.cwd,serverInstance:state.serverInstance})});
function runtimePendingMarker(){return pendingMutations.values().find(row=>row.method==='runtime/upgrade')||null;}
// runtime-pending:start
async function queryRuntimePending(){
 const marker=runtimePendingMarker();
 if(!marker)return{outcome:'unknown'};
 const generation=pendingReadGeneration,instance=state.serverInstance;
 const response=await api('/api/operations?requestId='+encodeURIComponent(marker.requestId));
 if(generation!==pendingReadGeneration||!state.connected||instance!==state.serverInstance||!pendingMarkerExists(marker))return{outcome:'unknown'};
 if(marker.serverInstance!==instance){runtimeRecoveryCandidates.set(marker.requestId,{generation,instance});return{outcome:'unknown'};}
 const decision=lookupDecision(marker,response);
 if(decision==='succeeded'){pendingMutations.settle(marker.requestId);noteLedgerChanged();return response.result;}
 if(decision==='notExecuted'){pendingMutations.settle(marker.requestId);noteLedgerChanged();return {outcome:'not-executed'};}
 const registeredUnknown=response?.serverInstance===instance&&response.method===marker.method&&['succeeded','failed','unknown'].includes(response.state);
 if(registeredUnknown)runtimeRecoveryCandidates.set(marker.requestId,{generation,instance});else runtimeRecoveryCandidates.delete(marker.requestId);
 const stillPending=!registeredUnknown;
 pendingMutations.mark(marker.requestId,stillPending?'pending':'unknown');pendingReconcilerSignature=pendingLedgerSignature();renderPendingMutations();updateControls();return {outcome:stillPending?'pending':'unknown'};
}
// runtime-pending:end
function clearRuntimePendingAfterRecovery(){
 // Only a registered terminal unknown (or an obsolete instance) can release
 // its local marker after a stable version read. Same-instance notFound cannot.
 for(const marker of scopedPending('runtime')){
  const candidate=runtimeRecoveryCandidates.get(marker.requestId);
  if(candidate?.generation===pendingReadGeneration&&candidate.instance===state.serverInstance){pendingMutations.settle(marker.requestId);runtimeRecoveryCandidates.delete(marker.requestId);pendingReconcileErrors.delete(marker.requestId);}
 }
 noteLedgerChanged();
}
function applyRuntimeTarget(){
 const wsl=state.runtimeTarget==='wsl';
 document.documentElement.dataset.runtimeTarget=wsl?'wsl':'native';
 for(const [id,text] of [['runtime-panel','WSL 环境的 Codex 请在对应发行版内更新；此处不会更新 Windows 引擎。'],['dsh-config-root','WSL 模式暂不支持编辑 Windows DSH 配置来源。']]){
  const host=$(id);if(!host)continue;
  let note=$(id+'-wsl-notice');if(!note){note=el('p','runtime-status');note.id=id+'-wsl-notice';host.before(note);}note.textContent=text;note.classList.toggle('hidden',!wsl);host.classList.toggle('wsl-unavailable',wsl);host.inert=wsl;
 }
 if(wsl){dshConfigView.deactivate();}
}
function createRuntimePanel(){return mountRuntimePanel($('runtime-panel'),{read:()=>api('/api/runtime/status',{}),check:()=>api('/api/runtime/check',{}),configure:params=>api('/api/runtime/preferences',params),upgrade:params=>performMutation('runtime/upgrade',params),queryPending:queryRuntimePending,onRecovered:clearRuntimePendingAfterRecovery});}
const wslRuntimePanel=mountWslRuntimePanel($('wsl-runtime-panel'),{read:()=>api('/api/runtime/wsl/status',{}),discoverRunning:()=>api('/api/runtime/wsl/discover-running',{}),discover:()=>api('/api/runtime/wsl/discover',{}),select:target=>api('/api/runtime/wsl/select',target),isLocal:()=>!state.lan&&state.desktop===true});
const engineOnboarding=mountEngineOnboarding(document.body,{read:()=>api('/api/runtime/onboarding/status',{}),discover:()=>api('/api/runtime/onboarding/discover',{}),complete:input=>api('/api/runtime/onboarding/complete',input),isLocal:()=>!state.lan&&state.desktop===true&&!state.demo,openSettings:()=>openSettings('general'),notice});
runtimePanel=createRuntimePanel();
runtimePanel.reset({pending:!!runtimePendingMarker()});
function resetRuntimePanel(){wslRuntimePanel.reset();runtimePanel?.setActive?.(false);runtimePanel?.reset({pending:!!runtimePendingMarker()});}
function runtimePanelShouldBeActive(){return state.runtimeTarget!=='wsl'&&!state.lan&&!!state.serverInstance&&!state.demo&&document.visibilityState==='visible'&&!$('settings-dialog').classList.contains('hidden')&&state.settingsPage==='engines';}
function syncRuntimePanelActivity(){runtimePanel?.setActive?.(runtimePanelShouldBeActive());wslRuntimePanel.setActive(!state.lan&&state.desktop===true&&document.visibilityState==='visible'&&!$('settings-dialog').classList.contains('hidden')&&state.settingsPage==='general');}
function pendingLedgerSignature(){return reconcilableRecords().map(row=>`${row.requestId}:${row.status}`).sort().join('|');}
function deactivatePendingReconciler(){pendingReadGeneration++;pendingReconciler?.setActive(false);pendingReconcilerActive=false;pendingReconcilerSignature='';}
function syncPendingReconciler(){
 if(!pendingReconciler)return;
 const active=!!state.connected&&!!state.serverInstance&&document.visibilityState==='visible';
 if(!active){deactivatePendingReconciler();return;}
 const signature=pendingLedgerSignature();
 if(!pendingReconcilerActive){
  pendingReconcilerActive=true;pendingReconcilerSignature=signature;pendingReconciler.setActive(true);pendingReconciler.refresh();return;
 }
 pendingReconciler.setActive(true);
 if(signature!==pendingReconcilerSignature){pendingReconcilerSignature=signature;pendingReconciler.refresh();}
}
function noteLedgerChanged(){
 for(const requestId of mutationContexts.keys())if(!allPendingRecords().some(row=>row.requestId===requestId))mutationContexts.delete(requestId);
 for(const requestId of runtimeRecoveryCandidates.keys())if(!allPendingRecords().some(row=>row.requestId===requestId))runtimeRecoveryCandidates.delete(requestId);
 if(pendingReconcileQueued)return;
 pendingReconcileQueued=true;
 queueMicrotask(()=>{pendingReconcileQueued=false;syncPendingReconciler();renderPendingMutations();updateControls();});
}
function pendingMarkerExists(marker){return allPendingRecords().some(row=>row.requestId===marker.requestId&&row.method===marker.method&&row.serverInstance===marker.serverInstance);}
function currentPendingMarker(marker){return marker?.serverInstance===state.serverInstance&&pendingMarkerExists(marker);}
function recoveredId(value){return typeof value==='string'&&value.length>0&&value.length<=256;}
async function recoverPendingResult(marker,result,current){
 const envelope=pendingMutations.envelope(marker.requestId),context=mutationContexts.get(marker.requestId);
 if(marker.method==='thread/start'){
  if(!recoveredId(result?.thread?.id)||typeof result.thread.cwd!=='string'||!result.thread.cwd)throw new Error('原新对话结果缺少有效标识或工作目录，继续保留待同步记录。');
  const generation=context?.openGeneration??state.openGeneration;
  const canAdopt=()=>current()&&!state.thread&&!state.loadingThread&&state.cwd===threadProjectPath(result.thread)&&state.openGeneration===generation;
  if(canAdopt())await sessionControls.load(result.thread.id);
  if(canAdopt()){
   state.thread=result.thread;restoreThreadReasoning({...result,sessionPermission:null});dshTasks.reset(state.thread.id);state.dshReadErrors.clear();state.dshOpenDetails.clear();state.dshConnection=null;renderDshConnection();syncDshLiveContext();renderDshTasks();$('thread-title').textContent=result.thread.name||result.thread.preview||'新对话';$('welcome').classList.add('hidden');renderRequests();
  }
  await loadThreads(false,current);
  return;
 }
 if(marker.method==='turn/start'||marker.method==='review/start'){
  if(!recoveredId(marker.threadId)||!recoveredId(result?.turn?.id)||!['inProgress','completed','failed','interrupted'].includes(result.turn.status)||(result.threadId&&result.threadId!==marker.threadId)||(result.turn.threadId&&result.turn.threadId!==marker.threadId))throw new Error('原任务结果缺少有效任务状态或对话关联，继续保留待同步记录。');
  if(envelope&&marker.method==='turn/start')clearSubmittedDraft({...envelope,preserveText:true});
  if(marker.method==='turn/start'&&result.submittedAt)recordThreadSubmission(marker.threadId,result.submittedAt,result.activityWarning);
  if(state.thread?.id!==marker.threadId)return;
  const generation=state.openGeneration,threadCurrent=()=>current()&&generation===state.openGeneration&&state.thread?.id===marker.threadId;
  state.ledger.merge(result.turn);if(!state.busy||!state.turnId||state.turnId===result.turn.id){state.busy=result.turn.status==='inProgress'&&!state.terminalTurns.has(result.turn.id);state.turnId=state.busy?result.turn.id:null;}
  await loadItems(false,generation,threadCurrent);
  if(threadCurrent()){activity('');updateControls();}
  return;
 }
 if(marker.method==='turn/steer'){
  if(envelope)clearSubmittedDraft({...envelope,preserveText:true});
  if(result?.submittedAt)recordThreadSubmission(marker.threadId,result.submittedAt,result.activityWarning);
  if(state.thread?.id===marker.threadId){const generation=state.openGeneration;await loadItems(false,generation,()=>current()&&state.thread?.id===marker.threadId);}
  return;
 }
 if(marker.method==='thread/summary'){
  applySummaryResult(marker.threadId,result);
  await loadThreads(false,current);
  return;
 }
 if(marker.method==='thread/name/set'){
  const result=await rpc('thread/read',{threadId:marker.threadId,includeTurns:false});
  if(current()&&result?.thread?.id===marker.threadId)updateThreadName(marker.threadId,result.thread.name??null);
  await loadThreads(false,current);
  return;
 }
 if(['thread/archive','thread/delete'].includes(marker.method)){
  if(marker.method==='thread/delete'&&result?.threadId!==marker.threadId)throw new Error('删除结果缺少目标对话标识，继续保留待同步记录。');
  removeListedThread(marker.threadId,marker.method==='thread/delete');
  await loadThreads(false,current);
  return;
 }
 if(marker.method==='terminal/open'){
  if(!recoveredId(result?.processId)||(result.cwd!==undefined&&typeof result.cwd!=='string'))throw new Error('原终端结果缺少有效进程标识，继续保留待同步记录。');
  notice('旧版终端已创建，进程标识：'+result.processId);
 }
}
async function handlePendingReconcileResult(marker,response,decision){
 if(marker?.marker){decision=marker.decision??decision;response=marker.response??response;marker=marker.marker;}
 if(!marker?.requestId||!state.connected||!currentPendingMarker(marker))return;
 const generation=pendingReadGeneration,current=()=>generation===pendingReadGeneration&&state.connected&&currentPendingMarker(marker);
 pendingReconcileErrors.delete(marker.requestId);
 const resolved=typeof decision==='string'?decision:lookupDecision(marker,response);
 if(resolved==='pending'||resolved==='unknown'){pendingMutations.mark(marker.requestId,resolved);pendingReconcilerSignature=pendingLedgerSignature();renderPendingMutations();updateControls();return;}
 if(marker.method==='runtime/upgrade'&&!['succeeded','notExecuted'].includes(resolved)){pendingMutations.mark(marker.requestId,'unknown');pendingReconcilerSignature=pendingLedgerSignature();renderPendingMutations();updateControls();return;}
 if(resolved==='succeeded'){
  if(response?.method!==marker.method)throw new Error('原操作结果的方法关联不完整，继续保留待同步记录。');
  await recoverPendingResult(marker,response.result,current);
  if(!current())return;
 }
 const skillPath=marker.method==='skills/config/write'?pendingMutations.envelope(marker.requestId)?.params?.path:undefined;
 composer.resolveOptimistic(marker,response,resolved);
 pendingMutations.settle(marker.requestId);
 mutationContexts.delete(marker.requestId);
 if(resolved==='failed')notice('原操作已确认失败：'+(response?.error||'服务返回失败，请检查实际结果。'),true);
 if(marker.method==='runtime/upgrade'&&state.settingsPage==='engines'&&!$('settings-dialog').classList.contains('hidden'))runtimePanel?.refresh();
 if(marker.method.startsWith('account/')&&currentRoute==='account')refreshAccount().catch(error=>notice('无法刷新账户状态：'+error.message,true));
 if(marker.method.startsWith('remoteControl/'))remoteControls();
 if(marker.method==='skills/config/write'){
  slashMenu.invalidateSkills();
  skillsView.recover(skillPath,response?.result,resolved);
 }
 noteLedgerChanged();
}
function handlePendingReconcileError(marker,error){
 const record=marker?.marker||marker;if(!record?.requestId)return;
 pendingReconcileErrors.set(record.requestId,typeof error?.message==='string'&&error.message?error.message.slice(0,500):'状态读取失败');
 renderPendingMutations();
}
pendingReconciler=new PendingReconciler({records:reconcilableRecords,query:marker=>api('/api/operations?requestId='+encodeURIComponent(marker.requestId)),onResult:handlePendingReconcileResult,onError:handlePendingReconcileError,interval:5000,maxBackoff:30000});
pendingReconciler.setActive(false);
// Activation also reads the login-operation snapshot. Only authoritative account events
// invalidate account-scoped views; a read-only snapshot merely refreshes this page.
const accountLoginPanel=mountAccountLoginPanel($('account-login-controls'),{api:accountApi,readOnly:access.lan,onAccountChanged:async()=>{if(currentRoute==='account')await refreshAccount();}});
const statsView = mountStatistics($('stats-root'), { api, notice, readQuota:()=>api('/api/statistics/quota-estimate',{}), onPickFolder: async () => { if (!projectsState.canPickFolder) return null; const result = await api('/api/desktop/pick-folder', {}, { timeoutMs: 310000 }); return result.path || null; } });
const accountQuota = mountAccountQuota($('account-quota'), { rpc, onOpen: () => route('account'), onChange: desktopCompanion.quota });
const accountIdentity = createAccountIdentityController({
  rpc,
  onChange: () => resetAccountScopedViews('账户已改变'),
  onSame: async () => { await Promise.all([accountQuota.refresh(), currentRoute === 'account' ? refreshAccount() : null]); },
  onError: () => notice('账户身份核对失败，已清除旧账户显示；请重试读取账户。', true),
});
const accountView = mountAccount($('account-root'), {
  rpc: (method, params) => {
    if(method==='account/read')return accountIdentity.read();
    if(method!=='account/rateLimitResetCredit/consume')return rpc(method,params);
    if(pendingMutations.values().some(row=>row.method===method))throw Object.assign(new Error('上次重置结果仍待核实，请先刷新账户状态'),{outcome:'notExecuted'});
    return performMutation(method,params,{confirmed:true});
  },
  loginPanelHost: $('account-login-controls'), pendingHost: $('account-pending'), demo: () => state.demo,
  getThreadId: () => state.thread?.id, onQuota: result => accountQuota.update(result),
});
const lanView = mountLanAccess($('lan-root'), { api, notice });
const storageView=mountStorageView($('storage-root'),{api});
const titleSettings=mountTitleSettings($('title-settings-root'),{api,notice});
const updateHost=document.querySelector('.rail');
const androidUpdateHost=document.documentElement.dataset.mobileShell==='android';
const updateIndicator = !androidUpdateHost&&!access.lan ? mountUpdateIndicator(updateHost, {onOpen:()=>route('settings',{section:'about'})}) : null;
if(androidUpdateHost)mountAndroidUpdateIndicator(updateHost,window,$('mobile-app-update'));
let announcedUpdate='',announcedNode='';
function updateNodeRuntime(status){
  desktopAbout.updateNode(status);
  if(status?.available&&status.latest!==announcedNode){
    announcedNode=status.latest;
    notice('Node.js v'+status.latest+' 可用，在「设置 → 关于」查看运行环境更新。');
  }
}
function applyAutomaticUpdate(status) {
  desktopAbout.update(status);
  const version=status?.latest?.available&&status.supported&&!status.demo&&status.latest.version;
  if(window.chrome?.webview&&version&&version!==announcedUpdate&&!['launched','launchUnknown'].includes(status.phase)){
    announcedUpdate=version;
    notice('码舱 CodeCang v'+version+' 可用。打开设置 → 关于查看更新说明并下载。');
  }
}
const desktopAbout = mountAbout($('about-root'), { api, onStatus:status=>updateIndicator?.update(status), mutate: (method, params) => {
  if(pendingMutations.storageError||scopedPending('app-update').length)throw Object.assign(new Error('上一次更新请求尚未结束，请稍后查看更新状态。'),{outcome:'notExecuted'});
  return performMutation(method, params);
} });
const mobileAbout = mountMobileAbout($('mobile-about'), {bridge:androidUpdateHost ? window.CodexLightNative : null,
  readNotes:version=>api('/api/release-notes?version='+encodeURIComponent(version))});
let aboutView = desktopAbout;
// Local-only: the LAN page never mounts requests for DSH config management (server also refuses with 403).
const dshConfigView = mountDshConfig($('dsh-config-root'), { api, onSourcesChanged: () => dshConnectionView.refreshModels() });
const dshModelReminder = $('dsh-model-reminder');
$('configure-dsh-model').addEventListener('click', () => openSettings('dsh'));
$('dismiss-dsh-model').addEventListener('click', async () => {
  try { await api('/api/dsh/connection/modelReminder', {dismiss:true}); dshModelReminder.hidden = true; }
  catch (error) { notice(error.message,true); }
});
const dshConnectionView = mountDshConnection($('dsh-connection-root'), { api, runtimeTarget:()=>state.runtimeTarget, onChange: () => refreshDsh(), onModelSaved:() => { dshModelReminder.hidden = true; } });
function resetUsage(){statsView.reset();accountView.reset();if(currentRoute==='usage')statsView.activate();if(currentRoute==='account')accountView.activate();}
function resetAccountScopedViews(reason='账户已改变'){
  reasoningWrites.clear();openingReasoning=null;threadReasoning=null;
  state.reasoning=restoredReasoning(null);
  if(state.thread?.id){
    const threadId=state.thread.id,view={threadId,events:0};
    threadReasoning=view;renderThreadReasoning();
    if(state.connected)Promise.all([rpc('thread/read',{threadId}),api('/api/session/reasoning',{threadId})]).then(([read,saved])=>{
      if(threadReasoning!==view||state.thread?.id!==threadId)return;
      view.scope=saved.scope;
      if(!view.events)Object.assign(view,{model:read.thread.model,effort:read.thread.reasoningEffort,choice:saved.choice});
      renderThreadReasoning();
    }).catch(error=>{if(threadReasoning===view)notice('未能重新读取对话模型设置：'+error.message,true);});
  }
  resetContext();
  sessionControls.reset();
  if(state.connected&&state.thread?.id)sessionControls.load(state.thread.id).catch(error=>notice(error.message,true));
  threadCompletion.reset();
  taskNotifications?.reset();
  questionNotifications?.reset();
  threadSearchCache.clear();threadSearchController?.abort();state.searchGeneration++;searchStatus={text:'',busy:false};renderThreads();
  accountQuota.reset();if(state.connected)accountQuota.refresh();resetUsage();configPanel.reset();pluginPanel.reset();resetRuntimePanel();remoteReset({statusMessage:reason+'，请重新读取远控状态。',pairMessage:reason+'，旧配对码已隐藏。',devicesMessage:reason+'，旧设备显示已清除；不会撤销原账户或环境设备。'});sessionDefaults.clear();state.dshReadGeneration++;state.dshReads.clear();state.dshReadErrors.clear();state.dshOpenDetails.clear();dshTasks.reset(state.thread?.id||null);state.dshConnection=null;renderDshConnection();dshLive.reset();syncDshLiveContext();if(state.connected)syncSessionDefaults();
}
const configPanel=mountConfigSettingsPanel($('config-panel'),{readWindowCatalog:()=>api('/api/config-settings/window-catalog',{}),setContextWindow:(model,size)=>api('/api/config-settings/context-window',{model,size}),read:()=>api('/api/config-settings/read',state.cwd?{cwd:state.cwd}:{}),plan:edits=>{if(scopedPending('config').length)throw new Error('配置状态仍在自动同步');return api('/api/config-settings/plan',{edits});},apply:params=>{if(pendingMutations.storageError||scopedPending('config').length)throw new Error('配置状态仍在自动同步');return performMutation('config/apply',params);}});
function renderConfigPending(){const host=$('config-pending');if(!host)return;const records=scopedPending('config');host.replaceChildren();for(const marker of records){const row=el('div','pending-inline');row.setAttribute('role','status');const status=el('span','pending-inline-status','正在更新配置状态…');const failure=pendingReconcileErrors.get(marker.requestId);if(failure)status.title=failure;row.append(status);host.append(row);}}
let eventsReconnecting = false;
function setConnected(connected, label) {
  if (eventsReconnecting && !state.shuttingDown) {
    connected = false;
    label = state.lan ? '正在重新连接电脑…' : '正在重新连接本地服务…';
  }
  if (!connected && state.connected) {
    if (state.loadingThread) { state.openGeneration++; setThreadLoading(null); }
    threadAutoLoad.reset();
    historyAutoLoad.reset();
    if (searchStatus.busy) searchStatus = {text:'',busy:false};
  }
  if(!connected){taskNotifications?.disconnected();sessionControls.invalidate();resetContext();} if(state.connected !== connected){accountIdentity.reset();deactivatePendingReconciler();pluginPanel.reset();configPanel.reset();resetUsage();if(!connected)accountLoginPanel.update({state:'unknown'});state.dshReadGeneration++;state.dshReads.clear();state.dshReadErrors.clear();} state.connected = connected; renderThreads(); if(connected)accountQuota.start(state.serverInstance);else accountQuota.stop(); if(!connected){followUps.pauseAll('连接已断开');renderQueue();state.searchGeneration++;resetRuntimePanel();remoteReset({statusMessage:'连接已断开，无法读取远控状态。',pairMessage:'连接已断开，配对码已隐藏。',devicesMessage:'连接已断开，设备列表显示已清除；未撤销旧环境设备。'});}$('connection-dot').className = connected ? 'ok' : 'bad'; $('connection-text').textContent = label || (connected ? '本地 Codex 已连接' : '连接已断开'); $('status-info').textContent = $('connection-text').textContent; updateControls(); renderDshConnection(); remoteControls(); syncSessionDefaults(); syncDshLiveContext(); syncDelegationMonitor(); syncPendingReconciler(); syncRuntimePanelActivity(); connectionBootstrap.update(connected,state.serverInstance); }
function syncSessionDefaults(){sessionDefaults.sync({connected:state.connected,serverInstance:state.serverInstance,cwd:state.cwd,enabled:!state.demo});}
function formatModelDisplayName(value){const text=typeof value==='string'?value.trim():'';if(!text)return '';return text.replace(/^GPT-(\d+(?:\.\d+)?)-([A-Za-z][A-Za-z0-9]*(?:[-.][A-Za-z0-9]+)*)/,'GPT-$1 $2');}
function effectiveModel(){const id=activeModelId($('model').value,sessionDefaults.snapshot().value);return {id,model:id?state.models.find(entry=>entry.model===id)||null:null};}
function currentSendAvailability(){
 if(pendingMutations.storageError)return{disabled:true,reason:'本地消息状态记录无法安全保存，暂不能发送新消息。',action:null};
 if(chatPendingRecords().length)return{disabled:true,reason:'正在同步上一条消息状态，完成后即可继续发送。',action:'pending'};
 const hasContent=!!($('prompt').value.trim()||attachmentDraft.values().length||fileAttachmentDraft.values().length);
 // While a task runs the composer offers steer/queue instead of being blocked.
 if(state.busy&&state.thread&&!state.sending&&!state.loadingThread&&state.connected&&state.serverInstance&&!state.uploadingImages)return{disabled:!hasContent,reason:'',action:null,running:true};
 const availability=sendAvailability({...state,projectless:!state.thread||state.thread.projectless===true,pending:false,hasContent});
 if(availability.disabled||state.thread)return availability;
 const {model,effort}=draftModelChoice;
 if(((model||effort)&&modelCatalogLoading)||(!model&&effort&&sessionDefaults.snapshot().loading)){
   return {disabled:true,reason:'正在恢复新对话的模型和思考强度，请稍候。'};
 }
 return availability;
}
function updateControls() { syncSettingsFolderPicker();const availability=currentSendAvailability();const running=!!availability.running;const canSteer=running&&runningInputAvailable();
 $('send').disabled=availability.disabled||(running&&!canSteer);$('send').title=running?'立即补充到当前任务 (Enter)':availability.reason||'发送 (Enter)';$('send').setAttribute('aria-label',running?'立即补充到当前任务':'发送消息');$('send').dataset.mode=running?'steer':'send';
 $('queue-send').classList.toggle('hidden',!running);$('queue-send').disabled=!running||!hasDraft();
 $('composer-hint').textContent=running?(canSteer?'Tab 排队 · Shift Enter 换行':'该任务不在本窗口运行，结束后自动刷新 · Tab 排队'):'Enter 发送 · Shift Enter 换行 · / 命令';
 $('prompt').placeholder=running?'补充说明，或排队下一条消息':state.thread?'继续对话':'描述要完成的任务';
 const reason=running||availability.quiet?'':availability.reason;$('send-state-text').textContent=reason;$('send-state').classList.toggle('hidden',!reason||(!availability.action&&reason==='输入消息，或添加图片 / 文件。'));const action=$('send-state-action');action.classList.toggle('hidden',running||!availability.action||availability.action==='stop');action.dataset.action=availability.action||'';action.textContent=({reconnect:'重新检查连接',cwd:'选择工作目录',pending:'查看消息状态'})[availability.action]||'';
 $('stop').classList.toggle('hidden', !state.busy); $('stop').disabled = state.loadingThread || !state.turnId || !state.connected || !state.serverInstance || state.interruptingTurns.has(state.turnId) || pendingMutations.has('turn/interrupt', state.thread?.id, state.turnId); $('new-thread').disabled = state.sending; $('add-project').disabled=state.sending||projectsState.busy; $('model').disabled = state.sending || state.loadingThread; $('effort').disabled = $('model').disabled; $('model-trigger').disabled = $('effort').disabled; if ($('effort').disabled) closeReasoning(false); $('add-attachment').disabled = state.sending || state.uploadingImages || !state.connected; $('add-file').disabled = $('add-attachment').disabled; $('thread-menu-button').disabled = !state.thread || state.sending || state.loadingThread || state.busy || !!pendingMutations.storageError || threadPendingRecords().length>0;
 syncSkillsContext();
 void questionNotifications?.flushOpen();
 taskNotifications?.reconcile();
}
function setCwd(cwd) { if(state.cwd !== (cwd || '')){pluginPanel.reset();configPanel.reset();} state.cwd = cwd || ''; const label=state.cwd.split(/[\\/]/).filter(Boolean).at(-1)||'无项目';$('cwd-label').textContent=label; $('cwd-button').title=state.cwd||'选择项目'; $('project-name').textContent=label;syncSessionDefaults();updateControls();renderThreads(); }
// ---------- Router: exactly one stage is visible; every page transition goes through here ----------
const STAGES = { chat: 'chat-page', usage: 'usage-page', account: 'account-page', settings: 'settings-dialog' };
let currentRoute = 'chat';
let awayPosition=null,chatNeedsRender=false;
const navigationHistory = createNavigationHistory({name:'chat',threadId:null,cwd:state.cwd});
let navigatingHistory=false;
function recordNavigation(){
  if(!navigatingHistory){
    const entry={name:currentRoute,section:currentRoute==='settings'?state.settingsPage:undefined,threadId:currentRoute==='chat'?state.thread?.id||null:undefined,thread:currentRoute==='chat'?state.thread:null,...(currentRoute==='chat'&&!state.thread?{cwd:state.cwd}:{})};
    if(entry.threadId&&navigationHistory.current.name==='chat'&&!navigationHistory.current.threadId)navigationHistory.replace(entry);else navigationHistory.push(entry);
  }
  $('navigate-back').disabled=!navigationHistory.canBack||navigatingHistory;
  $('navigate-forward').disabled=!navigationHistory.canForward||navigatingHistory;
}
async function travelHistory(delta){
  if(navigatingHistory||state.sending||state.loadingThread)return false;
  const target=navigationHistory.move(delta);if(!target)return false;
  navigatingHistory=true;recordNavigation();
  try{
    if(target.name==='chat'&&(target.threadId!==(state.thread?.id||null)||(!target.threadId&&(target.cwd||'')!==state.cwd))){
      if(target.threadId)await openThread(target.thread||{id:target.threadId});else newThread(target.cwd||'');
    }else route(target.name,{section:target.section,back:true});
    return true;
  }catch(error){navigationHistory.move(-delta);notice('页面未能打开：'+error.message,true);return false;}
  finally{navigatingHistory=false;recordNavigation();}
}
$('navigate-back').addEventListener('click',()=>travelHistory(-1));
$('navigate-forward').addEventListener('click',()=>travelHistory(1));
document.addEventListener('keydown',event=>{if(event.altKey&&!event.ctrlKey&&!event.metaKey&&['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();void travelHistory(event.key==='ArrowLeft'?-1:1);}});
for(const button of document.querySelectorAll('[data-window-command]'))button.addEventListener('click',()=>window.chrome?.webview?.postMessage({type:'windowCommand',command:button.dataset.windowCommand}));
function route(name, { section, back = false } = {}) {
  if(name!=='chat'){contextDetails.close();sessionSpeed.close();sessionUsage.close();}
  if (!Object.hasOwn(STAGES, name)) name = 'chat';
  const previous = currentRoute;
  if(previous==='chat'&&name!=='chat')awayPosition={id:state.thread?.id,snapshot:conversationScroll.capture()};
  currentRoute = name;
  if(previous!==name&&(previous==='chat'||name==='chat'))renderContext();
  if (name==='chat' && state.thread && state.connected) historyAutoLoad.fill();
  closeThreadMenu();
  for (const [key, id] of Object.entries(STAGES)) $(id).classList.toggle('hidden', key !== name);
  $('app').dataset.view = name;
  // Settings owns a dedicated navigator; every other page keeps access to project history.
  $('chat-sidebar').classList.toggle('hidden', name === 'settings');
  $('settings-sidebar').classList.toggle('hidden', name !== 'settings');
  sidebarController.setRoute(name);
  if (name !== 'chat') setDetailsVisible(false);
  for (const button of document.querySelectorAll('.rail-btn[data-route]')) button.classList.toggle('active', button.dataset.route === name && !(name === 'settings' && (button.id === 'rail-plugins') !== (section === 'plugins')));
  // Deactivate pages being left so their polling/reads stop.
  if (previous === 'usage' && name !== 'usage') statsView.deactivate();
  if (previous === 'account' && name !== 'account') { accountView.deactivate(); accountLoginPanel.deactivate(); }
  if (previous === 'settings' && name !== 'settings') { pluginPanel.deactivate(); skillsView.deactivate(); aboutView.deactivate(); lanView.deactivate(); runtimePanel?.setActive?.(false); wslRuntimePanel.setActive(false); }
  if (previous === 'chat' && name !== 'chat') slashMenu.close();
  if (name === 'usage') statsView.activate();
  if (name === 'account') { accountView.activate(); accountLoginPanel.activate(); }
  if (name === 'settings') { renderDshConnection(); $('cwd-input').value = state.cwd; $('settings-notice').classList.add('hidden'); selectSettingsSection(section || 'general'); }
  syncDshLiveContext(); syncDelegationMonitor(); syncRuntimePanelActivity();
  if (name === 'settings') sidebarController.open({desktopOnly:document.documentElement.dataset.mobileShell==='android'||!!section&&section!=='general'});
  else sidebarController.closeForNavigation();
  if (name === 'chat') { if (previous !== 'chat') {
    const saved=awayPosition?.id===state.thread?.id?awayPosition?.snapshot:null;
    awayPosition=null;
    if(chatNeedsRender){chatNeedsRender=false;renderMessages(true,saved);}
    else if(saved)conversationScroll.restore(saved);
    $('prompt').focus({preventScroll:true});
  } }
  else (document.querySelector(`#${STAGES[name]} h1, #${STAGES[name]} .stage-bar button`) || $(STAGES[name]))?.focus?.({ preventScroll: true });
  if(!back)recordNavigation();
  renderThreads();
}
function openSettings(section = 'general') { route('settings', { section: typeof section === 'string' ? section : 'general' }); }
function closeSettings() { route('chat'); }
function newThread(cwd = projectsState.draftCwd) {
  if (state.sending) return;
  route('chat',{back:true}); sidebarController.closeForNavigation();
  const previous = state.thread?.id || null;
  // A new chat is only a draft; thread/start happens on first send.
  state.openGeneration++; setThreadLoading(null); state.thread = null; dshTasks.reset(); state.dshReadErrors.clear(); state.dshOpenDetails.clear(); state.dshConnection = null; renderDshConnection(); syncDshLiveContext(); renderDshTasks(); state.turnId = null; state.busy = false; resetThreadView(); $('thread-title').textContent = '新对话'; $('welcome').classList.remove('hidden'); $('earlier').classList.add('hidden'); activity(''); renderContext(); renderQueue(); updateControls(); renderThreads(); renderRequests(); $('prompt').focus();
  setCwd(cwd); populateEfforts(); releaseThread(previous);
  recordNavigation();
}
function renderThreads() {
  scheduleThreadRead();
  const runningThreadIds = new Set();
  if (state.connected) {
    for (const thread of state.threads) if (thread.status?.type === 'active') runningThreadIds.add(thread.id);
    const track = (threadId, turnId) => {
      if (!threadId || !turnId || state.terminalTurns.has(turnId)) return;
      runningThreadIds.add(threadId);
      // History and reconnect snapshots can restore a running turn without replaying its start.
      threadCompletion.trackActive(threadId, turnId);
    };
    for (const [threadId, turnId] of state.activeTurns) track(threadId, turnId);
    if (state.busy && !state.activeTurns.has(state.thread?.id)) track(state.thread?.id, state.turnId);
  }
  desktopCompanion.tasks(state.connected, runningThreadIds.size);
  const searching=!!$('search').value.trim();
  const order=projectNavigation.render({projects:projectsState.projects,threads:state.threads,selectedPath:state.cwd,activeThreadId:state.thread?.id||'',runningThreadIds,unreadThreadIds:threadCompletion.unread,searchStatus,searching,busy:projectsState.busy||state.sending,error:projectsState.error,
    restoredOrder:!normalThreadsLoaded&&!searching?restoredOrder:null,animateOrder:animateProjectOrder&&!searching});
  if(!searching&&projectsLoaded&&normalThreadsLoaded){
    animateProjectOrder=true;
    restoredOrder=order;
    if(!state.lan)void saveProjectOrder(order);
  }
  $('more-threads').classList.toggle('hidden', !state.nextThreads);
  $('refresh').ariaBusy=String(searchStatus.busy&&!$('search').value.trim());
  $('add-project').disabled=projectsState.busy||state.sending;
}
async function loadProjects({restore=false}={}) {
  const generation=++projectsState.generation;
  failedOrder=null;
  try {
    const result=await api('/api/projects');
    if(generation!==projectsState.generation)return;
    if(!projectsLoaded){
      restoredOrder=Array.isArray(result.navigationOrder)?result.navigationOrder:null;
      navigationDepth=result.navigationDepth??30;
      savedOrder=JSON.stringify({order:restoredOrder,depth:navigationDepth});
      animateProjectOrder=!!restoredOrder;
    }
    projectsLoaded=true;
    applyProjectList(result);projectsState.canPickFolder=result.canPickFolder===true;
    if(restore&&!state.cwd&&!state.thread)setCwd(projectsState.draftCwd);
  } catch(error) {if(generation===projectsState.generation)projectsState.error=error.message;}
  if(generation===projectsState.generation){syncSettingsFolderPicker();renderThreads();}
}
function syncSettingsFolderPicker() {
  const button=$('settings-cwd-browse');
  if(!button)return;
  button.hidden=!projectsState.canPickFolder||state.lan;
  button.disabled=!!projectsState.settingsPicking||state.sending||projectsState.busy;
}
function applyProjectList(result) {
  projectsState.projects=result.projects;projectsState.selectedId=result.selectedId;projectsState.error='';
  projectsState.draftCwd=result.draftCwd??result.projects.find(project=>project.id===result.selectedId)?.path??'';
}
async function pickSettingsFolder() {
  if(projectsState.settingsPicking||projectsState.busy||state.sending||state.lan||!projectsState.canPickFolder)return;
  const draft=$('cwd-input').value;
  projectsState.settingsPicking=true;syncSettingsFolderPicker();
  try {
    const result=await api('/api/desktop/pick-folder',{}, {timeoutMs:310000});
    if(result.path&&currentRoute==='settings'&&state.settingsPage==='general'&&$('cwd-input').value===draft)$('cwd-input').value=result.path;
  }catch(error){notice('无法选择工作目录：'+error.message,true);}
  finally{projectsState.settingsPicking=false;syncSettingsFolderPicker();}
}
function setProjectBusy(value){projectsState.busy=value;renderThreads();for(const id of ['project-save','project-browse'])$(id).disabled=value;}
function projectError(error){projectsState.error=error.message;renderThreads();if($('project-dialog').open)$('project-status').textContent=error.message;else notice(error.message,true);}
async function saveProjectSelection(group,generation,dialogGeneration,forceDraft=false) {
  const selecting=group.projectless||!!group.projectId;
  const result=await api('/api/projects/'+(selecting?'select':'add'),selecting?{id:group.projectId??null}:{path:group.path,...(group.saved===false?{recent:false}:{})});
  projectsState.generation++;applyProjectList(result);
  // Navigation or a send started while the chooser was open must keep its own target.
  if(generation!==state.openGeneration||dialogGeneration!==projectsState.dialogGeneration||state.sending){notice('项目选择已保存。当前对话保持原目录。');return false;}
  if($('project-dialog').open)$('project-dialog').close();
  $('cwd-setup').classList.add('hidden');
  const cwd=projectsState.draftCwd;
  if(forceDraft||state.loadingThread||projectPathKey(cwd)!==projectPathKey(state.cwd))newThread(cwd);
  else setCwd(cwd);
  closeSettings();renderThreads();$('prompt').focus();
  return true;
}
async function selectProject(group) {
  if(projectsState.busy||state.sending||(!group.path&&!group.projectless))return;
  const generation=state.openGeneration,dialogGeneration=projectsState.dialogGeneration;setProjectBusy(true);
  try{await saveProjectSelection(group,generation,dialogGeneration);}catch(error){projectError(error);}finally{setProjectBusy(false);}
}
async function removeProject(group) {
  if(projectsState.busy||!group.projectId)return;
  setProjectBusy(true);
  try{
    const result=await api('/api/projects/remove',{id:group.projectId});
    projectsState.generation++;applyProjectList(result);
    if(!state.thread&&projectPathKey(state.cwd)===group.key)setCwd(projectsState.draftCwd||'');
  }
  catch(error){projectError(error);}finally{setProjectBusy(false);}
}
async function handleProjectAction(group,action) {
  if(projectsState.busy||state.sending)return;
  if(action==='new'){
    const generation=state.openGeneration,dialogGeneration=projectsState.dialogGeneration;setProjectBusy(true);
    try{await saveProjectSelection(group,generation,dialogGeneration,true);}catch(error){projectError(error);}finally{setProjectBusy(false);}return;
  }
  if(action==='archive'){
    const threads=[...group.threads];
    if(!state.connected||state.busy||state.loadingThread||pendingMutations.storageError||threads.some(thread=>threadPendingRecords(thread.id).length)){notice('当前无法归档：请等待连接恢复和待处理操作完成。',true);return;}
    if(!threads.length||!await confirm(`归档“${group.name}”中已加载的 ${threads.length} 条聊天吗？未加载的历史聊天保持不变；可以在设置 → 已归档聊天恢复。`))return;
    setProjectBusy(true);state.sending=true;updateControls();let count=0;
    try{for(const thread of threads){await performMutation('thread/archive',{threadId:thread.id});count++;removeListedThread(thread.id,false);}await loadThreads();}
    catch(error){showMutationFailure(error,`归档（已确认完成 ${count} 条）`);await loadThreads().catch(loadError=>projectError(loadError));}
    finally{state.sending=false;if(state.thread?.removed)newThread();setProjectBusy(false);updateControls();}return;
  }
  if(action==='open'){
    if(state.lan){notice('在资源管理器中打开仅限本机窗口。',true);return;}
    try{
      await api('/api/projects/open',group.projectId?{id:group.projectId}:{path:group.path});
      notice(`已请求资源管理器打开“${group.name}”。`);
    }catch(error){notice('无法打开项目文件夹：'+error.message,true);}
    return;
  }
  let changes;
  if(action==='rename'){const name=await editProjectName(document,group);if(name===null)return;changes={name};}
  else if(action==='pin')changes={pinned:!group.pinned};
  setProjectBusy(true);
  try{
    let id=group.projectId;
    if(!id&&group.path){const result=await api('/api/projects/add',{path:group.path,recent:false,select:false});projectsState.generation++;applyProjectList(result);id=result.projects.find(project=>projectPathKey(project.path)===group.key)?.id;}
    if(changes){const result=await api('/api/projects/update',{id,...changes});projectsState.generation++;applyProjectList(result);}
  }catch(error){projectError(error);}finally{setProjectBusy(false);}
}
function openProjectDialog() {
  if(projectsState.busy||state.sending)return;
  const list=$('project-choices');list.replaceChildren();
  const groups=[
    {name:'无项目',projectless:true,selected:!state.cwd},
    ...projectThreadGroups(projectsState.projects,state.threads,{selectedPath:state.cwd}).filter(group=>group.saved)
  ];
  for(const group of groups){
    const button=el('button','project-choice');button.type='button';
    button.setAttribute('aria-pressed',String(group.selected));
    if(group.path)button.title=group.path;
    button.append(icon(document,group.projectless?'compose':'folder'),el('span','',group.name));
    button.addEventListener('click',()=>selectProject(group));list.append(button);
  }
  list.classList.remove('hidden');
  $('project-status').textContent=projectsState.error;
  $('project-path').value=state.cwd;
  $('project-browse').classList.toggle('hidden',!projectsState.canPickFolder);
  $('project-manual').open=!projectsState.canPickFolder;
  if(!$('project-dialog').open){projectsState.dialogGeneration++;$('project-dialog').showModal();}
  (list.querySelector('[aria-pressed="true"]')||list.firstElementChild).focus();
}
async function addProject() {
  if(projectsState.busy||state.sending)return;
  if(!projectsState.canPickFolder||state.lan){openProjectDialog();return;}
  const generation=state.openGeneration,dialogGeneration=projectsState.dialogGeneration;setProjectBusy(true);
  try{const result=await api('/api/desktop/pick-folder',{}, {timeoutMs:310000});if(result.path)await saveProjectSelection({path:result.path},generation,dialogGeneration);}
  catch(error){projectError(error);}finally{setProjectBusy(false);}
}
function withSubmittedActivity(thread){
  const newer=recentThreads.get(thread.id);
  return newer&&newer>(thread.submittedAt||0)?{...thread,submittedAt:newer}:thread;
}
function recordThreadSubmission(threadId,submittedAt,warning){
  if(warning)notice(warning,true);
  if(typeof threadId!=='string'||!Number.isSafeInteger(submittedAt)||submittedAt<=0||submittedAt<=(recentThreads.get(threadId)||0))return;
  recentThreads.delete(threadId);recentThreads.set(threadId,submittedAt);
  if(recentThreads.size>1000)recentThreads.delete(recentThreads.keys().next().value);
  state.threads=state.threads.map(row=>row.id===threadId?withSubmittedActivity(row):row);
  if(state.thread?.id===threadId)state.thread=withSubmittedActivity(state.thread);
  if(unindexedThreads.has(threadId))unindexedThreads.set(threadId,withSubmittedActivity(unindexedThreads.get(threadId)));
  renderThreads();
}
function rememberThread(thread,submittedAt) {
  if (!thread?.id || thread.ephemeral || thread.archived) return;
  recordThreadSubmission(thread.id,submittedAt);
  const { turns, ...summary } = thread;
  const row=withSubmittedActivity({ ...unindexedThreads.get(thread.id), ...summary });
  unindexedThreads.set(thread.id,row);
  const search = $('search').value.trim().toLocaleLowerCase();
  if (!search || (summary.name || summary.preview || '').toLocaleLowerCase().includes(search)) {
    state.threads=state.threads.some(item=>item.id===thread.id)?state.threads.map(item=>item.id===thread.id?row:item):[...state.threads.slice(0,299),row];
  }
  renderThreads();
}
async function loadThreads(more = false, current = ()=>true) {
  const generation = ++state.searchGeneration;
  threadSearchController?.abort();const controller=new AbortController();threadSearchController=controller;
  if (!more) { threadAutoLoad?.reset(); state.nextThreads = null; }
  const params = { limit: 30, sortKey: 'updated_at', sortDirection: 'desc' };
  if (more && state.nextThreads) params.cursor = state.nextThreads;
  if ($('search').value.trim()) params.searchTerm = $('search').value.trim();
  if (!more) { searchStatus = { text: params.searchTerm ? '正在搜索全部对话…' : '', busy: true }; renderThreads(); }
  try {
  // Restore the previous browsing depth before comparing group positions. A single
  // default page can omit projects the user reached by scrolling last time.
  const depth = more || params.searchTerm ? 30 : navigationDepth;
  params.limit = Math.min(depth, 100);
  let result = await rpc('thread/list', params,{signal:controller.signal});
  if (generation !== state.searchGeneration || !current()) return;
  const cursors = new Set();
  while (result.nextCursor && !cursors.has(result.nextCursor) && result.data?.length && result.data.length < depth && depth > 30) {
    cursors.add(result.nextCursor);
    const page = await rpc('thread/list', {...params, cursor:result.nextCursor, limit:Math.min(depth-result.data.length,100)}, {signal:controller.signal});
    if (generation !== state.searchGeneration || !current()) return;
    result = {...page, data:[...result.data,...(page.data||[])]};
    if (!page.data?.length) break;
  }
  const anchor = more ? captureHistoryAnchor($('thread-scroll'), ['.project-group-thread', '[data-project-key]']) : null;
  const listed = (result.data || []).map(withSubmittedActivity);
  for (const row of listed) {
    threadCompletion.trackThread(row);
    if (!state.activeTurns.has(row.id) && !sessionFor(row.id)?.activeTurnId) unindexedThreads.delete(row.id);
    else if (unindexedThreads.has(row.id)) unindexedThreads.set(row.id, { ...unindexedThreads.get(row.id), ...row });
  }
  const search = (params.searchTerm || '').toLocaleLowerCase();
  const pending = [...unindexedThreads.values()].filter(row => !search || (row.name || row.preview || '').toLocaleLowerCase().includes(search));
  const rows = more ? [...state.threads, ...listed] : listed;
  const ids = new Set(rows.map(row => row.id));
  state.threads = [...pending.filter(row => !ids.has(row.id)), ...new Map(rows.map(row => [row.id, row])).values()];
  // Keep the navigation bounded too; use server-side search instead of loading all history.
  if (state.threads.length > 300) {
    const protectedRows=state.threads.filter(row=>unindexedThreads.has(row.id)||state.activeTurns.has(row.id)||sessionFor(row.id)?.activeTurnId);
    const protectedIds=new Set(protectedRows.map(row=>row.id)),slots=Math.max(0,300-protectedRows.length);
    // Preserve the paging tail window while active/unindexed work remains reachable.
    state.threads=[...protectedRows.slice(0,300),...(slots?state.threads.filter(row=>!protectedIds.has(row.id)).slice(-slots):[])];
    notice('侧栏仅保留最近加载的 300 个对话，可用搜索查找其他对话。');
  }
  if(!search){normalThreadsLoaded=true;navigationDepth=Math.max(30,Math.min(300,state.threads.length));}
  state.nextThreads = result.nextCursor;
  threadSearchCache.set(search, { rows: state.threads.slice(), nextCursor: result.nextCursor });
  if(threadSearchCache.size>20)threadSearchCache.delete(threadSearchCache.keys().next().value);
  searchStatus = { text: search ? `找到 ${state.threads.length}${result.nextCursor ? '+' : ''} 个对话` : '', busy: false }; renderThreads();
  if (more) restoreHistoryAnchor($('thread-scroll'), anchor);
  } catch(error) {
    if(controller.signal.aborted)return;
    if(!more&&generation===state.searchGeneration&&current()){searchStatus={text:'读取失败：'+error.message,busy:false};renderThreads();}
    throw error;
  }finally{if(threadSearchController===controller)threadSearchController=null;}
}
const CONVERSATION_ITEMS = 500;
const historyCaps = historyCapabilities();
function sessionFor(threadId) { return state.threadSessions.find(row => row.threadId === threadId) || null; }
let threadLoadingTimer;
function setThreadLoading(thread) {
  clearTimeout(threadLoadingTimer);
  state.loadingThread = !!thread;
  $('conversation').ariaBusy = String(!!thread);
  $('thread-load-indicator').removeAttribute('data-visible');
  $('thread-open-status').textContent = '';
  if (thread) threadLoadingTimer = setTimeout(() => {
    $('thread-load-indicator').setAttribute('data-visible', '');
    const title = thread.name || thread.preview;
    $('thread-open-status').textContent = title ? `正在打开“${title}”` : '正在打开对话';
  }, 300);
}
async function openThread(thread) {
  const wasOverlay = sidebarController.isOverlayOpen();
  const returning=currentRoute!=='chat'&&state.thread?.id===thread.id&&state.pager?.threadId===thread.id&&!state.loadingThread;
  route('chat',{back:true});
  if(returning){recordNavigation();return;}
  const generation = ++state.openGeneration; setThreadLoading(thread); updateControls();
  const previous = state.thread?.id || null;
  const changing={threadId:thread.id,events:[]};
  openingReasoning=changing;
  try {
    // History is read-only: never resume or subscribe just to look at a conversation.
    const [result,reasoning] = await Promise.all([rpc('thread/read', { threadId: thread.id }),api('/api/session/reasoning',{threadId:thread.id}).catch(error=>{if(generation===state.openGeneration)notice('未能读取对话模型设置：'+error.message,true);return null;}),sessionControls.load(thread.id).catch(error=>{if(generation===state.openGeneration)notice('未能读取对话批准方式：'+error.message,true);})]);
    if (generation !== state.openGeneration) return;
    state.thread = withSubmittedActivity(result.thread || thread); dshTasks.reset(state.thread.id); state.dshReadErrors.clear(); state.dshOpenDetails.clear(); state.dshConnection = null; renderDshConnection(); syncDshLiveContext(); renderDshTasks(); restoreThreadReasoning({ model: state.thread.model, reasoningEffort: state.thread.reasoningEffort, sessionReasoning:reasoning, serviceTier: Object.hasOwn(result,'serviceTier') ? result.serviceTier : state.thread.serviceTier });
    openingReasoning=null;
    for(const change of changing.events)applyReasoningChange(change);
    if (previous !== state.thread.id) {
      resetThreadView();
      // Start the new transcript in follow mode before its first content arrives.
      // Input during loading can then take ownership without a late jump to the end.
      scrollBottom();
    }
    state.busy = false; state.turnId = null; renderRequests();
    void loadSavedContext(state.thread.id,generation);
    setCwd(threadProjectPath(state.thread)); $('thread-title').textContent = state.thread.name || state.thread.preview || '对话'; $('welcome').classList.add('hidden'); renderThreads(); renderContext(); renderQueue();
    const [running]=await Promise.all([loadTurns(false,generation).catch(e=>{
      if(generation===state.openGeneration&&!/method|not found|unsupported|unknown|32601/i.test(e.message))notice('无法读取任务状态：'+e.message,true);
      return null;
    }),loadItems(false,generation)]);
    if (generation !== state.openGeneration) return;
    $('earlier').classList.toggle('hidden',!hasEarlierHistory());
    if (fileApprovalPending()) renderRequests();
    const activeId = state.activeTurns.get(thread.id) || sessionFor(thread.id)?.activeTurnId || running?.id;
    if (activeId && !state.terminalTurns.has(activeId)) { state.activeTurns.set(thread.id,activeId);state.busy = true; state.turnId = activeId; state.ledger.activate(activeId); renderMessages(false); watchExternalTurn(); }
    else renderMessages(false);
    activity(''); sidebarController.closeForNavigation(); if(wasOverlay)$('conversation').focus({preventScroll:true});recordNavigation();
  } catch (error) {
    if (generation === state.openGeneration) throw error;
  } finally {
    if(openingReasoning===changing)openingReasoning=null;
    if (generation === state.openGeneration) { setThreadLoading(null); updateControls(); renderThreads(); offlineSnapshot?.ready();historyAutoLoad.fill(); }
    if (previous && previous !== state.thread?.id) releaseThread(previous);
  }
}
function clearRunningTurn(threadId,turnId){
  if(!turnId)return;
  if(state.activeTurns.get(threadId)===turnId)state.activeTurns.delete(threadId);
  if(state.thread?.id===threadId&&state.turnId===turnId){state.busy=false;state.turnId=null;}
}
function pauseQueueForOutcome(threadId,status){
  if(status!=='completed')followUps.pause(threadId,status==='interrupted'?'任务已停止':'任务未正常完成');
}

// Other clients' turns do not always emit completion events here. Follow each observed
// thread until it settles, including after the reader switches conversations.
const externalChecks = new Map();
function watchExternalTurn() {
  for(const [threadId,turnId] of state.activeTurns){
    if(!state.connected||!turnId||externalChecks.has(threadId)||sessionFor(threadId)?.activeTurnId===turnId)continue;
    const server=state.serverInstance;
    const current=()=>state.connected&&state.serverInstance===server&&state.activeTurns.get(threadId)===turnId&&sessionFor(threadId)?.activeTurnId!==turnId;
    const timer=setTimeout(async()=>{
      try {
        if(!current())return;
        const result=await rpc('thread/turns/list',{threadId,limit:1,sortDirection:'desc',itemsView:'notLoaded'});
        const latest=result.data?.[0];
        if(!current()||!latest?.id||!['inProgress','completed','failed','interrupted'].includes(latest.status))return;
        if(latest.id===turnId&&latest.status==='inProgress')return;
        pauseQueueForOutcome(threadId,latest.id===turnId?latest.status:null);
        clearRunningTurn(threadId,turnId);
        if(latest.status==='inProgress'&&!state.terminalTurns.has(latest.id))state.activeTurns.set(threadId,latest.id);
        if(state.thread?.id===threadId){
          state.ledger.merge(latest);
          state.turnId=state.activeTurns.get(threadId)||null;
          state.busy=!!state.turnId;
          const generation=state.openGeneration;
          void loadSavedContext(threadId,generation);
          void loadItems(false,generation).catch(error=>notice('无法刷新已结束的对话：'+error.message,true));
        }
        updateControls();renderThreads();renderQueue();drainQueue(threadId);
      }catch{/* Retry transient failures against the same live turn. */}
      finally{
        externalChecks.delete(threadId);
        watchExternalTurn();
      }
    },5000);
    externalChecks.set(threadId,timer);
  }
}
/** Turn metadata (status, duration) without items. Returns the in-progress turn, if any. */
const turnPageCursors = new Set();
async function loadTurns(earlier, generation, pager = null) {
  const id = state.thread?.id; if (!id) return null;
  const params = { threadId: id, limit: 30, sortDirection: 'desc', itemsView: 'notLoaded' };
  if (earlier) { if (!state.nextTurns) return null; params.cursor = state.nextTurns; }
  const result = await rpc('thread/turns/list', params);
  if (generation !== state.openGeneration || id !== state.thread?.id) return null;
  if (pager && pager!==state.pager) return null;
  if (!earlier) turnPageCursors.clear();
  if (result.nextCursor && turnPageCursors.has(result.nextCursor)) throw new Error('回合分页游标未前进，请重试。');
  if (result.nextCursor) turnPageCursors.add(result.nextCursor);
  const rows = Array.isArray(result.data) ? result.data : [];
  for (const turn of rows) {
    state.ledger.merge(turn);
    if(['completed','failed','interrupted'].includes(turn.status)&&(state.activeTurns.get(id)===turn.id||state.turnId===turn.id)){
      pauseQueueForOutcome(id,turn.status);clearRunningTurn(id,turn.id);
    }
  }
  state.nextTurns = result.nextCursor || null;
  return !earlier&&rows[0]?.status==='inProgress'?rows[0]:null;
}
async function loadItems(earlier = false, generation = state.openGeneration, current = ()=>true) {
  const id = state.thread?.id; if (!id) return;
  // Read-only paging: thread/items/list, else thread/turns/list(itemsView:'full') + cursor, else one
  // explicit thread/read. A fresh (non-earlier) load restarts from the newest page.
  if (earlier && (!state.pager || state.pager.threadId !== id)) return;
  if (earlier && !state.pager.hasMore) {
    const pager=state.pager;
    if(pager.mode==='items'&&state.nextTurns)await loadTurns(true,generation,pager);
    if(current()&&generation===state.openGeneration&&pager===state.pager){
      $('earlier').classList.toggle('hidden',!hasEarlierHistory());
      renderMessages(false);
    }
    return;
  }
  const refresh = !earlier && !!state.pager;
  const before = refresh ? new Map(state.store.items) : null;
  const pager = earlier ? state.pager : new HistoryPager((method,params)=>{
    if (generation!==state.openGeneration || id!==state.thread?.id) throw new Error('对话已切换');
    return rpc(method,params);
  },id,historyCaps);
  const page = await pager.next({ max: CONVERSATION_ITEMS });
  if (!current() || generation !== state.openGeneration || id !== state.thread?.id) return;
  if (!earlier) state.pager = pager; else if (state.pager !== pager) return;
  const items = page.items;
  for (const turn of page.turns) state.ledger.merge(turn);
  if (!earlier && page.activeTurnId && !state.activeTurns.has(id) && !state.terminalTurns.has(page.activeTurnId)) state.activeTurns.set(id, page.activeTurnId);
  state.historyFallback = page.mode !== 'items';
  for (const item of items.slice(-CONVERSATION_ITEMS)) dshTasks.ingest(id, item, { older: earlier, source: '已加载的 Codex 对话记录' });
  const anchor = earlier ? conversationScroll.capture() : null;
  state.store.mergeHistory(items, {before, refresh});
  state.nextItems = pager.hasMore ? pager.mode : null;
  $('earlier').classList.toggle('hidden', !hasEarlierHistory());
  renderMessages(!earlier, anchor);
  if(!earlier)historyAutoLoad.fill();
}
function scrollBottom() { conversationScroll.toBottom(); }
function renderMessages(follow = true, scrollSnapshot = null) {
  if(currentRoute!=='chat'){chatNeedsRender=true;return;}
  scrollSnapshot ??= conversationScroll.capture();
  const items = composer.timelineItems(state.store.values());
  syncDelegationMonitor();
  const delegatedChanges=[...dshTasks.delegatedChanges({turns:[...state.ledger.turns.values()],activeTurnId:state.busy?state.turnId:null}),...delegationMonitor.changes()];
  const turns = buildTurns(items, state.ledger, { activeTurnId: state.busy ? state.turnId : null, cwd: state.thread?.cwd || state.cwd,delegatedChanges });
  if(state.thread?.id)questionNotifications?.hydrateQuiet(turns,state.thread.id);
  conversation.render(turns,{follow,scrollSnapshot,restoreScroll:false});
  composer.renderOptimistic();
  liveChanges.update(pillChanges(turns),state.thread?.id||null);scrollToBottom.update();
  state.store.dirty.clear(); $('welcome').classList.toggle('hidden', !!state.thread || items.length > 0 || Boolean($('optimistic-messages') && !$('optimistic-messages').hidden));
  if (!$('details').classList.contains('hidden')) renderDshTasks();
  conversationScroll.restore(scrollSnapshot,{follow});
  if (state.thread?.id) {
    renderedThreadReads = {threadId: state.thread.id, turnIds: state.lan?turns.filter(turn => !turn.local && turn.status === 'completed').map(turn => turn.id):[]};
    scheduleThreadRead();
  }
}
let pendingAnswer = null;
function scheduleRender(answerId = null) {
  if (state.rendering) {
    if (pendingAnswer !== answerId) pendingAnswer = null;
    return;
  }
  pendingAnswer = answerId;
  state.rendering = true;
  setTimeout(() => requestAnimationFrame(() => {
    state.rendering = false;
    const id = pendingAnswer;
    pendingAnswer = null;
    if (currentRoute==='chat' && id && state.store.dirty.size === 1 && state.store.dirty.has(id) &&
        conversation.updateStreamingAnswer(state.store.items.get(id))) {
      state.store.dirty.delete(id);
      scrollToBottom.update();
    } else {
      renderMessages();
    }
  }), 32);
}
const liveChanges=mountLiveChanges($('live-changes'),{renderDiff});
const scrollToBottom=mountScrollToBottom($('conversation'),{onBottom:behavior=>conversationScroll.toBottom({behavior})});
const dshView = createDshView({ document, state, $, dshLive, dshTasks, api, rpc, el, questionIgnores,onAnswerAsync:payload=>answerAsync(payload), onLocalLink:previewLocalFile, artifactFactory:({threadId,resolveImage})=>mountArtifacts({document,fetchPreview:fetchArtifactPreview,getScope:()=>threadId,onOpen:view=>lightbox.open(view),resolveImage}) });
const { renderDshConnection, refreshDsh, syncDshLiveContext, scheduleDshRender, renderDshTasks, ingestDshSnapshot } = dshView;
$('dsh-live-refresh').addEventListener('click', () => { dshLive.refresh(); scheduleDshRender(); });
function removeAttachment(id) {
  const url = attachmentPreviews.get(id); if (url) URL.revokeObjectURL(url);
  attachmentPreviews.delete(id); attachmentDraft.remove(id);
}
function renderAttachments() {
  const container = $('attachment-tray'); const files = attachmentDraft.values(); const regularFiles = fileAttachmentDraft.values(); const fragment = document.createDocumentFragment();
  container.classList.toggle('hidden', !files.length && !regularFiles.length && !state.uploadingImages);
  for (const file of files) {
    const chip = el('div', 'attachment-chip attachment-image'); const preview = attachmentPreviews.get(file.id);chip.title=file.name;
    if (preview) { const button=el('button','attachment-preview');button.type='button';button.setAttribute('aria-label','预览 '+file.name);const image = el('img'); image.src = preview; image.alt = ''; image.addEventListener('error', () => { image.hidden = true; });button.append(image);button.addEventListener('click',()=>lightbox.open({url:preview,name:file.name}));chip.append(button); }
    if(!preview){const unavailable=el('span','attachment-image-unavailable','预览不可用');chip.append(unavailable);}
    const remove = el('button', 'icon-btn'); remove.append(icon(document,'close')); remove.type = 'button'; remove.setAttribute('aria-label', '取消附带 ' + file.name); remove.title = '仅取消这次发送，不删除原文件'; remove.disabled = state.sending;
    remove.addEventListener('click', () => { removeAttachment(file.id); renderAttachments(); updateControls(); }); chip.append(remove); fragment.append(chip);
  }
  for (const file of regularFiles) {
    const chip = el('div','attachment-chip'); chip.append(icon(document,'file'));
    const kind = file.category === 'text' ? '文本文件引用' : '文件引用';
    const size = file.size < 1024 ? `${file.size} B` : `${(file.size/1024).toFixed(0)} KiB`;
    const label = el('span','attachment-label'); label.title=file.name; label.append(el('strong','',file.name),el('small','',`${size} · ${kind}${file.riskWarning ? ' · 发送前需确认风险' : ''}`)); chip.append(label);
    const remove = el('button','icon-btn'); remove.type='button'; remove.append(icon(document,'close')); remove.setAttribute('aria-label','取消附带 '+file.name); remove.disabled=state.sending; remove.addEventListener('click',()=>{fileAttachmentDraft.remove(file.id);renderAttachments();updateControls();}); chip.append(remove); fragment.append(chip);
  }
  if (state.uploadingImages) fragment.append(el('span', 'attachment-uploading', '正在本地准备附件…'));
  container.replaceChildren(fragment);
}
async function uploadChosenAttachments(files, kind = 'auto') {
  if (!files.length || !state.connected || state.uploadingImages || state.sending) return;
  const asImage = file => kind === 'image' || (kind === 'auto' && (isImageFile(file) || file.type.startsWith('image/')));
  try {
    validateFileSelection(files, attachmentDraft.ids().length + fileAttachmentDraft.ids().length);
    validateImageSelection(files.filter(asImage), attachmentDraft.ids().length);
  } catch (error) { notice(error.message, true); return; }
  const generation = state.openGeneration;
  state.uploadingImages = true; renderAttachments(); updateControls();
  try {
    for (const file of files) {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 90000);
      try {
        const image = asImage(file), mime = file.type || 'application/octet-stream';
        const headers = { Authorization: `Bearer ${token}`, 'X-Filename': encodeURIComponent(file.name), 'Content-Type': image ? mime : 'application/octet-stream' };
        if (!image) headers['X-File-Mime'] = mime;
        const response = await fetch(image ? '/api/uploads' : '/api/file-uploads', { method: 'POST', signal: controller.signal, headers, body: file });
        const record = await response.json(); if (!response.ok || record.error) throw new Error(record.error || `本地暂存失败 (${response.status})`);
        if (image) {
          attachmentDraft.add(record);
          attachmentPreviews.set(record.id, URL.createObjectURL(new Blob([file], { type: record.mime })));
        } else fileAttachmentDraft.add(record);
        renderAttachments();
      } finally { clearTimeout(timer); }
    }
    if (generation !== state.openGeneration) notice('已在切换对话后完成附件准备；附件仍在当前输入框中，尚未发送。');
  } catch (error) { notice('附件未全部准备好：' + error.message + '。已添加的附件仍保留在输入框中。', true); }
  finally { state.uploadingImages = false; renderAttachments(); updateControls(); }
}
function clearSubmittedDraft(envelope) {
  if (!['turn/start', 'turn/steer'].includes(envelope?.method)) return;
  const submitted = envelope.params?.input?.[0]?.text;
  if (!envelope.preserveText && typeof submitted === 'string' && $('prompt').value.trim() === submitted.trim()) { $('prompt').value = ''; autosizePrompt(); }
  for (const id of envelope.attachmentIds || []) removeAttachment(id);
  for (const id of envelope.fileAttachmentIds || []) fileAttachmentDraft.remove(id);
  renderAttachments(); updateControls();
}
async function inspectRelatedRequest(marker) {
  if(marker.method==='runtime/upgrade'){openSettings('general');runtimePanel?.refresh();return;}
  if(marker.method==='config/apply'){openSettings('configuration');return;}
  if(marker.method==='plugin/apply'){openSettings('plugins');return;}
  if(marker.method==='skills/config/write'){openSettings('skills');return;}
  if(marker.method.startsWith('account/')){openSettings('account');return;}
  if (marker.method.startsWith('remoteControl/')) { openSettings('remote'); return; }
  if (marker.threadId) await openThread({ id: marker.threadId, name: '原请求所在对话' });
  else { await loadThreads(); notice('这次请求正在创建新对话；正在自动同步状态，请稍后在最近对话中查看。'); }
}
async function sendAsExplicitNewTask(marker) {
  if (state.sending || state.busy || !state.connected || !$('prompt').value.trim()) { notice('请先选择空闲对话并填写要发送的草稿。原请求仍保留，不会自动重发。'); return; }
  if (!await confirm('原请求的执行结果仍不确定。将当前草稿作为新任务发送，旧任务也可能继续执行，可能产生重复改动和重复用量。\n仍要作为新任务发送吗？')) return;
  try {
    const others=chatPendingRecords().filter(row=>row.requestId!==marker.requestId);
    if(others.length){notice('当前对话还有其他消息状态仍在同步；请等待完成后再作为新任务发送。');return;}
    await syncStatus(); if (!state.connected || !state.serverInstance) throw new Error('本地服务尚未就绪');
    pendingMutations.settle(marker.requestId); noteLedgerChanged(); await send();
  } catch (e) { notice(e.message, true); renderPendingMutations(); updateControls(); }
}
function renderPendingMutations() {
  const container=$('pending-submissions');
  const records=chatPendingRecords().filter(row=>row.status!=='inFlight'||row.restored);
  container.classList.toggle('hidden',!records.length&&!pendingMutations.storageError);
  const fragment=document.createDocumentFragment();
  if(pendingMutations.storageError){
    const row=el('div','pending-inline pending-inline-error');row.setAttribute('role','status');row.append(el('span','pending-inline-status','本地消息状态记录无法安全保存；为避免重复发送，暂不能发送新消息。'));
    fragment.append(row);
  }
  for(const marker of records){
    const row=el('div','pending-inline');row.setAttribute('role','status');
    const status=el('span','pending-inline-status','正在同步消息状态…');
    const failure=pendingReconcileErrors.get(marker.requestId);if(failure)status.title=failure;
    row.append(status);
    const view=el('button','subtle','查看原对话');view.type='button';view.disabled=!state.connected||state.sending;view.addEventListener('click',()=>inspectRelatedRequest(marker).catch(e=>notice(e.message,true)));row.append(view);
    if(['thread/start','turn/start'].includes(marker.method)){
      const retry=el('button','subtle','作为新任务发送');retry.type='button';retry.disabled=state.sending||!state.connected;retry.addEventListener('click',()=>sendAsExplicitNewTask(marker));row.append(retry);
    }
    fragment.append(row);
  }
  container.replaceChildren(fragment);renderAccountPending();renderPluginPending();renderConfigPending();skillsView.syncPending();
}
async function performMutation(method, params, extras = {}) {
  if(method==='turn/steer'){
    const before=state.serverInstance,update=liveSettingsUpdates.get(JSON.stringify([before,params.threadId,params.expectedTurnId]));
    if(update){
      await update.finished;
      if(state.serverInstance!==before || sessionFor(params.threadId)?.activeTurnId!==params.expectedTurnId)throw Object.assign(new Error('运行任务已变化，补充消息未发送。'),{outcome:'notExecuted'});
    }
  }
  let envelope;
  try { envelope = pendingMutations.begin(state.serverInstance, method, params, extras); }
  catch (error) { error.outcome = 'notExecuted'; renderPendingMutations(); throw error; }
  mutationContexts.set(envelope.requestId,{openGeneration:state.openGeneration});
  extras.onRequest?.(envelope);
  renderPendingMutations(); updateControls();
  try {
    const result = method==='runtime/upgrade'
      ? await api('/api/runtime/upgrade',{...envelope.params,requestId:envelope.requestId},{timeoutMs:1860000})
      : method.startsWith('app-update/') ? await api('/api/'+method,{...envelope.params,requestId:envelope.requestId},{timeoutMs:method==='app-update/download'?960000:60000})
      : method==='skills/config/write' ? await api('/api/skills/set-enabled',{...envelope.params,requestId:envelope.requestId})
      : await (method==='config/apply' ? api('/api/config-settings/apply',{...envelope.params,requestId:envelope.requestId}) : method==='plugin/apply' ? api('/api/plugins/apply',{...envelope.params,requestId:envelope.requestId}) : ['account/start','account/cancel','account/logout'].includes(method) ? api('/api/'+method,{...envelope.params,requestId:envelope.requestId}) : api('/api/rpc', envelope));
    if(method==='skills/config/write'&&typeof result?.effectiveEnabled!=='boolean')throw Object.assign(new Error('Codex 未返回生效状态，正在重新读取技能目录。'),{outcome:'unknown'});
    if(method.startsWith('app-update/')){
      const marker=pendingMutations.values().find(row=>row.requestId===envelope.requestId);
      if(!marker||lookupDecision(marker,{serverInstance:state.serverInstance,method,state:'succeeded',result})!=='succeeded')throw Object.assign(new Error('未收到完整的更新结果，正在同步更新状态。'),{outcome:'unknown'});
    }
    if(method==='thread/delete'&&result?.threadId!==envelope.params.threadId)throw Object.assign(new Error('删除结果缺少目标对话标识'),{outcome:'unknown'});
    if(method==='thread/summary'&&!validSummaryResult(envelope.params.threadId,result))throw Object.assign(new Error('标题结果缺少目标对话标识或标题'),{outcome:'unknown'});
    if(['thread/archive','thread/delete'].includes(method))unindexedThreads.delete(envelope.params.threadId);
    if(method==='runtime/upgrade'){
      const marker=pendingMutations.values().find(row=>row.requestId===envelope.requestId);
      const decision=marker?lookupDecision(marker,{serverInstance:state.serverInstance,method,state:'succeeded',result}):'unknown';
      if(decision==='succeeded'){pendingMutations.settle(envelope.requestId);noteLedgerChanged();return result;}
      if(decision==='notExecuted'){
        pendingMutations.settle(envelope.requestId);noteLedgerChanged();return {...result,outcome:'not-executed'};
      }
      pendingMutations.mark(envelope.requestId,'unknown');noteLedgerChanged();return {...result,outcome:'unknown'};
    }
    if(method==='git/apply' && !['completed','notExecuted'].includes(result?.outcome)){pendingMutations.mark(envelope.requestId,'unknown');noteLedgerChanged();return {...result,outcome:'unknown'};} if(['plugin/apply','config/apply'].includes(method) && !['succeeded','not-executed'].includes(result?.outcome)){pendingMutations.mark(envelope.requestId,'unknown');noteLedgerChanged();return {...result,outcome:'unknown'};} pendingMutations.settle(envelope.requestId); noteLedgerChanged(); return result;
  } catch (error) {
    const outcome = outcomeFromError(error); error.requestId ||= envelope.requestId;
    try { if (outcome === 'unknown') pendingMutations.mark(envelope.requestId, 'unknown'); else pendingMutations.settle(envelope.requestId); }
    catch (storageError) { notice(storageError.message, true); }
    noteLedgerChanged(); throw error;
  } finally { renderPendingMutations(); updateControls(); }
}
// ---------- Composer: send, steer, queue ----------
// Also runs whenever a newly created conversation becomes current: request cards re-scope (drafts kept).
function resetThreadDsh(threadId) { dshTasks.reset(threadId); state.dshReadErrors.clear(); state.dshOpenDetails.clear(); state.dshConnection = null; renderDshConnection(); syncDshLiveContext(); renderDshTasks(); renderRequests(); }
const composer = createComposer({ document,
  session: { state, followUps, sessionFor, sessionControls },
  drafts: { attachmentDraft, fileAttachmentDraft, attachmentPreviews, queuedPreviews, clearSubmittedDraft, renderAttachments, autosizePrompt: () => autosizePrompt() },
  ledger: { performMutation, pendingMutations, scopedPending, currentSendAvailability: () => currentSendAvailability(), renderPendingMutations: () => renderPendingMutations() },
  thread: { restoreThreadReasoning: (...args) => restoreThreadReasoning(...args), loadThreads: (...args) => loadThreads(...args), syncStatus: () => syncStatus(), resetThreadDsh, recordSubmission:recordThreadSubmission, rememberThread:(thread,submittedAt)=>{rememberThread(thread,submittedAt);if(currentRoute==='chat'&&state.thread?.id===thread.id)recordNavigation();} },
  view: { $, el, notice, activity, confirm: text => confirm(text), openImage:view=>lightbox.open(view), updateControls: () => updateControls(), renderMessages: (...args) => renderMessages(...args), scheduleRender: () => scheduleRender(), scrollBottom: () => scrollBottom(), renderContext: () => renderContext(), openProjectDialog: () => openProjectDialog(), openInlineCwd: () => openInlineCwd() } });
const { send, queueDraft, hasDraft, runningInputAvailable, drainAll, drainQueue, renderQueue } = composer;
const answerAsync=createAsyncAnswerSender({state,sessionFor,performMutation,
  getPermission:async(threadId,cwd)=>{
    await sessionControls.load(threadId);
    const config=sessionControls.mode(threadId)==='custom'?await api('/api/session/defaults',{cwd}):null;
    return sessionControls.params({...sessionControls.snapshot(threadId,config),serviceTier:null},'turn');
  },
  getCwd:async threadId=>{const known=state.thread?.id===threadId?state.thread:state.threads.find(thread=>thread.id===threadId);return known?.cwd||(await rpc('thread/read',{threadId,includeTurns:false})).thread?.cwd;},
  hasPending:threadId=>!!pendingMutations.storageError||scopedPending('chat',{threadId}).length>0,
  getEchoIds:threadId=>threadId===state.thread?.id?state.store.values().filter(item=>item.type==='userMessage'&&!item._local).map(item=>item.id):[],
  onChange:()=>{renderPendingMutations();updateControls();renderThreads();},
  onSent:({threadId,itemId,text,method,result,beforeIds})=>{
    questionNotifications?.answered(threadId,itemId);
    if(method==='turn/start'&&result.turn?.id&&!state.terminalTurns.has(result.turn.id)&&!['completed','failed','interrupted'].includes(result.turn.status))state.activeTurns.set(threadId,result.turn.id);
    if(state.thread?.id!==threadId)return;
    if(method==='turn/steer')state.store.confirmUserEcho({id:`answer:${itemId}`,turnId:result.turnId,text,beforeIds});
    else{state.ledger.merge(result.turn,{observedStartMs:Date.now()});state.turnId=state.activeTurns.get(threadId)||null;state.busy=!!state.turnId;}
    scheduleRender();
  }});

// ---------- Context meter ----------
let pendingContextRead=null;
function renderContext() {
  const id=state.thread?.id||null;
  contextDetails.update(id,state.contexts.get(id)||null,pendingContextRead?.id===id);
  sessionSpeed.select(state.connected?id:null);
  sessionUsage.update(state.connected&&currentRoute==='chat'?id:null,state.contexts.get(id)?.total);
}
function cacheContext(snapshot,source) {
  if(snapshot.turnId)conversation.refreshTurnUsage(snapshot.threadId,snapshot.turnId);
  state.contexts.delete(snapshot.threadId);
  state.contexts.set(snapshot.threadId,{...snapshot,source});
  if(state.contexts.size>512)state.contexts.delete(state.contexts.keys().next().value);
}
function resetContext() {
  pendingContextRead=null;state.contexts.clear();contextDetails.close();renderContext();
}
async function loadSavedContext(id,generation,rebind=false) {
  const request={id},previous=state.contexts.get(id);
  pendingContextRead=request;renderContext();
  const current=()=>pendingContextRead===request&&generation===state.openGeneration&&state.thread?.id===id;
  try{
    if(rebind)await rpc('thread/read',{threadId:id,includeTurns:false});
    if(!current())return;
    const {snapshot}=await api('/api/thread/context',{threadId:id});
    if(!current()||snapshot?.threadId!==id||state.contexts.get(id)!==previous)return;
    const value=contextSnapshot({threadId:id,turnId:snapshot.turnId,tokenUsage:{last:snapshot.last,total:snapshot.total,modelContextWindow:snapshot.window}});
    if(value)cacheContext(value,snapshot.source==='history'?'history':'live');
  }catch{/* Missing or unavailable history stays unknown until an official update arrives. */}
  finally{if(pendingContextRead===request){pendingContextRead=null;renderContext();}}
}

// ---------- Slash menu ----------
function skillContext() {
  const cwd = state.thread?.cwd || state.cwd;
  return { cwd, projectless: state.thread?.projectless === true || !cwd, connected: state.connected,
    serverInstance: state.serverInstance, runtimeTarget: state.runtimeTarget, canImportSkill: state.canImportSkill === true };
}
function readSkillDirectory(cwd, { forceReload = false, signal } = {}) {
  return api('/api/skills/list', { ...(cwd ? { cwd } : {}), ...(forceReload ? { forceReload } : {}) }, { signal });
}
const slashMenu = createSlashMenu({ document, prompt: $('prompt'), menu: $('slash-menu'), el, readSkills: readSkillDirectory,
  context: () => ({ ...skillContext(), thread: !!state.thread, busy: state.busy, sending: state.sending }),
  commands: { new: newThread, compact: () => compactThread(), fork: () => forkCurrentThread(), rename: () => openRename(), model: () => openReasoning(), usage: () => route('usage'), account: () => route('account') },
  onDraftChange: () => { autosizePrompt(); updateControls(); } });
async function releaseUnknownSkill(requestId, current) {
  const marker = scopedPending('skills').find(row => row.requestId === requestId);
  if (!current() || !currentPendingMarker(marker) || marker.status !== 'unknown') return false;
  const response = await api('/api/operations?requestId='+encodeURIComponent(requestId), undefined, {timeoutMs:15000});
  const latest = scopedPending('skills').find(row => row.requestId === requestId);
  if (!current() || !currentPendingMarker(latest)) return false;
  if (!canReleaseUnknownSkill(latest,response)) {
    await handlePendingReconcileResult(latest,response);
    return false;
  }
  pendingMutations.settle(requestId);
  pendingReconcileErrors.delete(requestId);
  noteLedgerChanged();
  return true;
}
const skillsView = mountSkillsView($('settings-skills'), {
  read: readSkillDirectory,
  write: params => performMutation('skills/config/write', params),
  pickImport: () => api('/api/skills/import/pick', {}, { timeoutMs: 310000 }),
  confirmImport: (message, options) => confirmApp(document, message, options),
  installImport: planId => api('/api/skills/import/install', { planId, confirmed:true }),
  pending: () => scopedPending('skills')
    .filter(marker => marker.serverInstance === state.serverInstance)
    .map(marker => ({ requestId: marker.requestId, status:marker.status, path: pendingMutations.envelope(marker.requestId)?.params?.path })),
  releaseUnknown: releaseUnknownSkill,
  onCatalogChanged: () => slashMenu.invalidateSkills(),
});
function syncSkillsContext() {
  skillsView.setContext(skillContext());
  slashMenu.syncContext();
}
async function compactThread() {
  if (!state.thread || state.busy || state.sending) return;
  const threadId = state.thread.id; state.sending = true; updateControls(); activity('正在请求压缩上下文…');
  try { await performMutation('thread/compact/start', { threadId }); if (state.thread?.id === threadId) activity('已开始压缩上下文'); }
  catch (e) { showMutationFailure(e, '压缩上下文'); activity(''); }
  finally { state.sending = false; updateControls(); }
}
const nativePromptSizing = CSS.supports('field-sizing', 'content');
let promptMeasure = null;
function autosizePrompt() {
  if (nativePromptSizing) return;
  // Older WebViews need a measurement outside the flex flow. Shrinking the live
  // field to measure it momentarily expands the transcript and clamps its scrollTop.
  const prompt = $('prompt');
  if (!promptMeasure) {
    promptMeasure = el('textarea','prompt-measure');
    promptMeasure.tabIndex = -1;
    promptMeasure.setAttribute('aria-hidden','true');
    promptMeasure.readOnly = true;
    prompt.after(promptMeasure);
  }
  promptMeasure.style.width = prompt.offsetWidth + 'px';
  promptMeasure.value = prompt.value;
  const height = Math.min(promptMeasure.scrollHeight,220) + 'px';
  if (prompt.style.height !== height) prompt.style.height = height;
}
if (!nativePromptSizing) window.addEventListener('resize', autosizePrompt);
// IME composition always wins: Enter/arrow keys confirm candidates and must not send or move the menu.
function onPromptKey(e) {
  if (e.isComposing || e.keyCode === 229) return;
  if(e.repeat&&['Enter','Tab'].includes(e.key)){e.preventDefault();return;}
  if (slashMenu.handleKey(e)) return;
  if (e.key === 'Tab' && !e.shiftKey && state.busy && state.thread && hasDraft()) { e.preventDefault(); queueDraft(); return; }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
}

function readDraftModelChoice() {
  let model='';
  try {
    model=localStorage.getItem('codex-light-model')||'';
    const saved=JSON.parse(localStorage.getItem('codex-light-draft-model'));
    if(typeof saved?.model==='string')return saved;
  }catch{}
  return {model};
}
function queueLiveTurnSettings(patch,saved) {
  const threadId=state.thread?.id, turnId=state.turnId, instance=state.serverInstance;
  if(!state.busy||!threadId)return;
  if(!turnId||!instance||!state.connected||sessionFor(threadId)?.activeTurnId!==turnId){
    Promise.resolve(saved??true).then(ok=>{if(ok&&state.thread?.id===threadId)notice('当前任务由其他窗口运行，所选设置将在下一轮使用。');});return;
  }
  const key=JSON.stringify([instance,threadId,turnId]);
  let update=liveSettingsUpdates.get(key);
  if(!update){
    update={fields:{},timer:null,pending:false,revision:0};
    update.finished=new Promise(resolve=>{update.finish=resolve;});
    liveSettingsUpdates.set(key,update);
  }
  if(saved)update.saved=saved;
  Object.assign(update.fields,patch);
  update.revision++;
  clearTimeout(update.timer);
  update.timer=setTimeout(flush,140);
  const visible=()=>state.thread?.id===threadId&&state.serverInstance===instance;
  async function flush(){
    if(update.pending)return;
    const fields=update.fields, revision=update.revision;
    update.fields={};
    const feedback=message=>{if(visible()&&revision===update.revision)notice(message);};
    try{
      update.pending=true;
      if(update.saved && !await update.saved)return;
      if(state.serverInstance!==instance||!state.connected||sessionFor(threadId)?.activeTurnId!==turnId){
        feedback('本轮已结束或断开，所选设置将在下一轮使用。');return;
      }
      // A null model or effort is a no-op in the live protocol, including when a default is unknown.
      if(!Object.keys(fields).some(name=>fields[name]!=null||name==='serviceTier')){
        feedback('将在下一轮按 Codex 配置使用默认设置。');return;
      }
      const result=await performMutation('turn/settings/update',{threadId,turnId,...fields});
      if(result?.status==='applied')feedback('已更新本轮设置，将用于后续步骤。');
      else if(result?.status==='targetUnavailable')feedback('本轮已结束，所选设置将在下一轮使用。');
      else feedback('引擎未确认本轮设置，所选设置将在下一轮使用。');
    }catch(error){
      feedback(Number(error.code)===-32601||error.code==='TURN_SETTINGS_DISABLED'?'当前引擎不支持运行中更改，所选设置将在下一轮使用。':'调整本轮设置未获确认：'+error.message+'。所选设置将在下一轮使用。');
    }finally{
      update.pending=false;
      clearTimeout(update.timer);
      if(Object.keys(update.fields).length)update.timer=setTimeout(flush,0);
      else {liveSettingsUpdates.delete(key);update.finish();}
    }
  }
}
function chooseEffort(effort, modelChanged=false) {
  state.reasoning.override=effort;
  draftModelChoice={model:$('model').value,effortModel:effectiveModel().id,effort};
  try{localStorage.setItem('codex-light-draft-model',JSON.stringify(draftModelChoice));}
  catch{notice('模型和思考强度已应用于当前窗口，重新打开后可能需要重新选择。',true);}
  populateEfforts();
  const active=effectiveModel();
  const view=configuredReasoningView(active.model,state.reasoning,sessionDefaults.snapshot().value,active.id);
  const patch=modelChanged?{model:active.id,effort:view.effective??null}:{effort:view.effective??null};
  // An empty selector inherits. The running step can use the resolved value, while the
  // stored preference must never turn a config default into a fixed model or effort.
  const selected=modelChanged?{model:$('model').value||null,effort}:{effort};
  const saved=state.thread?saveThreadReasoning(selected):null;
  if(modelChanged&&active.id)patch.serviceTier=sessionControls.modelChangeTier();
  queueLiveTurnSettings(patch,saved);
}
function chooseModel(value) {
  $('model').value=value;
  state.reasoning=switchedReasoning(effectiveModel().model,state.reasoning,{
    configuredModel:sessionDefaults.snapshot().value?.model,selectedModel:value
  });
  chooseEffort(state.reasoning.override,true);
}
function restoreThreadReasoning(result, override) {
 sessionControls.restore(result.sessionPermission,result.serviceTier);
 threadReasoning={threadId:state.thread.id,scope:result.sessionReasoning?.scope??result.sessionPermission?.scope,
  model:result.model,effort:result.reasoningEffort??override,choice:result.sessionReasoning?.choice,events:0};
 renderThreadReasoning(override);
}
function renderThreadReasoning(override){
 const {threadId,choice}=threadReasoning;
 const selected={...choice,...reasoningWrites.get(threadId)?.patch};
 const model=Object.hasOwn(selected,'model')?selected.model||'':threadReasoning.model||'';
 if(model&&![...$('model').options].some(option=>option.value===model))$('model').append(new Option(model+'（目录外）',model));
 $('model').value=model;
 state.reasoning=restoredReasoning(threadReasoning.effort);
 state.reasoning.override=Object.hasOwn(selected,'effort')?selected.effort:override||null;
 const catalog=effectiveModel().model;
 if(choice?.effort && catalog && !reasoningChoices(catalog).includes(state.reasoning.override))state.reasoning.override=null;
 populateEfforts();
}
function applyReasoningChange(change){
 if(!threadReasoning || state.thread?.id!==change.threadId || threadReasoning.threadId!==change.threadId)return;
 if(change.scope && threadReasoning.scope && change.scope!==threadReasoning.scope)return;
 threadReasoning.events++;
 for(const [field,value] of Object.entries(change.patch)){
  if(Object.hasOwn(change.choice||{},field))continue;
  if(field==='effort' && value===null && change.patch.model!==null)continue;
  threadReasoning[field]=value;
 }
 if(Object.hasOwn(change,'choice'))threadReasoning.choice=change.choice;
 renderThreadReasoning();
}
function saveThreadReasoning(patch){
 const threadId=state.thread.id, instance=state.serverInstance,scope=threadReasoning?.scope;
 let write=reasoningWrites.get(threadId);
 if(!write){write={patch:{},unsent:{},queue:Promise.resolve(),revision:0};reasoningWrites.set(threadId,write);}
 Object.assign(write.patch,patch);Object.assign(write.unsent,patch);
 const revision=++write.revision;
 write.queue=write.queue.then(async()=>{
  if(reasoningWrites.get(threadId)!==write||state.serverInstance!==instance||revision!==write.revision)return false;
  const changes=write.unsent;
  write.unsent={};
  const currentScope=scope||(await api('/api/session/reasoning',{threadId})).scope;
  if(reasoningWrites.get(threadId)!==write||state.serverInstance!==instance)return false;
  const events=threadReasoning?.events;
  const saved=await api('/api/session/reasoning',{threadId,scope:currentScope,...changes});
  if(saved.scope!==currentScope)throw new Error('对话设置的账户已变化。');
  if(reasoningWrites.get(threadId)===write && threadReasoning?.events===events)applyReasoningChange({threadId,...saved,patch:changes});
  return true;
 }).catch(error=>{if(state.thread?.id===threadId&&reasoningWrites.get(threadId)===write)notice('未能保存对话模型设置：'+error.message,true);return false;})
 .finally(()=>{if(reasoningWrites.get(threadId)===write&&revision===write.revision){
   reasoningWrites.delete(threadId);
   if(threadReasoning?.threadId===threadId && state.thread?.id===threadId)renderThreadReasoning();
 }});
 return write.queue;
}
function populateEfforts() {
 if(!state.thread){
   const saved=draftModelChoice.model;
   $('model').value=state.models.some(row=>row.model===saved&&!row.hidden)?saved:'';
   const active=effectiveModel();
   state.reasoning=restoredReasoning(null);
   if(saved===$('model').value&&active.id===draftModelChoice.effortModel&&reasoningChoices(active.model).includes(draftModelChoice.effort)){
     state.reasoning.override=draftModelChoice.effort;
   }
 }
 const model=effectiveModel().model;
 const select=$('effort');select.replaceChildren(new Option('默认 / 继承线程设置',''));
 for(const value of reasoningChoices(model))select.append(new Option(effortLabel(value),value));
 const explicit=reasoningParameter(state.reasoning);if(explicit&&![...select.options].some(option=>option.value===explicit))select.append(new Option(effortLabel(explicit),explicit));select.value=explicit||'';renderReasoning();
}
function renderReasoning() {
  const defaults=sessionDefaults.snapshot(), active=effectiveModel(), view=configuredReasoningView(active.model,state.reasoning,defaults.value,active.id), modelView=defaultModelView(state.models,$('model').value,defaults.value);
  const name=formatModelDisplayName(modelView.displayName)||(defaults.loading?'正在读取模型…':'选择模型'), effortText=view.effective?effortLabel(view.effective):'';
  const label=view.effective?effortLabel(view.effective):(defaults.loading?'读取中…':'默认');
  const defaultLabel=defaults.value?.model?`自动 · ${formatModelDisplayName(defaults.value.model)}`:'自动（Codex 配置）';
  $('model-trigger-name').textContent=name;
  $('model-trigger-effort').textContent=effortText?' · '+effortText:'';
  $('reasoning-model-name').title=modelView.source==='config'?`Codex 配置默认模型：${boundedText(modelView.id||'未知',512)}${modelView.outsideCatalog?'（不在当前模型目录）':''}`:name; $('reasoning-model-name').textContent=name; $('reasoning-label').textContent=label;
  sessionControls.render();
  $('reasoning-label').title=view.source==='override'?'显式发送所选思考强度':view.source==='inherited'?'沿用服务端线程设置；不发送强度覆盖':view.configUnsupported?`Codex 配置默认强度 ${effortLabel(view.configured)} 不在当前模型支持范围；不会发送`:view.configSupport==='unknown'?`Codex 配置默认强度 ${effortLabel(view.configured)} 是否被当前模型支持未知；不会发送`:view.source==='config'?'Codex 配置默认强度；发送时不写入覆盖值':defaults.loading?'正在读取 Codex 配置默认值；尚未发送任何设置':defaults.error?'Codex 配置默认值读取失败；发送时不写入覆盖值，可打开模型列表重试':'未读取 Codex 配置默认值；发送时不写入覆盖值';
  const range=$('reasoning-range');range.max=String(Math.max(0,view.choices.length-1));range.value=String(Math.max(0,view.index));range.disabled=!view.choices.length||$('effort').disabled;
  range.setAttribute('aria-valuetext',view.effective?effortAccessibleLabel(view.effective)+(view.source==='config'?'（Codex 配置默认）':view.source==='inherited'?'（继承线程设置）':'（显式发送）'):view.configUnsupported?`配置强度 ${effortAccessibleLabel(view.configured)} 不被当前模型支持`:view.configSupport==='unknown'?`配置强度 ${effortAccessibleLabel(view.configured)} 是否被当前模型支持未知`:'默认强度未知');
  const ratio=Math.max(0,view.index)/Math.max(1,view.choices.length-1);
  $('reasoning-track').style.setProperty('--effort-fill',`calc(14px + (100% - 28px) * ${ratio})`);$('reasoning-track').classList.toggle('unknown',view.index<0);
  const ticks=document.createDocumentFragment();for(let i=0;i<view.choices.length;i++){const tick=el('i');tick.style.left=`${100*i/Math.max(1,view.choices.length-1)}%`;ticks.append(tick);} $('reasoning-ticks').replaceChildren(ticks);
  const entries=[{model:'',displayName:defaultLabel},...state.models.filter(m=>!m.hidden)];if($('model').value&&!entries.some(entry=>entry.model===$('model').value))entries.push({model:$('model').value,displayName:$('model').value+'（目录外）'});
  const options=document.createDocumentFragment();for(const entry of entries){const button=el('button','model-option');button.type='button';button.setAttribute('aria-pressed',String(entry.model===$('model').value));button.title=entry.model?`${formatModelDisplayName(entry.displayName||entry.model)} · ${entry.model}`:'使用 Codex 配置中的当前模型';button.append(el('span','',formatModelDisplayName(entry.displayName||entry.model)),entry.model===$('model').value?icon(document,'check',{size:15}):el('span'));button.addEventListener('click',()=>{chooseModel(entry.model);showReasoningModels(false);$('reasoning-range').disabled?$('model-list-open').focus():$('reasoning-range').focus();});options.append(button);}
  if(defaults.loading)options.append(el('p','model-option-note','正在读取 Codex 配置默认值…'));
  else if(defaults.error){const retry=el('button','model-option');retry.type='button';retry.append(el('span','','重新读取 Codex 配置默认值'));retry.title='上次读取失败：'+boundedText(defaults.error,300);retry.addEventListener('click',()=>{sessionDefaults.retry();});options.append(retry);}
  $('model-options').replaceChildren(options);
}
function showReasoningModels(show){$('reasoning-controls').classList.toggle('hidden',show);$('reasoning-model-list').classList.toggle('hidden',!show);$('reasoning-popover').classList.toggle('models-open',show);}
function closeReasoning(focus=true){if($('reasoning-popover').classList.contains('hidden'))return;$('reasoning-popover').classList.add('hidden');$('model-trigger').setAttribute('aria-expanded','false');if(focus)$('model-trigger').focus();}
function openReasoning(){if($('model-trigger').disabled)return;renderReasoning();showReasoningModels(false);$('reasoning-popover').classList.remove('hidden');$('model-trigger').setAttribute('aria-expanded','true');($('reasoning-range').disabled?$('model-list-open'):$('reasoning-range')).focus();}
$('model-trigger').addEventListener('click',()=>{$('reasoning-popover').classList.contains('hidden')?openReasoning():closeReasoning();});
const chooseRangeEffort=()=>chooseEffort(reasoningChoices(effectiveModel().model)[Number($('reasoning-range').value)]||null);
$('reasoning-range').addEventListener('input',chooseRangeEffort);
$('reasoning-range').addEventListener('click',()=>{if($('reasoning-track').classList.contains('unknown')&&!$('reasoning-range').disabled)chooseRangeEffort();});
$('reasoning-reset').addEventListener('click',()=>{chooseEffort(resetReasoning(effectiveModel().model,state.reasoning).override);if(!state.reasoning.override)notice('模型目录未提供默认强度，已取消本地覆盖；继续继承线程设置，不代表已清除服务端原强度。');});
$('model-list-open').addEventListener('click',()=>{showReasoningModels(true);const active=$('model-options').querySelector('[aria-pressed="true"]');active?.focus();active?.scrollIntoView({block:'nearest',inline:'nearest'});});
$('model-list-back').addEventListener('click',()=>{showReasoningModels(false);$('model-list-open').focus();});
$('effort').addEventListener('change',()=>chooseEffort($('effort').value||null));
$('reasoning-popover').addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeReasoning();}else if(['ArrowDown','ArrowUp'].includes(event.key)&&!$('reasoning-model-list').classList.contains('hidden')){const buttons=[...$('reasoning-model-list').querySelectorAll('button')];const index=buttons.indexOf(document.activeElement);event.preventDefault();const next=buttons[(index+(event.key==='ArrowDown'?1:buttons.length-1))%buttons.length];next?.focus();next?.scrollIntoView({block:'nearest',inline:'nearest'});}});
document.addEventListener('pointerdown',event=>{if(!event.target.closest('.model-control'))closeReasoning(false);});
document.addEventListener('focusin',event=>{if(!event.target.closest('.model-control'))closeReasoning(false);});
document.addEventListener('keydown',event=>{if(event.ctrlKey&&event.shiftKey&&event.key.toLowerCase()==='m'){event.preventDefault();openReasoning();}});
// model-loader:start
async function loadModels(current=()=>true) {
  const generation=++state.modelGeneration,rows=[],seenModels=new Set(),seenCursors=new Set();let cursor=null;
  for(let page=0;page<5;page++){
    const params={limit:100};if(cursor)params.cursor=cursor;
    const result=await rpc('model/list',params);
    if(!current()||generation!==state.modelGeneration)return;
    for(const model of Array.isArray(result?.data)?result.data:[]){if(!model||typeof model.model!=='string'||!model.model||seenModels.has(model.model))continue;if(rows.length>=500)throw new Error('模型目录超过 500 项，已停止加载；现有模型列表保持不变。');seenModels.add(model.model);rows.push(model);}
    const next=typeof result?.nextCursor==='string'&&result.nextCursor?result.nextCursor:null;if(!next)break;
    if(seenCursors.has(next))throw new Error('模型目录分页游标未前进，已停止加载；现有模型列表保持不变。');
    if(page===4)throw new Error('模型目录超过 5 页，未完整加载；现有模型列表保持不变。');
    seenCursors.add(next);cursor=next;
  }
  if(!current()||generation!==state.modelGeneration)return;
  // Navigation can change the current selection while the catalog is loading.
  const selected=$('model').value;
  state.models=rows;$('model').replaceChildren(new Option('使用 Codex 配置默认模型',''));for(const model of rows.filter(m=>!m.hidden))$('model').append(new Option(formatModelDisplayName(model.displayName||model.model),model.model));if(selected&&!Array.from($('model').options).some(option=>option.value===selected))$('model').append(new Option(selected+'（目录外）',selected));$('model').value=selected;populateEfforts();
}
// model-loader:end
function renderRequests({notify=false}={}) {
  renderApprovals($('approvals'), { document, requests: state.requests, currentThreadId: state.thread?.id || null, api, notice, el, boundedText, lookupFileChange, rerender: renderRequests });
  questionNotifications?.sync(state.requests,{notify});
}
// Files/diff for a modern fileChange approval come from its correlated item (loaded only for the open conversation).
function lookupFileChange(threadId, itemId) {
  if (typeof itemId !== 'string' || !itemId) return null;
  if (!state.thread || threadId !== state.thread.id) return { reason: '该请求来自未打开的对话' };
  const item = state.store.items.get(itemId);
  if (!item || item.type !== 'fileChange' || !Array.isArray(item.changes) || !item.changes.length) return { reason: '对话中还没有收到这次修改' };
  // The item store keeps a bounded display projection; say so instead of presenting a cut diff as complete.
  const truncated = item.changes.length >= 50 || item.changes.some(change => typeof change?.diff === 'string' && /〔界面显示已截断|\[显示摘要已截断\]/.test(change.diff));
  return { changes: item.changes, truncated, partial: item._complete === false };
}
function fileApprovalPending() { for (const request of state.requests.values()) if (request.method === 'item/fileChange/requestApproval') return true; return false; }
// Server requests are keyed by native id type+value; a repeated instance (same token) is not a new prompt.
function trackRequest(message) {
  if (!validRequestId(message.id)) return false;
  const key = requestKey(message.id), previous = state.requests.get(key);
  if (previous && previous.bridgeRequestToken === message.bridgeRequestToken) return false;
  state.requests.set(key, message); return true;
}
function dropRequests(match) { let changed = false; for (const [key, request] of state.requests) if (match(request)) { state.requests.delete(key); changed = true; } if (changed) renderRequests(); }
function onEvent(message) {
  if(message.method==='bridge/threadReasoningChanged'||message.method==='thread/settings/updated'){
    const {threadId,threadSettings}=message.params||{};
    const change=threadSettings?{threadId,patch:Object.fromEntries(['model','effort'].filter(key=>Object.hasOwn(threadSettings,key)).map(key=>[key,threadSettings[key]]))}:message.params;
    if(change?.patch){
      if(openingReasoning?.threadId===threadId)openingReasoning.events.push(change);
      applyReasoningChange(change);
    }
    return;
  }
  if(message.method==='bridge/mobileTasks'){taskNotifications?.apply(message.params);return;}
  if(message.method==='bridge/questionIgnored'){questionIgnores.apply(message.params.threadId,message.params.itemId);return;}
  if(message.method==='bridge/runtimeUpdate'){runtimePanel?.updateAvailable();return;}
  if(message.method==='bridge/sessionPermissionChanged'){
    sessionControls.changed(message.params).catch(error=>notice('未能同步对话批准方式：'+error.message,true));
    return;
  }
  questionNotifications?.observe(message);
  accountQuota.handleEvent(message);
  if(message.method==='account/rateLimits/updated')void statsView.refreshBalance();
  if(message.method==='thread/name/updated'){
    const {threadId,threadName}=message.params||{};
    if(typeof threadId!=='string'||(threadName!==null&&typeof threadName!=='string'))return;
    updateThreadName(threadId,threadName);
    return;
  }
  if(['thread/archived','thread/deleted'].includes(message.method)){
    if(typeof message.params?.threadId==='string')removeListedThread(message.params.threadId,message.method==='thread/deleted');
    return;
  }
  if(message.method==='thread/unarchived')questionNotifications?.restoreThread(message.params?.threadId);
  if(message.method==='thread/status/changed'){
    const {threadId,status}=message.params||{};
    if(typeof threadId!=='string')return;
    for(const thread of [...state.threads,state.thread,unindexedThreads.get(threadId)])if(thread?.id===threadId)thread.status=status;
    if(['idle','systemError'].includes(status?.type)){
      clearRunningTurn(threadId,state.activeTurns.get(threadId));
      if(state.thread?.id===threadId)scheduleRender();
    }
    renderThreads();updateControls();return;
  }
  if(message.method==='account/updated')return accountIdentity.verify();
  if(message.method==='bridge/statisticsRecovered'){statsView.recovered();conversation.recoverTurnUsage();sessionSpeed.refresh();sessionUsage.refresh();return;}
  if(message.method==='bridge/accountLogin'){accountLoginPanel.update(message.params);if(['completed','loggedOut'].includes(message.params?.state)){accountIdentity.reset();resetAccountScopedViews('账户已改变');}return;}
  if(message.method==='thread/tokenUsage/updated'){if(!state.connected)return;const snapshot=contextSnapshot(message.params);if(snapshot){cacheContext(snapshot,'live');if(snapshot.threadId===state.thread?.id)renderContext();statsView.usageUpdated();}return;}
  if(message.method==='bridge/threadReads'){
    const {scope, reads} = message.params;
    const changedScope = threadReadReporter.connect(scope);
    if (changedScope) {
      threadCompletion.reset();
      renderedThreadReads = null;
    }
    if (threadCompletion.syncRead(reads) || changedScope) renderThreads();
    scheduleThreadRead();
    return;
  }
  if(message.method==='bridge/threadSessions'){applyThreadSessions(message.params);return;}
  if(message.method==='skills/changed'){slashMenu.invalidateSkills();void skillsView.invalidate();return;}
  if (message.method === 'remoteControl/status/changed') { applyRemoteStatus(message.params); return; }
  if (message.method === 'bridge/nodeUpdate') { if(aboutView===desktopAbout)updateNodeRuntime(message.params); return; }
  if (message.method === 'bridge/appUpdate') { if(aboutView===desktopAbout)applyAutomaticUpdate(message.params); return; }
  if (message.method === 'bridge/dshSnapshot') { ingestDshSnapshot(message.params); return; }
  if (message.method === 'bridge/threadSubmission') { const {threadId,submittedAt}=message.params||{};recordThreadSubmission(threadId,submittedAt);return; }
  if (message.method === 'bridge/status') { const connected=!!message.params?.connected;if(!connected)dropRequests(()=>true);const reconnected=connected&&!state.connected;setConnected(connected);if(reconnected&&state.thread?.id){void loadSavedContext(state.thread.id,state.openGeneration,true);historyAutoLoad.fill();}if(connected&&(!state.serverInstance||!state.cliVersion))syncStatus().catch(error=>notice('连接已建立，但本地服务状态读取失败：'+error.message,true)); if (message.params?.error) notice(message.params.error, true); return; }
  if (message.method === 'bridge/warning') { notice(message.params?.message || '本地桥接警告'); return; }
  if (message.method === 'bridge/titleSummary') { titleSettings.reset(); if(message.params?.state==='failed')notice(message.params.error||'标题总结未完成，保留原名称。',true); return; }
  if (message.id !== undefined && message.method) { if (trackRequest(message)) renderRequests({notify:true}); return; }
  const p = message.params || {};
  if(state.thread?.id===p.threadId&&message.method==='turn/completed')sessionSpeed.refresh();
  if(currentRoute==='chat'&&state.thread?.id===p.threadId&&message.method==='item/completed')sessionSpeed.activity(p.item);
  if(message.method!=='turn/completed')threadCompletion.observe(message);
  if (message.method === 'serverRequest/resolved') { if (validRequestId(p.requestId)) { state.requests.delete(requestKey(p.requestId)); renderRequests(); } return; }
  if (message.method === 'thread/closed' && typeof p.threadId === 'string' && p.threadId) {
    clearRunningTurn(p.threadId,state.activeTurns.get(p.threadId));
    dropRequests(request => requestThread(request) === p.threadId);
    renderThreads();updateControls();
  }
  if (message.method === 'error' && (!p.threadId || p.threadId === state.thread?.id)) { notice(p.error?.message || p.message || 'Codex 返回错误', true); return; }
  if (message.method === 'turn/started') {
    if(!p.threadId||!p.turn?.id||state.terminalTurns.has(p.turn.id))return;
    state.activeTurns.set(p.threadId, p.turn?.id);
    renderThreads();watchExternalTurn();
  }
  if (message.method === 'turn/completed') { const completedId=p.turn?.id||p.turnId;if(!completedId)return;dropRequests(request => p.threadId && requestThread(request) === p.threadId && (request.params?.turnId ? request.params.turnId === completedId : request.method !== 'mcpServer/elicitation/request'));clearRunningTurn(p.threadId,completedId);state.interruptingTurns.delete(completedId);state.terminalTurns.add(completedId);if(state.terminalTurns.size>1000)state.terminalTurns.delete(state.terminalTurns.values().next().value);
    // The queue only advances after a normal completion; anything else waits for the user.
    pauseQueueForOutcome(p.threadId,p.turn?.status);
    if(state.thread?.id===p.threadId){
      state.ledger.merge(p.turn,{observedEndMs:Date.now()});
      if(state.turnId===completedId||!state.turnId){state.busy=false;state.turnId=null;}
      activity(p.turn?.status==='failed'?'任务未完成':'');
      if(p.turn?.error)notice(p.turn.error.message||JSON.stringify(p.turn.error),true);
      renderMessages();renderQueue();updateControls();
    }
    const viewed=p.threadId===readableThreadId()&&(conversationScroll.atBottom||visibleLatestReply()===completedId);
    threadCompletion.observe(message,viewed?p.threadId:null);
    renderThreads(); loadThreads().catch(error => notice('无法刷新对话列表：' + error.message, true)); setTimeout(() => drainQueue(p.threadId), 0);return; }
  if (!state.thread || p.threadId !== state.thread.id) return;
  const turnId = typeof p.turnId === 'string' ? p.turnId : p.turn?.id;
  if (message.method === 'item/started' || message.method === 'item/completed') {
    const extra = { _complete: message.method === 'item/completed' };
    if (turnId) extra._turnId = turnId;
    if (Number.isFinite(p.startedAtMs)) extra._startedAtMs = p.startedAtMs;
    if (Number.isFinite(p.completedAtMs)) extra._completedAtMs = p.completedAtMs;
    // ItemStore reconciles confirmed steer echoes for both events and history, one acknowledgement at a time.
    state.store.upsert({ ...p.item, ...extra }); dshTasks.ingest(p.threadId, { ...p.item, ...extra }); scheduleRender(); if (p.item?.type === 'fileChange' && fileApprovalPending()) renderRequests();
  }
  else if (message.method === 'item/mcpToolCall/progress') { if (dshTasks.progress(p.threadId, p.itemId, p.message)) scheduleRender(); }
  else if (message.method === 'turn/diff/updated') { state.ledger.setDiff(p.turnId, p.diff); scheduleRender(); }
  else if (message.method === 'item/fileChange/patchUpdated') { const item = state.store.items.get(p.itemId); state.store.upsert({ ...(item || { id: p.itemId, type: 'fileChange', status: 'inProgress' }), changes: p.changes, _turnId: p.turnId, _complete: false }); scheduleRender(); if (fileApprovalPending()) renderRequests(); }
  else if (message.method === 'item/agentMessage/delta') { state.store.delta(p.itemId, p.delta); tagTurn(p.itemId, turnId); scheduleRender(p.itemId); }
  else if (message.method === 'item/reasoning/summaryTextDelta') { const item = state.store.items.get(p.itemId) || { id: p.itemId, type: 'reasoning', summary: [] }; const summary = Array.isArray(item.summary) ? [...item.summary] : []; const index = Number.isSafeInteger(p.summaryIndex) && p.summaryIndex >= 0 && p.summaryIndex < 64 ? p.summaryIndex : summary.length; summary[index] = boundedText((summary[index] || '') + p.delta, 16000); state.store.upsert({ ...item, summary, _turnId: item._turnId || turnId, _complete: false }); scheduleRender(); }
  else if (message.method === 'item/commandExecution/outputDelta') { state.store.delta(p.itemId, p.delta, 'commandExecution', 'aggregatedOutput'); tagTurn(p.itemId, turnId); scheduleRender(); }
  else if (message.method === 'turn/started') { state.ledger.merge(p.turn, { observedStartMs: Date.now() }); state.turnId = p.turn?.id; state.busy = true; activity(''); renderMessages(); updateControls(); }
  else if (message.method === 'turn/plan/updated') { state.store.upsert({ id: `plan-${p.turnId}`, type: 'plan', text: p.explanation || '', content: p.plan, _turnId: p.turnId, _complete: true }); scheduleRender(); }
}
function tagTurn(itemId, turnId) { const item = state.store.items.get(itemId); if (item && turnId && !item._turnId) item._turnId = turnId; }
/** Bridge-owned sessions (this process only). Used to keep background work visible after navigation. */
function applyThreadSessions(params) {
  if(!Array.isArray(params?.threads))return;
  state.threadSessions = params.threads.filter(row => typeof row?.threadId === 'string');
  // An idle bridge snapshot can precede turn/completed. Keep the turn until its
  // outcome arrives or watchExternalTurn reads it, so an interrupt cannot send the queue.
  for (const row of state.threadSessions) if (row.activeTurnId && !state.terminalTurns.has(row.activeTurnId)) state.activeTurns.set(row.threadId, row.activeTurnId);
  const failed = state.threadSessions.find(row => row.releaseError); if (failed) notice(failed.releaseError, true);
  updateControls(); renderThreads();watchExternalTurn();drainAll();
}
async function syncStatus() {
  const updateRevision=desktopAbout.revision;
  const status = await api('/api/status'); applyAccessMode(state.lan || status.access === 'lan'); state.cliVersion = typeof status.version==='string'&&status.version ? boundedText(status.version,300) : null; state.desktop = status.desktop === true; state.canImportSkill = status.canImportSkill === true; state.runtimeTarget=status.runtimeTarget==='wsl'?'wsl':'native';applyRuntimeTarget(); if($('version-info'))$('version-info').textContent=state.cliVersion||'未知'; document.body.classList.toggle('native-desktop',state.desktop); $('runtime-close-info').textContent='停止服务会中断正在运行的本应用任务。'; $('reopen-info').textContent=state.desktop?'重新打开窗口可查看对话历史。':status.reopenAvailable===true?'可通过启动器重新打开本地界面。':status.reopenAvailable===false?'关闭后可能需要重新运行启动器。':''; if(!state.desktop&&status.reopenError)$('reopen-info').textContent+=' '+boundedText(status.reopenError,800); if(state.serverInstance !== (status.serverInstance || null)){resetContext();sessionControls.reset();deactivatePendingReconciler();historyCaps.unsupported.clear();pluginPanel.reset();configPanel.reset();resetUsage();resetRuntimePanel();dshLive.reset();if(state.serverInstance)remoteReset({statusMessage:'本地服务已切换。',pairMessage:'服务已切换，旧配对码已隐藏。',devicesMessage:'刷新后可查看当前服务的设备。'});}state.serverInstance = status.serverInstance || null; state.demo = !!status.demo; setConnected(status.connected, status.demo ? '演示模式 · 不调用模型' : undefined); if(state.desktop){await loadDesktopState();preferencesView.syncHostTheme();} preferencesView.offerFirstTheme(); $('mode-info').textContent = status.demo ? '演示模式，不消耗额度' : '本地 Codex app-server';
  // Replace with the server's current set; unchanged instances keep their card and draft.
  if(aboutView===mobileAbout)mobileAbout.setHostVersion(status.appVersion);
  if(status.nodeUpdate&&aboutView===desktopAbout)updateNodeRuntime(status.nodeUpdate);
  if(status.appUpdate&&aboutView===desktopAbout&&desktopAbout.revision===updateRevision)applyAutomaticUpdate(status.appUpdate);
  applyThreadSessions(status.threadSessions); const pending = new Map(); for (const request of status.pendingRequests || []) if (validRequestId(request?.id)) { const key = requestKey(request.id), known = state.requests.get(key); pending.set(key, known && known.bridgeRequestToken === request.bridgeRequestToken ? known : request); } state.requests = pending; renderRequests();
  if (status.demo) notice('当前是演示模式：仅测试界面和协议，不会调用真实模型。'); engineOnboarding.start(); return status;
}
async function events() {
  let delay = 1000; let reconnected = false;
  while (!state.shuttingDown) {
    let reader; const controller = new AbortController(); state.eventController = controller;
    try {
      const eventPath=taskNotifications?'/api/events?mobileTasks=1'+(taskNotifications.details?'&details=1':''):'/api/events';
      const response = await fetch(eventPath, { signal: controller.signal, headers: { Authorization: `Bearer ${token}` } }); if (!response.ok) throw new Error(`事件连接失败 (${response.status})`);
      lastEventAt=Date.now();
      reader = response.body.getReader(); eventsReconnecting = false; const decoder = new TextDecoder(); let buffer = ''; await syncStatus(); delay = 1000;
      offlineSnapshot?.ready();
      if (reconnected && state.thread) {
        try { await openThread(state.thread); }
        catch (error) { notice('已恢复连接，重新载入对话失败：'+error.message, true); }
      }
      taskNavigationReady=true;taskNotifications?.reconcile();questionIgnores.refresh();
      reconnected = true;
      while (true) {
        // The server sends a keepalive every 15 seconds. A silent socket must not keep stale task notifications alive.
        const watchdog=setTimeout(()=>controller.abort(new DOMException('本地事件流已超过 60 秒未收到数据','TimeoutError')),60000);
        let chunk;try{chunk=await reader.read();}finally{clearTimeout(watchdog);}
        const { value, done } = chunk; if (done) throw new Error('事件连接已关闭');lastEventAt=Date.now(); buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 8 * 1024 * 1024) throw new Error('事件超过界面缓冲限制');
        let split; while ((split = buffer.indexOf('\n\n')) >= 0) { const raw = buffer.slice(0, split); buffer = buffer.slice(split + 2); const data = raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n'); if (data) { try { onEvent(JSON.parse(data)); } catch (e) { notice('无法处理事件：' + e.message, true); } } }
      }
    } catch (error) {
      taskNavigationReady=false;
      threadReadReporter.disconnect();
      if (!state.shuttingDown) {
        console.warn('本地事件连接重试', error.name, error.message);
        eventsReconnecting = true;
        setConnected(false);
      }
    }
    finally { controller.abort(); if (reader) { try { await reader.cancel(); } catch {} } }
    await new Promise(r => setTimeout(r, delay)); delay = Math.min(10000, delay * 2);
  }
}
$('add-file').addEventListener('click',()=>$('file-attachment-input').click());
// Paste: only the event's own clipboardData; text-only pastes stay native. The whole batch is validated first.
$('prompt').addEventListener('paste', event => {
  const files = pastedFiles(event.clipboardData);
  if (!files.length) return;
  event.preventDefault();
  if (!state.connected) { notice('尚未连接 Codex，粘贴的附件没有添加。', true); return; }
  if (state.uploadingImages || state.sending) { notice('正在处理上一批附件或发送，粘贴的附件没有添加；完成后请再粘贴一次。', true); return; }
  const batch = classifyPaste(files, attachmentDraft.values().length + fileAttachmentDraft.values().length);
  if (batch.errors.length) { notice('粘贴的附件没有添加：' + batch.errors.join('；'), true); return; }
  // Named copies so uploads/chips use a readable name even for nameless screenshots.
  const named = rows => rows.map(({ file, name }) => file.name === name ? file : new File([file], name, { type: file.type, lastModified: file.lastModified }));
  void uploadChosenAttachments([...named(batch.images), ...named(batch.files)]);
});
function canDropAttachments() {
  return currentRoute === 'chat' && !state.loadingThread && !$('add-file').disabled && !document.querySelector('dialog[open]');
}
const isFileDrag = event => Array.from(event.dataTransfer?.types || []).includes('Files');
const clearDropHint = () => $('compose').classList.remove('is-file-drop');
for (const type of ['dragenter', 'dragover']) window.addEventListener(type, event => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  const allowed = canDropAttachments();
  event.dataTransfer.dropEffect = allowed ? 'copy' : 'none';
  $('compose').classList.toggle('is-file-drop', allowed);
});
window.addEventListener('dragleave', event => { if (!event.relatedTarget) clearDropHint(); });
window.addEventListener('dragend', clearDropHint);
window.addEventListener('blur', clearDropHint);
window.addEventListener('drop', event => {
  clearDropHint();
  if (!isFileDrag(event)) return;
  event.preventDefault(); // Keep the application open even on pages that do not accept files.
  if (!canDropAttachments()) return;
  if (Array.from(event.dataTransfer.items).some(item => item.webkitGetAsEntry?.()?.isDirectory)) {
    notice('请选择文件。文件夹无法作为附件添加。', true); return;
  }
  void uploadChosenAttachments([...event.dataTransfer.files]);
});
$('file-attachment-input').addEventListener('change',async()=>{const files=[...$('file-attachment-input').files];$('file-attachment-input').value='';await uploadChosenAttachments(files,'file');});
$('add-attachment').addEventListener('click', () => $('attachment-input').click());
$('attachment-input').addEventListener('change', async () => { const files = [...$('attachment-input').files]; $('attachment-input').value = ''; await uploadChosenAttachments(files,'image'); });
window.addEventListener('beforeunload', () => { for (const url of attachmentPreviews.values()) URL.revokeObjectURL(url); });
$('compose').addEventListener('submit', e => { e.preventDefault(); send(); });
$('queue-send').addEventListener('click', () => queueDraft());
$('prompt').addEventListener('input', () => { autosizePrompt(); updateControls(); slashMenu.update(); });
$('prompt').addEventListener('click', () => slashMenu.update());
$('prompt').addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== $('prompt')) slashMenu.close(); }, 0));
$('prompt').addEventListener('keydown', onPromptKey);
$('stop').addEventListener('click', async () => {
  const threadId = state.thread?.id, turnId = state.turnId;
  if (!threadId || !turnId || state.interruptingTurns.has(turnId) || pendingMutations.has('turn/interrupt', threadId, turnId)) return;
  state.interruptingTurns.add(turnId); updateControls();
  try { await performMutation('turn/interrupt', { threadId, turnId }); if (state.thread?.id === threadId && !state.terminalTurns.has(turnId)) activity('已请求停止，等待 Codex 确认…'); }
  catch (e) { if (outcomeFromError(e) !== 'unknown') state.interruptingTurns.delete(turnId); notice(`停止请求${outcomeFromError(e) === 'unknown' ? '结果未知，正在自动同步状态' : '失败'}：${e.message}`, true); updateControls(); }
});
$('add-project').addEventListener('click',addProject);
$('project-browse').addEventListener('click',addProject);
$('project-form').addEventListener('submit',event=>{event.preventDefault();selectProject({path:$('project-path').value.trim()});});
$('project-close').addEventListener('click',()=>{projectsState.dialogGeneration++;$('project-dialog').close();});
$('project-dialog').addEventListener('cancel',()=>{projectsState.dialogGeneration++;});
$('project-dialog').addEventListener('close',()=>{projectsState.dialogGeneration++;});
$('new-thread').addEventListener('click', () => newThread()); $('settings').addEventListener('click', () => openSettings('general')); $('cwd-button').addEventListener('click', openProjectDialog);
function saveSettings(e) { e.preventDefault(); selectProject({path:$('cwd-input').value.trim()}); }
$('settings-cwd-browse').addEventListener('click',pickSettingsFolder);
$('refresh').addEventListener('click', () => {loadProjects();loadThreads().catch(e => notice(e.message, true));});
const threadAutoLoad = mountThreadAutoLoad({
  container: $('thread-scroll'), button: $('more-threads'), status: $('thread-load-status'),
  getKey: () => $('search').value,
  canLoad: () => !!state.nextThreads && state.connected,
  load: () => loadThreads(true),
});
function hasEarlierHistory(){
  return Boolean(state.pager&&(state.pager.hasMore||state.pager.mode==='items'&&state.nextTurns));
}
const historyAutoLoad = mountHistoryAutoLoad({
  autoFill:true,
  scrollController:conversationScroll,
  container: $('conversation'), button: $('earlier'), status: $('history-load-status'),
  getKey: () => state.thread?.id + ':' + state.openGeneration,
  canLoad: () => state.connected && currentRoute==='chat' && !state.loadingThread && hasEarlierHistory(),
  load: () => loadItems(true),
});
$('shutdown').addEventListener('click', async () => { if (!await confirm(state.desktop ? '停止本窗口的 Codex app-server？Codex 任务可能中断，独立 DSH 任务可能继续。再次启动会重新连接官方历史，不会无缝恢复当前连接。' : '停止 GUI 本地服务？通过此 GUI 运行的任务可能会中断，独立 DSH 任务可能继续。')) return; state.shuttingDown = true; try { const result = await api('/api/shutdown', {}); if (result?.engineStopped !== true || result?.shutdownAccepted !== true) throw new Error('服务未确认引擎已停止，状态未知；请稍后检查连接状态。'); state.eventController?.abort(); setConnected(false, 'GUI 服务已停止'); activity(state.desktop ? '已停止服务。请关闭本窗口后重新启动应用；新连接会读取官方历史。' : '已停止服务。重新运行启动器即可打开。'); closeSettings(); } catch (e) { state.shuttingDown = false; notice(e.message, true); } });
$('model').addEventListener('change', () => chooseModel($('model').value)); $('dismiss-notice').addEventListener('click', () => notifications.dismiss());
$('rail-sidebar').addEventListener('click', () => sidebarController.toggle()); $('sidebar-overlay').addEventListener('click', () => sidebarController.close()); for(const id of ['close-sidebar','settings-sidebar-close']) $(id).addEventListener('click', () => sidebarController.close());
function showDetails(force = false) {
  if (currentRoute !== 'chat') route('chat');
  const visible = force || $('details').classList.contains('hidden');
  setDetailsVisible(visible);
  syncDshLiveContext();
  if (visible) { renderDshConnection(); renderDshTasks(); }
}
function setDetailsVisible(visible) {
  const panel = $('details');
  panel.inert = !visible;
  panel.classList.toggle('hidden', !visible);
  $('toggle-details').setAttribute('aria-pressed', String(visible));
}
$('toggle-details').addEventListener('click', () => showDetails());
$('close-details').addEventListener('click', () => { setDetailsVisible(false); $('toggle-details').focus(); syncDshLiveContext(); });
$('refresh-dsh').addEventListener('click', refreshDsh); $('refresh-dsh-settings').addEventListener('click', refreshDsh);
for (const button of document.querySelectorAll('[data-prompt]')) button.addEventListener('click', () => { $('prompt').value = button.dataset.prompt; $('prompt').focus(); updateControls(); });
let searchTimer; $('search').addEventListener('input', () => {
  clearTimeout(searchTimer);state.searchGeneration++;threadSearchController?.abort();threadAutoLoad?.reset();
  normalThreadsLoaded=false;animateProjectOrder=false;
  const query=$('search').value.trim().toLocaleLowerCase(),cached=threadSearchCache.get(query);
  const known=new Map([...threadSearchCache.values()].flatMap(value=>value.rows).concat(state.threads).map(row=>[row.id,row]));
  state.threads=cached?cached.rows.slice():[...known.values()].filter(row=>!query||[row.name,row.preview].some(text=>String(text||'').toLocaleLowerCase().includes(query))).slice(0,300);
  state.nextThreads=null;
  searchStatus={text:query?'正在搜索全部对话…':'',busy:true};renderThreads();
  searchTimer=setTimeout(()=>loadThreads().catch(()=>{}),150);
});
const backLayers = [
    { isOpen: () => contextDetails.open, close: () => contextDetails.close(true) },
    { isOpen: () => sessionSpeed.open, close: () => sessionSpeed.close(true) },
    { isOpen: () => sessionUsage.open, close: () => sessionUsage.close(true) },
    { isOpen: () => !$('thread-menu').classList.contains('hidden'), close: () => closeThreadMenu(true) },
    { isOpen: () => !$('reasoning-popover').classList.contains('hidden'), close: () => closeReasoning() },
    { isOpen: () => slashMenu.isOpen(), close: () => slashMenu.close() },
    { isOpen: () => sidebarController.isOverlayOpen(), close: () => sidebarController.close() },
    { isOpen: () => dshView.isAgentDetailOpen(), close: () => dshView.backToAgentList() },
    { isOpen: () => !$('details').classList.contains('hidden'), close: () => $('close-details').click() },
];
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.isComposing) return;
  const newChat = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n';
  const modal = document.querySelector('dialog[open]');
  if (newChat) { event.preventDefault(); if (!modal) newThread(); return; }
  if (event.key !== 'Escape' || modal) return;
  if (dismissBackLayer(backLayers)) { event.preventDefault(); return; }
  if (currentRoute !== 'chat' && !document.activeElement?.closest?.('#queue')) route('chat');
});
// Android asks the SPA before falling back to WebView history or leaving the app.
window.CodexLightNavigation = Object.freeze({ back: createBackHandler({ document, layers: backLayers,
  navigateBack: () => {
    if (navigationHistory.canBack) { void travelHistory(-1); return true; }
    if (currentRoute !== 'chat') { route('chat', { back: true }); return true; }
    return false;
  },
}) });
function openInlineCwd(){openProjectDialog();}
function saveInlineCwd(){selectProject({path:$('cwd-inline-input').value.trim()});}
$('cwd-inline-save').addEventListener('click',saveInlineCwd);$('cwd-inline-input').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();saveInlineCwd();}});$('cwd-inline-cancel').addEventListener('click',()=>{$('cwd-setup').classList.add('hidden');$('prompt').focus();});
$('send-state-action').addEventListener('click',async()=>{const action=$('send-state-action').dataset.action;if(action==='cwd')openInlineCwd();else if(action==='pending'){$('pending-submissions').scrollIntoView({block:'nearest'});$('pending-submissions').querySelector('button')?.focus();}else if(action==='stop')$('stop').click();else if(action==='reconnect'){try{await syncStatus();connectionBootstrap.retry();sessionDefaults.retry();updateControls();}catch(error){notice('连接检查失败：'+error.message+'。没有重新发送消息。',true);}}});
$('settings-form').addEventListener('submit', saveSettings);
$('settings-back').addEventListener('click', closeSettings); $('settings-cancel').addEventListener('click', closeSettings);
$('rail-plugins').addEventListener('click',()=>openSettings('plugins'));
$('rail-home').addEventListener('click', () => route('chat')); $('rail-settings').addEventListener('click', () => openSettings('general'));
$('rail-usage').addEventListener('click', () => route('usage')); $('rail-account').addEventListener('click', () => route('account'));
mountSettingsSearch({ document, navigate(section) {
  const ready = state.settingsPage === section ? undefined : selectSettingsSection(section);
  if (sidebarController.isOverlayOpen()) sidebarController.closeForNavigation();
  return ready;
} });
for (const button of document.querySelectorAll('[data-settings-section]')) button.addEventListener('click', () => {const wasOverlay=sidebarController.isOverlayOpen();selectSettingsSection(button.dataset.settingsSection);if(wasOverlay){sidebarController.closeForNavigation();$('settings-back').focus();}});
function selectSettingsSection(section = 'general') {
  if(section==='account'||section==='usage'){route(section);return;}
  if(section==='lan')section='remote';
  const sections = ['general','engines','dsh','archived','remote','plugins','skills','appearance','notifications','shortcuts','configuration','about','storage'];
  const page = (['storage','engines'].includes(section) && state.lan) || !sections.includes(section) ? 'general' : section; state.settingsPage = page;
  for (const name of sections) $('settings-' + name).classList.toggle('hidden', name !== page);
  for (const item of document.querySelectorAll('[data-settings-section]')) item.classList.toggle('active', item.dataset.settingsSection === section);
  document.querySelector('.settings-content').scrollTop = 0;
  let ready;
  if (page === 'dsh' && !state.lan) { ready=dshConnectionView.activate(); if(state.runtimeTarget!=='wsl')dshConfigView.activate();else dshConfigView.deactivate(); } else { dshConnectionView.deactivate(); dshConfigView.deactivate(); }
  if (page === 'configuration' && !state.lan) titleSettings.activate();
  if (page === 'archived') loadArchived().catch(e => notice(e.message, true));
  if (page === 'skills') ready = skillsView.activate(); else skillsView.deactivate();
  if(page==='plugins')pluginPanel.activate();else pluginPanel.deactivate();renderPluginPending();
  if(page==='configuration')configPanel.activate();
  if(page==='remote'&&!state.lan)lanView.activate();else lanView.deactivate();
  if(page==='about')ready=aboutView.activate();else aboutView.deactivate();
  if(page==='storage'&&!state.lan)storageView.activate();else storageView.deactivate();
  if (page === 'remote'){if(state.connected)refreshRemote();else remoteReset({statusMessage:'尚未连接 Codex，无法读取远控状态。',pairMessage:'连接已断开，配对码已隐藏。',devicesMessage:'未连接时设备列表不可用；不会撤销旧环境设备。'});}
  syncRuntimePanelActivity();
  if(currentRoute==='settings')recordNavigation();
  return ready;
}
function rowsNode(rows) {
  const list = el('dl', 'status-rows'); for (const [label, value] of rows) list.append(el('dt', '', label), el('dd', '', value)); return list;
}
function readableThreadId(){
  if(currentRoute!=='chat'||state.loadingThread||document.visibilityState!=='visible'||!document.hasFocus()
      ||sidebarController.isOverlayOpen()||document.querySelector('dialog[open]'))return null;
  return state.thread?.id??null;
}
function visibleLatestReply(){
  const turn=$('messages').lastElementChild;
  // A finished turn keeps its final answer outside the intermediate-work disclosure.
  if(turn?.dataset.state!=='completed')return null;
  const reply=turn.querySelector(':scope > .agentMessage');
  if(!reply)return null;
  const bounds=reply.getBoundingClientRect(),viewport=$('conversation').getBoundingClientRect();
  return bounds.height>0&&bounds.bottom>viewport.top&&bounds.top<viewport.bottom?turn.dataset.turnId:null;
}
function scheduleThreadRead() {
  if (threadReadFrame !== null || !state.thread?.id || (!state.lan&&!threadCompletion.unread.has(state.thread.id))) return;
  threadReadFrame = requestAnimationFrame(() => {
    threadReadFrame = null;
    const threadId = readableThreadId();
    if (!threadId || renderedThreadReads?.threadId !== threadId) return;
    const atBottom=conversationScroll.atBottom;
    const latest=atBottom?null:visibleLatestReply();
    if(!atBottom&&!latest)return;
    const turnIds=atBottom?renderedThreadReads.turnIds:[latest];
    const unread=threadCompletion.unread.get(threadId);
    if(unread&&(atBottom||unread.has(latest))){
      if(atBottom)threadCompletion.read(threadId);
      else threadCompletion.syncRead([{threadId,turnIds}]);
      renderThreads();
    }
    if(state.lan)threadReadReporter.record(threadId,turnIds);
  });
}
$('conversation').addEventListener('scroll',scheduleThreadRead,{passive:true});
window.addEventListener('resize',scheduleThreadRead);
document.addEventListener('focusin',scheduleThreadRead);
document.addEventListener('close',scheduleThreadRead,true);
document.addEventListener('visibilitychange',()=>{renderThreads();remoteView.expireIfNeeded();syncDshLiveContext();syncDelegationMonitor();syncPendingReconciler();syncRuntimePanelActivity();});
window.addEventListener('focus',()=>renderThreads());
function pendingAccount(){return scopedPending('account');}
function renderAccountPending(){const container=$('account-pending'),rows=pendingAccount();container.classList.toggle('hidden',!rows.length);container.replaceChildren();for(const marker of rows){const row=el('div','pending-inline');row.setAttribute('role','status');const status=el('span','pending-inline-status','正在更新账户状态…');const failure=pendingReconcileErrors.get(marker.requestId);if(failure)status.title=failure;row.append(status);container.append(row);}}
async function accountApi(path,body){
 if(path==='/api/account/snapshot')return api(path,body);
 const method=path.slice('/api/'.length);if(!['account/start','account/cancel','account/logout'].includes(method))throw new Error('未知账户操作。');
 if(pendingAccount().some(marker=>marker.method===method||method==='account/start'))throw new Error('账户状态仍在自动同步，暂不能创建重复请求。');
 return performMutation(method,body);
}
async function refreshAccount() { if (currentRoute === 'account') await accountView.refresh(); }
function renderArchived() {
  const fragment = document.createDocumentFragment();
  for (const thread of state.archivedThreads) {
    const row = el('div', 'archive-row'); const info = el('div', 'archive-info'); info.append(el('strong', '', boundedText(thread.name || thread.preview || '未命名对话', 200)), el('small', '', boundedText(thread.cwd || '', 500))); row.append(info);
    const restore = el('button', 'subtle', '恢复'); restore.disabled = state.sending || pendingMutations.storageError || threadPendingRecords(thread.id).length>0; restore.addEventListener('click', () => restoreArchived(thread)); row.append(restore); fragment.append(row);
  }
  if (!state.archivedThreads.length) fragment.append(el('p', 'muted', '没有已归档的对话。')); $('archived-list').replaceChildren(fragment); $('more-archived').classList.toggle('hidden', !state.archivedCursor);
}
async function loadArchived(more = false) {
  const generation = ++state.archivedGeneration; $('refresh-archived').disabled = true; $('more-archived').disabled = true;
  if (!more) $('archived-list').replaceChildren(el('p', '', '正在读取已归档对话…'));
  try {
    const result = await rpc('thread/list', { archived: true, limit: 30, sortKey: 'updated_at', sortDirection: 'desc', ...(more && state.archivedCursor ? {cursor:state.archivedCursor} : {}) });
    if (generation !== state.archivedGeneration) return;
    state.archivedThreads = (more ? [...state.archivedThreads, ...(result.data || [])] : result.data || []).slice(-300); state.archivedCursor = result.nextCursor; renderArchived();
  } catch (e) { if (generation === state.archivedGeneration) $('archived-list').replaceChildren(el('p', 'inline-error', '归档列表读取失败：' + e.message)); }
  finally { if (generation === state.archivedGeneration) { $('refresh-archived').disabled = false; $('more-archived').disabled = false; } }
}
function showMutationFailure(error, label) {
  const unknown = outcomeFromError(error) === 'unknown'; notice(`${label}${unknown ? '结果未知，正在自动同步原请求状态，不会自动重发。' : '未完成，没有自动重发。'} ${error.message}`, true);
}
function canManageThread(thread = state.thread) {
  if (!thread?.id || !state.connected || !state.serverInstance || state.sending || pendingMutations.storageError) return false;
  const id = thread.id, session = sessionFor(id), activeTurn = state.activeTurns.get(id);
  return !(state.thread?.id === id && (state.loadingThread || state.busy)) &&
    !(activeTurn && !state.terminalTurns.has(activeTurn)) && !session?.activeTurnId && session?.state !== 'unknown' &&
    thread.status?.type !== 'active' && !threadPendingRecords(id).length && !scopedPending('chat',{threadId:id}).length;
}
function closeThreadMenu(restoreFocus = false) { $('thread-menu').classList.add('hidden'); $('thread-menu-button').setAttribute('aria-expanded', 'false'); if (restoreFocus) $('thread-menu-button').focus(); }
function openRename(thread = state.thread) {
  closeThreadMenu(); if (!canManageThread(thread)) return;
  $('rename-input').setCustomValidity('');
  state.renameTarget = { id: thread.id, name: thread.name || thread.preview || '' }; $('rename-input').value = state.renameTarget.name.slice(0,200); $('rename-dialog').showModal(); $('rename-input').focus(); $('rename-input').select();
}
async function renameThread(event) {
  event.preventDefault(); if (!state.renameTarget) return;
  const thread = state.threads.find(row => row.id === state.renameTarget.id) || (state.thread?.id === state.renameTarget.id ? state.thread : null);
  if (!canManageThread(thread)) { $('rename-dialog').close(); notice('对话已变化，请刷新列表后再试。',true); return; }
  const name = $('rename-input').value.trim(); if (!name) { $('rename-input').setCustomValidity('请输入名称'); $('rename-input').reportValidity(); return; } $('rename-input').setCustomValidity('');
  const target = state.renameTarget; state.sending = true; $('rename-save').disabled = true; $('rename-input').disabled = true; updateControls();
  try {
    await performMutation('thread/name/set', {threadId:target.id,name});
    updateThreadName(target.id,name); $('rename-dialog').close(); await refreshThreadListAfterMutation();
  } catch (e) { $('rename-dialog').close(); showMutationFailure(e, '重命名'); }
  finally { state.sending = false; $('rename-save').disabled = false; $('rename-input').disabled = false; state.renameTarget = null; updateControls(); renderThreads(); }
}
function updateThreadName(id, name) {
  for(const thread of [...state.threads,...state.archivedThreads])if(thread.id===id)thread.name=name;
  for(const cached of threadSearchCache.values())for(const thread of cached.rows)if(thread.id===id)thread.name=name;
  if(unindexedThreads.has(id))unindexedThreads.get(id).name=name;
  if(state.thread?.id===id){state.thread.name=name;$('thread-title').textContent=name||state.thread.preview||'对话';}
  renderThreads();
}
function removeListedThread(id, deleted) {
  if(deleted)reasoningWrites.delete(id);
  clearRunningTurn(id,state.activeTurns.get(id));
  state.contexts.delete(id);
  questionNotifications?.forgetThread(id);
  dropRequests(request=>requestThread(request)===id);
  unindexedThreads.delete(id);
  threadCompletion.read(id);
  state.threads=state.threads.filter(thread=>thread.id!==id);
  for(const cached of threadSearchCache.values())cached.rows=cached.rows.filter(thread=>thread.id!==id);
  if(deleted&&state.archivedThreads.some(thread=>thread.id===id)){
    state.archivedThreads=state.archivedThreads.filter(thread=>thread.id!==id);renderArchived();
  }
  if(state.thread?.id===id)state.thread.removed=true;
  if(!state.sending&&state.thread?.removed)newThread();
  else renderThreads();
}
function validSummaryResult(id, result) {
  return result?.threadId===id && typeof result.name==='string' && !!result.name.trim() && result.name.length<=200;
}
function applySummaryResult(id, result) {
  if(!validSummaryResult(id,result))throw new Error('标题结果缺少目标对话标识或标题');
  updateThreadName(id,result.name);
}
async function refreshThreadListAfterMutation() {
  try{await loadThreads();}catch(error){notice('操作已完成，对话列表刷新失败：'+error.message,true);}
}
async function summarizeThreadTitle(thread) {
  if(!canManageThread(thread))return;
  const { id }=thread;
  notice('正在摘要对话标题…');
  try{
    const pending=performMutation('thread/summary',{threadId:id});renderThreads();
    const result=await pending;applySummaryResult(id,result);notice(result.warning||'对话标题已更新',!!result.warning);await refreshThreadListAfterMutation();
  }catch(error){showMutationFailure(error,'摘要标题');}
  finally{renderThreads();}
}
async function removeThread(thread, action, opener) {
  if(!canManageThread(thread))return;
  const deleted=action==='delete', label=deleted?'删除':'归档';
  const name=boundedText(thread.name||thread.preview||'此对话',160);
  const message=deleted?`永久删除“${name}”及其代理子对话？此操作无法恢复。`:`将“${name}”移入归档？可以从设置 → 已归档聊天恢复。`;
  if(!await confirm(message,{titleText:label+'对话',acceptText:label,danger:deleted,opener})||!canManageThread(thread))return;
  if(!state.threads.some(row=>row.id===thread.id)&&state.thread?.id!==thread.id)return;
  state.sending = true; updateControls();
  try {
    await performMutation(deleted?'thread/delete':'thread/archive',{threadId:thread.id},{confirmed:deleted});
    state.sending=false;removeListedThread(thread.id,deleted);await refreshThreadListAfterMutation();
  }catch(error){if(deleted&&error.code===-32601)notice('当前 Codex 运行引擎不支持删除对话。',true);else showMutationFailure(error,label);}
  finally{state.sending=false;if(state.thread?.removed)newThread();updateControls();renderThreads();}
}
async function restoreArchived(thread) {
  if (state.sending || threadPendingRecords(thread.id).length) { notice('此对话的状态仍在自动同步，请稍后再试。'); return; }
  state.sending = true; updateControls(); renderArchived();
  try { await performMutation('thread/unarchive', {threadId:thread.id}); questionNotifications?.restoreThread(thread.id); state.archivedThreads = state.archivedThreads.filter(row => row.id !== thread.id); await Promise.all([loadArchived(),loadThreads()]); }
  catch (e) { showMutationFailure(e, '恢复归档'); }
  finally { state.sending = false; updateControls(); renderArchived(); }
}
async function forkCurrentThread(lastTurnId=null, threadId=state.thread?.id) {
  closeThreadMenu(); if(threadId!==state.thread?.id||!canManageThread()){notice('当前对话暂时无法创建分支，请在连接恢复或任务结束后重试。',true);return;} const target = state.thread; const generation = state.openGeneration;
  state.sending = true; updateControls();
  try { const result = await performMutation('thread/fork', {threadId:target.id,excludeTurns:true,...(lastTurnId?{lastTurnId}:{})}); if (generation === state.openGeneration && result.thread?.id) await openThread(result.thread); await refreshThreadListAfterMutation(); }
  catch (e) { showMutationFailure(e, '创建分支'); }
  finally { state.sending = false; updateControls(); }
}
$('thread-menu-button').addEventListener('click', () => { if ($('thread-menu').classList.contains('hidden')) { $('thread-menu').classList.remove('hidden'); $('thread-menu-button').setAttribute('aria-expanded','true'); $('rename-thread').focus(); } else closeThreadMenu(true); });
$('rename-thread').addEventListener('click',()=>openRename()); $('fork-thread').addEventListener('click',()=>forkCurrentThread()); $('archive-thread').addEventListener('click',()=>{closeThreadMenu();removeThread(state.thread,'archive',$('thread-menu-button'));});
$('rename-form').addEventListener('submit',renameThread); $('rename-input').addEventListener('input',()=>$('rename-input').setCustomValidity(''));
for (const id of ['rename-close','rename-cancel']) $(id).addEventListener('click',()=>{if(!state.sending)$('rename-dialog').close();});
$('rename-dialog').addEventListener('cancel',event=>{if(state.sending)event.preventDefault();});
$('rename-dialog').addEventListener('close',()=>{if(!state.sending)state.renameTarget=null;});
document.addEventListener('click',event=>{if(!$('thread-menu').contains(event.target)&&event.target.id!=='thread-menu-button')closeThreadMenu();});
$('thread-menu').addEventListener('keydown',event=>{if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();const buttons=[...$('thread-menu').querySelectorAll('button')],n=buttons.indexOf(document.activeElement);buttons[(n+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}});

$('refresh-archived').addEventListener('click',()=>loadArchived()); $('more-archived').addEventListener('click',()=>loadArchived(true));
const preferencesView = createPreferences({ document, window, state, $, el, api, notice, confirm: text => confirm(text), onChange:(preferences,appearance)=>{
  if(state.desktop)desktopCompanion.appearance(preferences.desktopCompanion,appearance);
  questionNotifications?.sync(state.requests,{notify:false});
} });
const { loadDesktopState } = preferencesView;
applyAccessMode(access.lan);
watchKeyboard(window, document.documentElement);
mountMobileLayout(document,window);
offlineSnapshot=mountOfflineSnapshot({document,window,readState:()=>({ready:state.connected&&!state.loadingThread&&lastEventAt>0&&Date.now()-lastEventAt<60000,page:currentRoute,title:state.thread?.name||$('thread-title').textContent,project:$('project-name').textContent})});
questionNotifications=createQuestionNotifications({document,window,host:$('question-alert'),enabled:()=>preferencesView.current().approvalNotice,notice,
  onPendingQuestions:taskbarBadge.setQuestions,
  onPendingCounts:desktopCompanion.pending,
  permissionStatus:$('question-notification-status'),permissionButton:$('question-notification-permission'),
  canOpen:()=>state.connected&&!state.sending&&!state.loadingThread&&!state.shuttingDown,
  openThread:async(threadId,request)=>{
    if(threadId&&state.thread?.id!==threadId)await openThread(state.threads.find(thread=>thread.id===threadId)||{id:threadId});
    if(threadId&&state.thread?.id!==threadId)throw new Error('对话加载被其他导航打断。');
    route('chat');
    if(request.nativeOnly){notice('已打开对应对话，该请求已结束。');return;}
    const asyncQuestion=request.method==='agentMessage/async', key=asyncQuestion?null:requestKey(request.id);
    if(key&&state.requests.get(key)?.bridgeRequestToken!==request.bridgeRequestToken){notice('该请求已结束。');return;}
    const target=asyncQuestion?conversation.revealItem(request.params.itemId):[...$('approvals').querySelectorAll('[data-request-key]')].find(node=>node.dataset.requestKey===key);
    if(target){conversationScroll.pause();for(let parent=target.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;target.scrollIntoView({block:'center',behavior:'instant'});target.querySelector('input:not(:disabled),textarea:not(:disabled),button:not(:disabled)')?.focus({preventScroll:true});conversationScroll.pause();}
    else notice('已打开对应对话。如问题位于更早的记录，请加载更早消息。');
  },
});
desktopWebView?.addEventListener('message', ({data})=>{
  if(!state.desktop || data?.type!=='companionOpen')return;
  if(data.target==='appearance')openSettings('appearance');
  else if(data.target==='question'||data.target==='approval')void questionNotifications.openPending(data.target);
});
taskNotifications=mountTaskNotifications({document,window,notice,
  snapshot:()=>({connected:state.connected&&lastEventAt>0&&Date.now()-lastEventAt<60000,canOpen:taskNavigationReady&&state.connected&&!state.loadingThread&&!state.sending}),
  title:id=>(state.thread?.id===id?state.thread:state.threads.find(thread=>thread.id===id))?.name||'Codex 任务',
  resolveTarget:async threadId=>(await api('/api/mobile/task-target',{threadId})).threadId,
  openThread:async threadId=>{if(state.sending||state.loadingThread)throw new Error('当前操作结束后请再打开。');await openThread(state.threads.find(thread=>thread.id===threadId)||{id:threadId});if(state.thread?.id!==threadId||state.loadingThread)throw new Error('对话加载被其他导航打断。');},
});
// Keep the caret visible when the phone keyboard opens.
$('prompt').addEventListener('focus', () => { if (matchMedia('(pointer:coarse)').matches) setTimeout(() => $('compose').scrollIntoView({ block: 'end' }), 250); });
async function init() {
  renderPendingMutations(); renderAttachments(); renderReasoning(); remoteControls(); updateControls();
  try {
    if(pairingError)throw pairingError;
    const config = await api('/api/config'); await loadProjects({restore:true}); $('command-info').textContent = config.codexCommand || 'codex'; let status = await syncStatus();
    events();
    if (!state.lan && !state.demo) api('/api/dsh/connection/modelReminder', {}).then(result => { dshModelReminder.hidden = !result.needed; }).catch(error => notice(error.message,true));
    if(!status.connected)activity('正在等待 Codex 连接，连接成功后会自动加载模型与历史。');
  } catch (e) { setConnected(false); notice(e.message, true); activity('未发送任何模型请求'); }
}
init();
window.addEventListener('online',()=>{
  if(state.desktop&&!state.lan&&!state.demo&&window.chrome?.webview){
    void api('/api/app-update/network-restored',{}).catch(()=>{ /* The backend keeps its scheduled retry. */ });
  }
});

mountDesktopClosePreference();

async function confirm(message, options) {
 const snapshot = () => JSON.stringify([state.serverInstance,state.connected,state.cwd,state.thread?.id,state.turnId,state.loadingThread,state.shuttingDown]);
 const before = snapshot();
 return await confirmApp(document,message,options) && before === snapshot();
}
