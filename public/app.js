import { mountConfigSettingsPanel } from './config-settings-panel.js';
import { mountAccountLoginPanel } from './account-login-panel.js';
import { mountStatistics } from './ui/stats-view.js';
import { mountAccount } from './ui/account-view.js';
import { mountLiveChanges, pillChanges } from './ui/live-changes.js';
import { mountArtifacts, mountLightbox } from './ui/artifacts.js';
import { pastedFiles, classifyPaste } from './ui/paste.js';
import { bootstrapToken } from './ui/access.js';
import { renderApprovals } from './ui/approvals-view.js';
import { createDshView } from './ui/dsh-view.js';
import { createRemoteView } from './ui/remote-view.js';
import { createWorkbench } from './ui/workbench-view.js';
import { createSlashMenu } from './ui/slash-menu.js';
import { createComposer } from './ui/composer.js';
import { createPreferences } from './ui/preferences-view.js';
import { mountDshConfig } from './ui/dsh-config-view.js';
import { mountDshConnection } from './ui/dsh-connection-view.js';
import { mountLanAccess } from './ui/lan-view.js';
import { watchKeyboard } from './ui/viewport.js';
import { mountPluginsPanel } from './plugins.js';
import { permissionOptions, permissionResponse, formDefinition, formResponse } from './approval-schemas.js';
import { icon, hydrateIcons } from './icons.js';
import { reasoningChoices, effortLabel, effortAccessibleLabel, restoredReasoning, resetReasoning, switchedReasoning, reasoningParameter, configuredReasoningView, defaultModelView, activeModelId } from './reasoning.js';
import { ItemStore, boundedText, itemText } from './store.js';
import { DshTaskStore } from './dsh.js';
import { DshLiveMonitor } from './dsh-live.js';
import { PendingMutations, pendingForScope, PendingReconciler, outcomeFromError, lookupDecision, sendAvailability, ConnectionBootstrap, SessionDefaultsBridge } from './submissions.js';
import { mountPrReviewPanel } from './pr-review-panel.js';
import { mountRuntimePanel } from './runtime-panel.js';
import { AttachmentDraft, FileAttachmentDraft, validateFileSelection, validateImageSelection } from './attachments.js';
import { mountConversation, renderDiff } from './activity-feed.js';
import { TurnLedger, buildTurns, FollowUpQueue, contextSnapshot, contextView, HistoryPager, historyCapabilities } from './state.js';
import { projectPathKey } from './projects.js';
import { mountProjectNavigation } from './project-navigation.js';
const attachmentDraft = new AttachmentDraft();
const fileAttachmentDraft = new FileAttachmentDraft();
const attachmentPreviews = new Map();
const dshTasks = new DshTaskStore();
const $ = id => document.getElementById(id);
hydrateIcons(document);
let localSession; try { localSession = sessionStorage; } catch { localSession = {getItem(){throw new Error('会话存储不可用');},setItem(){throw new Error('会话存储不可用');},removeItem(){throw new Error('会话存储不可用');}}; }
const readSession = key => { try { return localSession.getItem(key); } catch { return null; } };
// Token bootstrap: loopback keeps a session copy; LAN (phone) keeps it in memory only.
const access = bootstrapToken(location, localSession, url => history.replaceState(null, '', url));
const token = access.token;
// LAN pages cannot use local management (shutdown, runtime, desktop, LAN links). Applied before any request.
function applyAccessMode(lan) { state.lan = !!lan; document.documentElement.dataset.access = lan ? 'lan' : 'local'; }
const pendingMutations = new PendingMutations(localSession);
const sessionDefaults = new SessionDefaultsBridge(body => api('/api/session/defaults', body), {onChange:snapshot=>{renderReasoning();if(snapshot.error)notice('无法读取 Codex 配置默认模型/强度：'+snapshot.error+'。没有改用模型目录默认值；可打开模型列表显式重试，发送时不会强行写入默认值。',true);}});
const state = { connected: false, demo: false, desktop: false, reasoning: restoredReasoning(null), cwd: readSession('codex-light-cwd') || '', thread: null, threads: [], nextThreads: null, nextItems: null, models: [], modelGeneration: 0, turnId: null, sending: false, busy: false, openGeneration: 0, searchGeneration: 0, requests: new Map(), store: new ItemStore(300), nodes: new Map(), rendering: false, historyFallback: false, activeTurns: new Map(), terminalTurns: new Set(), shuttingDown: false, eventController: null, detailsTab: 'tools', dshConnection: null, dshRefreshing: false, serverInstance: null, pendingQueries: new Set(), interruptingTurns: new Set(), uploadingImages: false, loadingThread: false, dshReads: new Map(), dshReadErrors: new Map(), dshReadSequence: 0, dshReadGeneration: 0, dshOpenDetails: new Set(), settingsPage: 'general', archivedThreads: [], archivedCursor: null, archivedGeneration: 0, accountLoading: false, usageLoading: false, renameTarget: null, cliVersion: null, ledger: new TurnLedger(), nextTurns: null, contexts: new Map(), threadSessions: [] };
// Follow-up messages typed while a task runs. Per thread, survives navigation, never persisted.
const followUps = new FollowUpQueue();
const queuedPreviews = new Map();
let runtimePanel=null,pendingReconciler=null,pendingReconcilerSignature='',pendingReconcilerActive=false,pendingReconcileQueued=false;
const projectsState={projects:[],selectedId:null,canPickFolder:false,busy:false,error:'',generation:0,dialogGeneration:0};
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
  const media=window.matchMedia('(max-width:760px)');
  let open=false, returnFocus=null;
  const narrow=()=>media.matches;
  const closeButton=()=>$('settings-dialog').classList.contains('hidden')?$('close-sidebar'):$('settings-sidebar-close');
  const focusable=()=>[...sidebar.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])')].filter(node=>node.getClientRects().length);
  function sync(){
    const overlayOpen=narrow()&&open;
    app.classList.toggle('sidebar-open',overlayOpen);
    app.classList.toggle('sidebar-collapsed',!narrow()&&!open);
    overlay.classList.toggle('hidden',!overlayOpen);
    sidebar.inert=!open;
    if(open)sidebar.removeAttribute('aria-hidden');else sidebar.setAttribute('aria-hidden','true');
    const button=$('rail-sidebar');button.setAttribute('aria-expanded',String(open));const label=open?'收起侧栏':'展开侧栏';button.setAttribute('aria-label',label);button.title=label;
  }
  function set(next,{focus=true}={}){
    const wasOpen=open;open=!!next;
    if(open&&!wasOpen&&narrow())returnFocus=document.activeElement;
    sync();
    if(open&&narrow()&&focus)requestAnimationFrame(()=>closeButton()?.focus());
    const activeInside=sidebar.contains(document.activeElement);
    if(!open&&(focus||activeInside))requestAnimationFrame(()=>{const remembered=returnFocus;returnFocus=null;const target=remembered?.isConnected&&remembered.getClientRects().length?remembered:$('rail-sidebar');target?.focus();});
  }
  sidebar.addEventListener('keydown',event=>{
    if(event.key!=='Tab'||!narrow()||!open)return;
    const nodes=focusable();if(!nodes.length){event.preventDefault();return;}
    const first=nodes[0],last=nodes.at(-1),active=document.activeElement;
    if(event.shiftKey&&(active===first||!sidebar.contains(active))){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&(active===last||!sidebar.contains(active))){event.preventDefault();first.focus();}
  });
  media.addEventListener('change',()=>set(!narrow(),{focus:false}));
  set(!narrow(),{focus:false});
  return {
    toggle:()=>set(!open),
    close:()=>set(false),
    closeForNavigation:()=>{if(narrow()&&open)set(false,{focus:false});},
    sync,
    isNarrow:narrow,
    isOverlayOpen:()=>narrow()&&open,
  };
})();
// sidebar-controller:end
const dshLive = new DshLiveMonitor({
  api: (path, body) => api(path, body),
  onChange: () => scheduleDshRender(),
  onList: ({ threadId, list, checkedAt }) => {
    if (threadId !== state.thread?.id) return;
    if (dshTasks.ingestLiveList(threadId, list, { checkedAt, source: 'DSH 当前目录自动列表' })) scheduleDshRender();
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
const toolTypes = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'collabAgentToolCall', 'fileDiff']);
function el(tag, className, text) { const e = document.createElement(tag); if (className) e.className = className; if (text != null) e.textContent = text; return e; }
// Local file links never navigate. The bridge has no bounded open/preview API, so the honest action is copying the path.
async function copyLocalPath(ref, node) {
  const value = ref.fullPath + (ref.line !== null ? ':' + ref.line : '');
  try { await navigator.clipboard.writeText(value); node?.setAttribute('data-copied', 'true'); notice(`已复制文件路径：${value}`); }
  catch { node?.setAttribute('data-copied', 'false'); notice(`无法访问剪贴板。文件路径：${value}`, true); }
}
// Image previews go only through the authenticated, thread-scoped preview API; the token never enters a URL.
async function fetchArtifactPreview(path) {
  const threadId = state.thread?.id;
  if (!threadId) throw new Error('需要已保存的对话才能预览');
  if (!token) throw new Error('缺少本地访问令牌');
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch('/api/artifacts/preview', { method: 'POST', signal: controller.signal, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId, path }) });
    if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || (response.status === 404 ? '文件不存在或不在项目目录内' : `无法预览（${response.status}）`)); }
    const type = response.headers.get('Content-Type') || '';
    if (!/^image\//.test(type)) throw new Error('服务返回的不是图片');
    const width = Number(response.headers.get('X-Artifact-Width')) || null, height = Number(response.headers.get('X-Artifact-Height')) || null;
    return { blob: await response.blob(), width, height };
  } catch (error) { throw new Error(error.name === 'AbortError' ? '预览超时' : error.message); }
  finally { clearTimeout(timer); }
}
const lightbox = mountLightbox(document);
const artifactView = mountArtifacts({ document, fetchPreview: fetchArtifactPreview, onOpen: view => lightbox.open(view), resolveImage: (itemId, slot) => state.store.image(itemId, slot) });
const conversation = mountConversation($('messages'), { onLocalLink: copyLocalPath, getCwd: () => state.thread?.cwd || state.cwd, artifacts: artifactView });
setInterval(() => { if (conversation.hasRunningClock() && document.visibilityState === 'visible') conversation.tick(); }, 1000);
/** Leaves a thread's subscription. Active work is retained by the bridge; that is not an error. */
function releaseThread(threadId) {
  if (!threadId || !state.connected) return;
  rpc('thread/unsubscribe', { threadId }).catch(error => notice('离开对话时未能释放会话订阅：' + error.message + '。关闭应用时会统一释放。', true));
}
function resetThreadView() {
  state.store.clear(); state.ledger.clear(); conversation.clear(); liveChanges.update({ count: 0, rows: [] }); state.nextItems = null; state.nextTurns = null; state.historyFallback = false; state.pager = null;
}
const projectNavigation=mountProjectNavigation($('thread-list'),{
  onSelect:group=>selectProject(group),
  onOpenThread:id=>{const thread=state.threads.find(row=>row.id===id);if(thread&&!state.sending)openThread(thread).catch(error=>notice(error.message,true));},
  onRemove:group=>removeProject(group),
});
const connectionBootstrap=new ConnectionBootstrap(async current=>{const results=await Promise.allSettled([loadModels(current),loadThreads(false,current)]);if(!current())return;for(const result of results)if(result.status==='rejected')notice('连接已建立，但目录加载失败：'+result.reason.message+'。可点击重新检查连接重试读取，不会发送任务。',true);},error=>notice('连接目录加载失败：'+error.message,true));
function notice(text, error = false) { $('notice').classList.remove('hidden'); $('notice').classList.toggle('error', error); $('notice').querySelector('span').textContent = String(text); if (!$('settings-dialog').classList.contains('hidden')) { $('settings-notice').classList.remove('hidden'); $('settings-notice').classList.toggle('error', error); $('settings-notice').querySelector('span').textContent = String(text); } }
function activity(text, running = false) { $('activity').textContent = text; $('activity').classList.toggle('running', running); }
async function api(path, body, {timeoutMs=90000}={}) {
  if (!token) { const error = new Error(access.lan ? '缺少访问令牌：请在电脑的“局域网访问”中复制链接，在手机上重新打开。' : '缺少本地访问令牌，请使用启动器重新打开窗口。'); error.outcome = 'notExecuted'; throw error; }
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(path, { method: body === undefined ? 'GET' : 'POST', signal: controller.signal, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    const statusDocument = body === undefined && (path === '/api/status' || path.startsWith('/api/operations?'));
    if (!r.ok || (data.error && !statusDocument)) { const error = new Error(typeof data.error === 'string' ? data.error : data.error?.message || `HTTP ${r.status}`); error.code = data.code ?? data.error?.code; error.outcome = data.outcome; error.notExecuted = data.notExecuted; error.requestId = data.requestId; throw error; }
    if(data.persistenceWarning){state.persistenceWarning=String(data.persistenceWarning);$('desktop-receipts').classList.remove('hidden');$('desktop-receipts-status').textContent=state.persistenceWarning+' 操作可能已经执行，不要重试。';notice(state.persistenceWarning+' 操作可能已经执行；不要据此重试。',true);}
    return data;
  } finally { clearTimeout(timeout); }
}
const rpc = (method, params = {}) => api('/api/rpc', { method, params });
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
 if(pluginLogicalCalls.size>=100)throw new Error('本窗口插件操作记录已达上限，请核对后重新打开');
 const {requestId,...params}=body;const operation=performMutation('plugin/apply',params);pluginLogicalCalls.set(logicalId,operation);return operation;
}
const pluginPanel = mountPluginsPanel($('settings-plugins'), {rpc,api:pluginApi,getContext:()=>({connected:state.connected,cwd:state.cwd,serverInstance:state.serverInstance})});
const prReviewPanel = $('pr-review-panel') ? mountPrReviewPanel($('pr-review-panel'), {api}) : null;
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
function createRuntimePanel(){return mountRuntimePanel($('runtime-panel'),{read:()=>api('/api/runtime/status',{}),check:()=>api('/api/runtime/check',{}),upgrade:params=>performMutation('runtime/upgrade',params),queryPending:queryRuntimePending,onRecovered:clearRuntimePendingAfterRecovery});}
runtimePanel=createRuntimePanel();
runtimePanel.reset({pending:!!runtimePendingMarker()});
function resetRuntimePanel(){runtimePanel?.setActive?.(false);runtimePanel?.reset({pending:!!runtimePendingMarker()});}
function runtimePanelShouldBeActive(){return !state.lan&&!!state.connected&&document.visibilityState==='visible'&&!$('settings-dialog').classList.contains('hidden')&&state.settingsPage==='general';}
function syncRuntimePanelActivity(){runtimePanel?.setActive?.(runtimePanelShouldBeActive());}
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
  const adopt=!state.thread&&!state.loadingThread&&state.cwd===result.thread.cwd&&(!context||context.openGeneration===state.openGeneration);
  if(adopt){
   state.thread=result.thread;restoreThreadReasoning(result);dshTasks.reset(state.thread.id);state.dshReadErrors.clear();state.dshOpenDetails.clear();state.dshConnection=null;renderDshConnection();syncDshLiveContext();renderDshTasks();$('thread-title').textContent=result.thread.name||result.thread.preview||'新对话';$('welcome').classList.add('hidden');
  }
  await loadThreads(false,current);
  return;
 }
 if(marker.method==='turn/start'||marker.method==='review/start'){
  if(!recoveredId(marker.threadId)||!recoveredId(result?.turn?.id)||!['inProgress','completed','failed','interrupted'].includes(result.turn.status)||(result.threadId&&result.threadId!==marker.threadId)||(result.turn.threadId&&result.turn.threadId!==marker.threadId))throw new Error('原任务结果缺少有效任务状态或对话关联，继续保留待同步记录。');
  if(envelope&&marker.method==='turn/start')clearSubmittedDraft(envelope);
  if(state.thread?.id!==marker.threadId)return;
  const generation=state.openGeneration,threadCurrent=()=>current()&&generation===state.openGeneration&&state.thread?.id===marker.threadId;
  state.ledger.merge(result.turn);if(!state.busy||!state.turnId||state.turnId===result.turn.id){state.busy=result.turn.status==='inProgress'&&!state.terminalTurns.has(result.turn.id);state.turnId=state.busy?result.turn.id:null;}
  await loadItems(false,generation,threadCurrent);
  if(threadCurrent()){activity('');updateControls();}
  return;
 }
 if(marker.method==='turn/steer'){if(envelope)clearSubmittedDraft(envelope);return;}
 if(marker.method==='terminal/open'){
  if(!recoveredId(result?.processId)||(result.cwd!==undefined&&typeof result.cwd!=='string'))throw new Error('原终端结果缺少有效进程标识，继续保留待同步记录。');
  await workbench.adoptRecovered(result,envelope,current);
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
 pendingMutations.settle(marker.requestId);
 mutationContexts.delete(marker.requestId);
 if(resolved==='failed')notice('原操作已确认失败：'+(response?.error||'服务返回失败，请检查实际结果。'),true);
 if(marker.method==='runtime/upgrade'&&state.settingsPage==='general'&&!$('settings-dialog').classList.contains('hidden'))runtimePanel?.refresh();
 if(marker.method.startsWith('account/')&&state.settingsPage==='account'&&!$('settings-dialog').classList.contains('hidden'))refreshAccount().catch(error=>notice('无法刷新账户状态：'+error.message,true));
 if(marker.method.startsWith('remoteControl/'))remoteControls();
 if(marker.method==='terminal/open')workbench.dropUnexecuted(resolved);
 noteLedgerChanged();
}
function handlePendingReconcileError(marker,error){
 const record=marker?.marker||marker;if(!record?.requestId)return;
 pendingReconcileErrors.set(record.requestId,typeof error?.message==='string'&&error.message?error.message.slice(0,500):'状态读取失败');
 renderPendingMutations();
}
pendingReconciler=new PendingReconciler({records:reconcilableRecords,query:marker=>api('/api/operations?requestId='+encodeURIComponent(marker.requestId)),onResult:handlePendingReconcileResult,onError:handlePendingReconcileError,interval:5000,maxBackoff:30000});
pendingReconciler.setActive(false);
const eventSubscribers = new Set();
const accountLoginPanel=mountAccountLoginPanel($('account-login-controls'),{api:accountApi,onAccountChanged:async()=>{resetAccountScopedViews('账户已改变');if(state.settingsPage==='account'&&!$('settings-dialog').classList.contains('hidden'))await refreshAccount();}});
const statsView = mountStatistics($('stats-root'), { api, notice, onPickFolder: async () => { if (!projectsState.canPickFolder) return null; const result = await api('/api/desktop/pick-folder', {}, { timeoutMs: 310000 }); return result.path || null; } });
const accountView = mountAccount($('account-root'), { rpc, loginPanelHost: $('account-login-controls'), pendingHost: $('account-pending'), demo: () => state.demo });
const liveChanges = mountLiveChanges($('live-changes'), { renderDiff });
const lanView = mountLanAccess($('lan-root'), { api, notice });
// Local-only: the LAN page never mounts requests for DSH config management (server also refuses with 403).
const dshConfigView = mountDshConfig($('dsh-config-root'), { api });
const dshConnectionView = mountDshConnection($('dsh-connection-root'), { api, onChange: () => refreshDsh() });
function resetUsage(){statsView.reset();accountView.reset();if(currentRoute==='usage')statsView.activate();if(currentRoute==='account')accountView.activate();}
function resetAccountScopedViews(reason='账户已改变'){resetUsage();configPanel.reset();pluginPanel.reset();prReviewPanel?.reset();resetRuntimePanel();remoteReset({statusMessage:reason+'，请重新读取远控状态。',pairMessage:reason+'，本机配对码显示已清除；不会撤销原账户或环境设备。',devicesMessage:reason+'，旧设备显示已清除；不会撤销原账户或环境设备。'});sessionDefaults.clear();state.dshReadGeneration++;state.dshReads.clear();state.dshReadErrors.clear();state.dshOpenDetails.clear();dshTasks.reset(state.thread?.id||null);state.dshConnection=null;renderDshConnection();dshLive.reset();syncDshLiveContext();if(state.connected)syncSessionDefaults();}
const configPanel=mountConfigSettingsPanel($('config-panel'),{read:()=>api('/api/config-settings/read',state.cwd?{cwd:state.cwd}:{}),plan:edits=>{if(scopedPending('config').length)throw new Error('配置状态仍在自动同步');return api('/api/config-settings/plan',{edits});},apply:params=>{if(pendingMutations.storageError||scopedPending('config').length)throw new Error('配置状态仍在自动同步');return performMutation('config/apply',params);}});
function renderConfigPending(){const host=$('config-pending');if(!host)return;const records=scopedPending('config');host.replaceChildren();for(const marker of records){const row=el('div','pending-inline');row.setAttribute('role','status');const status=el('span','pending-inline-status','正在更新配置状态…');const failure=pendingReconcileErrors.get(marker.requestId);if(failure)status.title=failure;row.append(status);host.append(row);}}
function setConnected(connected, label) { if(state.connected !== connected){deactivatePendingReconciler();pluginPanel.reset();configPanel.reset();resetUsage();if(!connected)accountLoginPanel.update({state:'unknown'});state.dshReadGeneration++;state.dshReads.clear();state.dshReadErrors.clear();} state.connected = connected; if(!connected){followUps.pauseAll('连接已断开');renderQueue();try{workbench.connectionLost();}catch(error){notice('终端未能处理连接断开：'+(error?.message||'未知错误')+'。其余断连清理继续。',true);}state.searchGeneration++;resetRuntimePanel();remoteReset({statusMessage:'连接已断开，无法读取远控状态。',pairMessage:'连接已断开，本机配对码显示已清除；不会撤销任何设备。',devicesMessage:'连接已断开，设备列表显示已清除；未撤销旧环境设备。'});}terminalControls();$('connection-dot').className = connected ? 'ok' : 'bad'; $('connection-text').textContent = label || (connected ? '本地 Codex 已连接' : '连接已断开'); $('status-info').textContent = $('connection-text').textContent; updateControls(); renderDshConnection(); remoteControls(); syncSessionDefaults(); syncDshLiveContext(); syncPendingReconciler(); syncRuntimePanelActivity(); connectionBootstrap.update(connected,state.serverInstance); }
function syncSessionDefaults(){sessionDefaults.sync({connected:state.connected,serverInstance:state.serverInstance,cwd:state.cwd,enabled:!state.demo});}
function formatModelDisplayName(value){const text=typeof value==='string'?value.trim():'';if(!text)return '';return text.replace(/^GPT-(\d+(?:\.\d+)?)-([A-Za-z][A-Za-z0-9]*(?:[-.][A-Za-z0-9]+)*)/,'GPT-$1 $2');}
function effectiveModel(){const id=activeModelId($('model').value,sessionDefaults.snapshot().value);return {id,model:id?state.models.find(entry=>entry.model===id)||null:null};}
function currentSendAvailability(){
 if(pendingMutations.storageError)return{disabled:true,reason:'本地消息状态记录无法安全保存，暂不能发送新消息。',action:null};
 if(chatPendingRecords().length)return{disabled:true,reason:'正在同步上一条消息状态，完成后即可继续发送。',action:'pending'};
 const hasContent=!!($('prompt').value.trim()||attachmentDraft.values().length||fileAttachmentDraft.values().length);
 // While a task runs the composer offers steer/queue instead of being blocked.
 if(state.busy&&state.thread&&!state.sending&&!state.loadingThread&&state.connected&&state.serverInstance&&!state.uploadingImages)return{disabled:!hasContent,reason:'',action:null,running:true};
 return sendAvailability({...state,pending:false,hasContent});
}
function updateControls() { const availability=currentSendAvailability();const running=!!availability.running;const canSteer=running&&runningInputAvailable();
 $('send').disabled=availability.disabled||(running&&!canSteer);$('send').title=running?'立即补充到当前任务 (Enter)':availability.reason||'发送 (Enter)';$('send').setAttribute('aria-label',running?'立即补充到当前任务':'发送消息');$('send').dataset.mode=running?'steer':'send';
 $('queue-send').classList.toggle('hidden',!running);$('queue-send').disabled=!running||!hasDraft();
 $('composer-hint').textContent=running?(canSteer?'Enter 立即补充 · Tab 排队到下一轮 · Shift Enter 换行':'该任务不在本窗口运行，结束后自动刷新 · Tab 排队'):'Enter 发送 · Shift Enter 换行 · / 命令';
 $('prompt').placeholder=running?'补充说明，或排队下一条消息':state.thread?'继续对话':'描述要完成的任务';
 const reason=running?'':availability.reason;$('send-state-text').textContent=reason;$('send-state').classList.toggle('hidden',!reason||(!availability.action&&reason==='输入消息，或添加图片 / 文件。'));const action=$('send-state-action');action.classList.toggle('hidden',running||!availability.action||availability.action==='stop');action.dataset.action=availability.action||'';action.textContent=({reconnect:'重新检查连接',cwd:'选择工作目录',pending:'查看消息状态'})[availability.action]||'';
 $('stop').classList.toggle('hidden', !state.busy); $('stop').disabled = state.loadingThread || !state.turnId || !state.connected || !state.serverInstance || state.interruptingTurns.has(state.turnId) || pendingMutations.has('turn/interrupt', state.thread?.id, state.turnId); $('new-thread').disabled = state.sending; $('add-project').disabled=state.sending||projectsState.busy; $('model').disabled = state.busy || state.sending || state.loadingThread; $('effort').disabled = state.busy || state.sending || state.loadingThread; $('model-trigger').disabled = $('effort').disabled; if ($('effort').disabled) closeReasoning(false); $('add-attachment').disabled = state.sending || state.uploadingImages || !state.connected; $('add-file').disabled = $('add-attachment').disabled; $('thread-menu-button').disabled = !state.thread || state.sending || state.loadingThread || state.busy || !!pendingMutations.storageError || threadPendingRecords().length>0; }
function setCwd(cwd) { if(state.cwd !== (cwd || '')){workbench.cwdChanged();pluginPanel.reset();configPanel.reset();prReviewPanel?.reset();} state.cwd = cwd || ''; try { localSession.setItem('codex-light-cwd', state.cwd); } catch {} $('cwd-label').textContent = state.cwd.split(/[\\/]/).filter(Boolean).at(-1) || '选择项目'; $('cwd-button').title = state.cwd || '选择项目'; $('project-name').textContent = state.cwd.split(/[\\/]/).filter(Boolean).at(-1) || '工作区';syncSessionDefaults();updateControls();renderThreads(); }
// ---------- Router: exactly one stage is visible; every page transition goes through here ----------
const STAGES = { chat: 'chat-page', usage: 'usage-page', account: 'account-page', terminal: 'terminal-page', review: 'review-view', settings: 'settings-dialog' };
let currentRoute = 'chat';
function route(name, { section } = {}) {
  if (!Object.hasOwn(STAGES, name)) name = 'chat';
  const previous = currentRoute; currentRoute = name;
  closeWindowMenu(); closeThreadMenu();
  for (const [key, id] of Object.entries(STAGES)) $(id).classList.toggle('hidden', key !== name);
  $('app').dataset.view = name;
  // The thread list is the chat/terminal/review navigator; settings has its own section list.
  $('chat-sidebar').classList.toggle('hidden', name === 'settings');
  $('settings-sidebar').classList.toggle('hidden', name !== 'settings');
  if (name !== 'chat') $('details').classList.add('hidden');
  for (const button of document.querySelectorAll('.rail-btn[data-route]')) button.classList.toggle('active', button.dataset.route === name && !(name === 'settings' && (button.id === 'rail-plugins') !== (section === 'plugins')));
  // Deactivate pages being left so their polling/reads stop.
  if (previous === 'usage' && name !== 'usage') statsView.deactivate();
  if (previous === 'account' && name !== 'account') { accountView.deactivate(); accountLoginPanel.deactivate(); }
  if (previous === 'settings' && name !== 'settings') { pluginPanel.deactivate(); runtimePanel?.setActive?.(false); }
  if (previous === 'review' && name !== 'review') prReviewPanel?.reset();
  if (name === 'usage') statsView.activate();
  if (name === 'account') { accountView.activate(); accountLoginPanel.activate(); }
  if (name === 'settings') { renderDshConnection(); $('cwd-input').value = state.cwd; $('settings-notice').classList.add('hidden'); selectSettingsSection(section || 'general'); }
  if (name === 'terminal') { $('terminal-cwd').textContent = workbench.label() || state.cwd || '先选择工作目录'; terminalControls(); }
  syncDshLiveContext(); syncRuntimePanelActivity();
  sidebarController.closeForNavigation();
  if (name === 'chat') { if (previous !== 'chat') $('prompt').focus(); }
  else (document.querySelector(`#${STAGES[name]} h1, #${STAGES[name]} .stage-bar button`) || $(STAGES[name]))?.focus?.({ preventScroll: true });
}
function openSettings(section = 'general') { route('settings', { section: typeof section === 'string' ? section : 'general' }); }
function closeSettings() { route('chat'); }
function showTerminal() { route('terminal'); }
function showReview() { route('review'); $('pr-review-panel')?.querySelector('button')?.focus(); }
function newThread() {
  if (state.sending) return;
  closeSettings(); sidebarController.closeForNavigation();
  const previous = state.thread?.id || null;
  if (state.busy) notice('原任务继续在后台运行，完成后会出现在对话列表。');
  // A new chat is only a draft; thread/start happens on first send.
  state.openGeneration++; state.loadingThread = false; state.thread = null; state.reasoning = restoredReasoning(null); populateEfforts(); dshTasks.reset(); state.dshReadErrors.clear(); state.dshOpenDetails.clear(); state.dshConnection = null; renderDshConnection(); syncDshLiveContext(); renderDshTasks(); state.turnId = null; state.busy = false; resetThreadView(); $('tool-list').replaceChildren(el('p', 'muted', '暂无工具活动')); $('thread-title').textContent = '新对话'; $('welcome').classList.remove('hidden'); $('earlier').classList.add('hidden'); activity(''); renderContext(); renderQueue(); updateControls(); renderThreads(); $('prompt').focus();
  releaseThread(previous);
}
function renderThreads() {
  projectNavigation.render({projects:projectsState.projects,threads:state.threads,selectedPath:state.cwd,activeThreadId:state.thread?.id||'',searching:!!$('search').value.trim(),busy:projectsState.busy||state.sending,error:projectsState.error});
  $('more-threads').classList.toggle('hidden', !state.nextThreads);
  $('add-project').disabled=projectsState.busy||state.sending;
}
async function loadProjects({restore=false}={}) {
  const generation=++projectsState.generation;
  try {
    const result=await api('/api/projects');
    if(generation!==projectsState.generation)return;
    projectsState.projects=result.projects;projectsState.selectedId=result.selectedId;projectsState.canPickFolder=result.canPickFolder===true;projectsState.error='';
    if(restore&&!state.cwd&&!state.thread){const selected=result.projects.find(project=>project.id===result.selectedId);if(selected)setCwd(selected.path);}
  } catch(error) {if(generation===projectsState.generation)projectsState.error=error.message;}
  if(generation===projectsState.generation)renderThreads();
}
function setProjectBusy(value){projectsState.busy=value;renderThreads();for(const id of ['project-save','project-browse'])$(id).disabled=value;}
function projectError(error){projectsState.error=error.message;renderThreads();if($('project-dialog').open)$('project-status').textContent=error.message;else notice(error.message,true);}
async function saveProjectSelection(group,generation,dialogGeneration) {
  const result=await api('/api/projects/'+(group.projectId?'select':'add'),group.projectId?{id:group.projectId}:{path:group.path});
  projectsState.generation++;projectsState.projects=result.projects;projectsState.selectedId=result.selectedId;projectsState.error='';
  const selected=result.projects.find(project=>project.id===result.selectedId);
  // Navigation or a send started while the chooser was open must keep its own target.
  if(generation!==state.openGeneration||dialogGeneration!==projectsState.dialogGeneration||state.sending){notice('项目已保存到侧栏。当前对话保持原目录。');return;}
  if($('project-dialog').open)$('project-dialog').close();
  $('cwd-setup').classList.add('hidden');
  if(state.loadingThread||projectPathKey(selected.path)!==projectPathKey(state.cwd))newThread();
  setCwd(selected.path);closeSettings();renderThreads();$('prompt').focus();
}
async function selectProject(group) {
  if(projectsState.busy||state.sending||!group.path)return;
  const generation=state.openGeneration,dialogGeneration=projectsState.dialogGeneration;setProjectBusy(true);
  try{await saveProjectSelection(group,generation,dialogGeneration);}catch(error){projectError(error);}finally{setProjectBusy(false);}
}
async function removeProject(group) {
  if(projectsState.busy||!group.projectId)return;
  setProjectBusy(true);
  try{const result=await api('/api/projects/remove',{id:group.projectId});projectsState.generation++;projectsState.projects=result.projects;projectsState.selectedId=result.selectedId;projectsState.error='';}
  catch(error){projectError(error);}finally{setProjectBusy(false);}
}
function openProjectDialog() {
  if(projectsState.busy||state.sending)return;
  const list=$('project-choices');list.replaceChildren();
  for(const project of projectsState.projects){const button=el('button','project-choice');button.type='button';button.title=project.path;button.append(icon(document,'folder'),el('span','',project.name));button.addEventListener('click',()=>selectProject({path:project.path,projectId:project.id}));list.append(button);}
  list.classList.toggle('hidden',!projectsState.projects.length);
  $('project-status').textContent=projectsState.error;
  $('project-path').value=state.cwd;
  $('project-browse').classList.toggle('hidden',!projectsState.canPickFolder);
  $('project-manual').open=!projectsState.canPickFolder;
  if(!$('project-dialog').open){projectsState.dialogGeneration++;$('project-dialog').showModal();}
  (projectsState.canPickFolder?$('project-browse'):$('project-path')).focus();
}
async function addProject() {
  if(projectsState.busy||state.sending)return;
  if(!projectsState.canPickFolder||state.lan){openProjectDialog();return;}
  const generation=state.openGeneration,dialogGeneration=projectsState.dialogGeneration;setProjectBusy(true);
  try{const result=await api('/api/desktop/pick-folder',{}, {timeoutMs:310000});if(result.path)await saveProjectSelection({path:result.path},generation,dialogGeneration);}
  catch(error){projectError(error);}finally{setProjectBusy(false);}
}
async function loadThreads(more = false, current = ()=>true) {
  const generation = ++state.searchGeneration;
  const params = { limit: 30, sortKey: 'updated_at', sortDirection: 'desc' };
  if (more && state.nextThreads) params.cursor = state.nextThreads;
  if ($('search').value.trim()) params.searchTerm = $('search').value.trim();
  const result = await rpc('thread/list', params); if (generation !== state.searchGeneration || !current()) return;
  state.threads = more ? [...state.threads, ...(result.data || [])] : result.data || [];
  // Keep the navigation bounded too; use server-side search instead of loading all history.
  if (state.threads.length > 300) { state.threads = state.threads.slice(-300); notice('侧栏仅保留最近加载的 300 个对话，可用搜索查找其他对话。'); }
  state.nextThreads = result.nextCursor; renderThreads();
}
const CONVERSATION_ITEMS = 300;
const historyCaps = historyCapabilities();
function sessionFor(threadId) { return state.threadSessions.find(row => row.threadId === threadId) || null; }
async function openThread(thread) {
  const generation = ++state.openGeneration; activity('正在载入对话…'); state.loadingThread = true; updateControls();
  const previous = state.thread?.id || null;
  try {
    // History is read-only: never resume or subscribe just to look at a conversation.
    const result = await rpc('thread/read', { threadId: thread.id });
    if (generation !== state.openGeneration) return;
    state.thread = result.thread || thread; dshTasks.reset(state.thread.id); state.dshReadErrors.clear(); state.dshOpenDetails.clear(); state.dshConnection = null; renderDshConnection(); syncDshLiveContext(); renderDshTasks(); restoreThreadReasoning({ model: state.thread.model, reasoningEffort: state.thread.reasoningEffort }); resetThreadView(); state.busy = false; state.turnId = null;
    if (state.thread.cwd) setCwd(state.thread.cwd); $('thread-title').textContent = state.thread.name || state.thread.preview || '对话'; $('welcome').classList.add('hidden'); renderThreads(); renderContext(); renderQueue();
    let running = null;
    try { running = await loadTurns(false, generation); } catch (e) { if (!/method|not found|unsupported|unknown|32601/i.test(e.message)) notice('无法读取任务状态：' + e.message, true); }
    if (generation !== state.openGeneration) return;
    await loadItems(false, generation);
    if (generation !== state.openGeneration) return;
    const activeId = state.activeTurns.get(thread.id) || sessionFor(thread.id)?.activeTurnId || running?.id;
    if (activeId) { state.busy = true; state.turnId = activeId; state.ledger.activate(activeId); renderMessages(false); watchExternalTurn(); }
    activity(''); const wasOverlay=sidebarController.isOverlayOpen(); sidebarController.closeForNavigation(); if(wasOverlay)$('conversation').focus();
  } finally {
    if (generation === state.openGeneration) { state.loadingThread = false; updateControls(); }
    if (previous && previous !== state.thread?.id) releaseThread(previous);
  }
}
// A turn running in another client is only read here, so no events arrive for it.
// Poll its read-only status until it ends, then refresh history. Never subscribes.
let externalWatch = null;
function watchExternalTurn() {
  clearTimeout(externalWatch); externalWatch = null;
  if (!state.busy || !state.thread || sessionFor(state.thread.id)?.activeTurnId === state.turnId) return;
  const threadId = state.thread.id, generation = state.openGeneration, turnId = state.turnId;
  externalWatch = setTimeout(async () => {
    if (generation !== state.openGeneration || !state.busy || state.turnId !== turnId) return;
    try {
      const result = await rpc('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
      if (generation !== state.openGeneration) return;
      const latest = Array.isArray(result.data) ? result.data[0] : null; if (latest) state.ledger.merge(latest);
      if (latest && (latest.id !== turnId || latest.status !== 'inProgress') && state.turnId === turnId && sessionFor(threadId)?.activeTurnId !== turnId) {
        state.busy = false; state.turnId = null; state.activeTurns.delete(threadId);
        await loadItems(false, generation); updateControls(); drainQueue(threadId); return;
      }
    } catch { /* keep polling; status stays as last known */ }
    watchExternalTurn();
  }, 5000);
}
/** Turn metadata (status, duration) without items. Returns the in-progress turn, if any. */
async function loadTurns(earlier, generation) {
  const id = state.thread?.id; if (!id) return null;
  const params = { threadId: id, limit: 30, sortDirection: 'desc', itemsView: 'notLoaded' };
  if (earlier) { if (!state.nextTurns) return null; params.cursor = state.nextTurns; }
  const result = await rpc('thread/turns/list', params);
  if (generation !== state.openGeneration || id !== state.thread?.id) return null;
  const rows = Array.isArray(result.data) ? result.data : [];
  for (const turn of rows) state.ledger.merge(turn);
  state.nextTurns = result.nextCursor || null;
  return rows.find(turn => turn.status === 'inProgress') || null;
}
async function loadItems(earlier = false, generation = state.openGeneration, current = ()=>true) {
  const id = state.thread?.id; if (!id) return;
  // Read-only paging: thread/items/list, else thread/turns/list(itemsView:'full') + cursor, else one
  // explicit thread/read. A fresh (non-earlier) load restarts from the newest page.
  if (earlier && (!state.pager || state.pager.threadId !== id || !state.pager.hasMore)) return;
  const pager = earlier ? state.pager : new HistoryPager(rpc, id, historyCaps);
  const page = await pager.next({ max: 80 });
  if (!current() || generation !== state.openGeneration || id !== state.thread?.id) return;
  if (!earlier) state.pager = pager; else if (state.pager !== pager) return;
  const items = page.items;
  for (const turn of page.turns) state.ledger.merge(turn);
  if (page.activeTurnId) state.activeTurns.set(id, page.activeTurnId);
  // Turn metadata of older pages: items/list mode only (turns/read modes carry it in the page).
  if (earlier && page.mode === 'items' && state.nextTurns) await loadTurns(true, generation).catch(() => {});
  if (!current() || generation !== state.openGeneration || id !== state.thread?.id) return;
  state.historyFallback = page.mode !== 'items';
  if (page.fullRead && page.read) notice(earlier
    ? `此 Codex CLI 不支持分页读取，已再次完整读取对话并显示更早的 ${page.read.shownTurns} / ${page.read.totalTurns} 个回合。`
    : `此 Codex CLI 不支持分页读取，已一次完整读取对话（共 ${page.read.totalTurns} 个回合），先显示最近 ${page.read.shownTurns} 个回合${page.hasMore ? '；“加载更早的内容”需要再次完整读取' : ''}。`);
  for (const item of items.slice(-CONVERSATION_ITEMS)) dshTasks.ingest(id, item, { older: earlier, source: '已加载的 Codex 对话记录' });
  const oldHeight = $('conversation').scrollHeight;
  if (earlier) {
    // Prepend older history while keeping pooled image bytes of items that stay in the window.
    const existing = state.store.values(); const seen = new Set(); const merged = [];
    for (const item of [...items, ...existing]) if (!seen.has(item.id)) { seen.add(item.id); merged.push(item); }
    state.store.replaceWindow(merged.slice(0, CONVERSATION_ITEMS));
    if (merged.length > CONVERSATION_ITEMS) notice(`为保持流畅，当前只显示这一段的 ${CONVERSATION_ITEMS} 项；重新打开对话可返回最新内容。`);
  } else { for (const item of items.slice(-CONVERSATION_ITEMS)) state.store.upsert(item); }
  state.nextItems = pager.hasMore ? pager.mode : null;
  $('earlier').classList.toggle('hidden', !pager.hasMore);
  $('earlier').title = pager.nextNeedsFullRead ? '此 Codex CLI 不支持分页读取：加载更早内容需要再次完整读取对话' : '';
  renderMessages(false);
  if (earlier) $('conversation').scrollTop += $('conversation').scrollHeight - oldHeight; else scrollBottom();
}
function scrollBottom() { $('conversation').scrollTop = $('conversation').scrollHeight; }
function titleFor(item) { return { commandExecution: '运行命令', fileChange: '文件改动', mcpToolCall: 'MCP 工具', dynamicToolCall: '工具调用', webSearch: '网页搜索', reasoning: '思考摘要', plan: '任务计划', collabAgentToolCall: '子代理' }[item.type] || item.type || '活动'; }
function toolDescription(item) { return boundedText(item.command || (item.server ? `${item.server} / ${item.tool || ''}` : '') || item.tool || item.query || item.changes?.map(c => c.path).join('\n') || titleFor(item), 6000); }
function renderMessages(follow = true) {
  const box = $('conversation'); const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
  const items = state.store.values();
  const turns = buildTurns(items, state.ledger, { activeTurnId: state.busy ? state.turnId : null, cwd: state.thread?.cwd || state.cwd });
  conversation.render(turns);
  liveChanges.update(pillChanges(turns));
  state.store.dirty.clear(); $('welcome').classList.toggle('hidden', !!state.thread || items.length > 0);
  if (!$('details').classList.contains('hidden')) { if (state.detailsTab === 'dsh') renderDshTasks(); else renderTools(); }
  if (follow && nearBottom) scrollBottom();
}
function scheduleRender() { if (state.rendering) return; state.rendering = true; setTimeout(() => requestAnimationFrame(() => { state.rendering = false; renderMessages(); }), 32); }
function renderTools() {
  const tools = state.store.values().filter(i => toolTypes.has(i.type)).slice(-25); const frag = document.createDocumentFragment();
  for (const item of tools) { const card = el('section', 'tool-card'); card.append(el('strong', '', toolDescription(item)), el('small', '', `${titleFor(item)} · ${item.status || '进行中'}`), el('pre', '', boundedText(itemText(item), 8000))); frag.append(card); }
  if (!tools.length) frag.append(el('p', 'muted', '暂无工具活动')); $('tool-list').replaceChildren(frag);
}
const dshView = createDshView({ document, state, $, dshLive, dshTasks, api, rpc, el });
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
    const chip = el('div', 'attachment-chip'); const preview = attachmentPreviews.get(file.id);
    if (preview) { const image = el('img'); image.src = preview; image.alt = ''; image.addEventListener('error', () => { image.hidden = true; }); chip.append(image); }
    const label = el('span', 'attachment-label'); label.title = file.name; label.append(el('strong', '', file.name), el('small', '', `${(file.size / 1024).toFixed(0)} KiB · 已本地暂存`)); chip.append(label);
    const remove = el('button', 'icon-btn'); remove.append(icon(document,'close')); remove.type = 'button'; remove.setAttribute('aria-label', '取消附带 ' + file.name); remove.title = '仅取消这次发送，不删除原文件'; remove.disabled = state.sending;
    remove.addEventListener('click', () => { removeAttachment(file.id); renderAttachments(); updateControls(); }); chip.append(remove); fragment.append(chip);
  }
  for (const file of regularFiles) {
    const chip = el('div','attachment-chip'); chip.append(icon(document,'file'));
    const label = el('span','attachment-label'); label.title=file.name; label.append(el('strong','',file.name),el('small','',`${(file.size/1024).toFixed(0)} KiB · 文件引用${file.riskWarning ? ' · 发送前需确认风险' : ''}`)); chip.append(label);
    const remove = el('button','icon-btn'); remove.type='button'; remove.append(icon(document,'close')); remove.setAttribute('aria-label','取消附带 '+file.name); remove.disabled=state.sending; remove.addEventListener('click',()=>{fileAttachmentDraft.remove(file.id);renderAttachments();updateControls();}); chip.append(remove); fragment.append(chip);
  }
  if (regularFiles.length) fragment.append(el('small','attachment-note','文件保存在本机附件缓存；发送仅交付路径引用，不自动解析、执行或解包，也不扩大 Codex / DSH 读取权限。移除仅取消本次发送，历史引用所需副本会保留。图片和文件合计最多 5 个。'));
  if (state.uploadingImages) fragment.append(el('span', 'attachment-uploading', '正在本地准备附件…'));
  if (files.length) fragment.append(el('small', 'attachment-note', '点击发送才会交给 Codex；图片支持以所选模型为准，未知能力不保证可用。移除仅取消本次发送；副本在服务关闭时清理。'));
  container.replaceChildren(fragment);
}
async function uploadChosenImages(files) {
  if (state.uploadingImages || state.sending) return;
  try { validateFileSelection(files, attachmentDraft.values().length + fileAttachmentDraft.values().length); validateImageSelection(files, attachmentDraft.values().length); } catch (error) { notice(error.message, true); return; }
  state.uploadingImages = true; renderAttachments(); updateControls();
  try {
    for (const file of files) {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 90000);
      try {
        const response = await fetch('/api/uploads', { method: 'POST', signal: controller.signal, headers: { Authorization: `Bearer ${token}`, 'X-Filename': encodeURIComponent(file.name), 'Content-Type': file.type || 'application/octet-stream' }, body: file });
        const record = await response.json(); if (!response.ok || record.error) throw new Error(record.error || `本地暂存失败 (${response.status})`);
        attachmentDraft.add(record); attachmentPreviews.set(record.id, URL.createObjectURL(new Blob([file], { type: record.mime }))); renderAttachments();
      } finally { clearTimeout(timer); }
    }
  } catch (error) { notice('图片未全部准备好：' + error.message + '。已成功的图片仍保留；没有发送给模型。', true); }
  finally { state.uploadingImages = false; renderAttachments(); updateControls(); }
}
async function uploadChosenFiles(files) {
  if (state.uploadingImages || state.sending) return;
  try { validateFileSelection(files,attachmentDraft.values().length+fileAttachmentDraft.values().length); } catch(error) { notice(error.message,true); return; }
  state.uploadingImages=true;renderAttachments();updateControls();
  try { for (const file of files) {
    const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),90000);
    try { const response=await fetch('/api/file-uploads',{method:'POST',signal:controller.signal,headers:{Authorization:`Bearer ${token}`,'X-Filename':encodeURIComponent(file.name),'X-File-Mime':file.type || 'application/octet-stream','Content-Type':'application/octet-stream'},body:file});
      const record=await response.json(); if(!response.ok || record.error) throw new Error(record.error || `本地缓存失败 (${response.status})`); fileAttachmentDraft.add(record);renderAttachments();
    } finally {clearTimeout(timer);}
  }} catch(error) {notice('文件未全部准备好：'+error.message+'。已成功的文件仍保留；没有发送路径或正文给模型。',true);}
  finally {state.uploadingImages=false;renderAttachments();updateControls();}
}
function clearSubmittedDraft(envelope) {
  if (!['turn/start', 'turn/steer'].includes(envelope?.method)) return;
  const submitted = envelope.params?.input?.[0]?.text;
  if (typeof submitted === 'string' && $('prompt').value.trim() === submitted.trim()) { $('prompt').value = ''; autosizePrompt(); }
  for (const id of envelope.attachmentIds || []) removeAttachment(id);
  for (const id of envelope.fileAttachmentIds || []) fileAttachmentDraft.remove(id);
  renderAttachments(); updateControls();
}
async function inspectRelatedRequest(marker) {
  if(marker.method==='runtime/upgrade'){openSettings('general');runtimePanel?.refresh();return;}
  if(marker.method==='config/apply'){openSettings('configuration');return;}
  if(marker.method==='git/apply'){showTerminal();showWorkspaceTab('git');return;}
  if(marker.method==='plugin/apply'){openSettings('plugins');return;}
  if(marker.method.startsWith('account/')){openSettings('account');return;}
  if (marker.method==='terminal/open') { showTerminal(); return; }
  if (marker.method.startsWith('remoteControl/')) { openSettings('remote'); return; }
  if (marker.threadId) await openThread({ id: marker.threadId, name: '原请求所在对话' });
  else { await loadThreads(); notice('这次请求正在创建新对话；正在自动同步状态，请稍后在最近对话中查看。'); }
}
async function sendAsExplicitNewTask(marker) {
  if (state.sending || state.busy || !state.connected || !$('prompt').value.trim()) { notice('请先选择空闲对话并填写要发送的草稿。原请求仍保留，不会自动重发。'); return; }
  if (!confirm('原请求的执行结果仍不确定。将当前草稿作为新任务发送，旧任务也可能继续执行，可能产生重复改动和重复用量。\n仍要作为新任务发送吗？')) return;
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
  container.replaceChildren(fragment);renderAccountPending();renderPluginPending();renderGitPending();renderConfigPending();
}
async function performMutation(method, params, extras = {}) {
  let envelope;
  try { envelope = pendingMutations.begin(state.serverInstance, method, params, extras); }
  catch (error) { error.outcome = 'notExecuted'; renderPendingMutations(); throw error; }
  mutationContexts.set(envelope.requestId,{openGeneration:state.openGeneration});
  renderPendingMutations(); updateControls();
  try {
    const result = method==='runtime/upgrade'
      ? await api('/api/runtime/upgrade',{...envelope.params,requestId:envelope.requestId},{timeoutMs:1860000})
      : await (method==='config/apply' ? api('/api/config-settings/apply',{...envelope.params,requestId:envelope.requestId}) : method==='git/apply' ? api('/api/git/apply',{...envelope.params,requestId:envelope.requestId}) : method==='plugin/apply' ? api('/api/plugins/apply',{...envelope.params,requestId:envelope.requestId}) : method==='terminal/open' ? api('/api/terminal/open',{...envelope.params,requestId:envelope.requestId}) : method.startsWith('account/') ? api('/api/'+method,{...envelope.params,requestId:envelope.requestId}) : api('/api/rpc', envelope));
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
function resetThreadDsh(threadId) { dshTasks.reset(threadId); state.dshReadErrors.clear(); state.dshOpenDetails.clear(); state.dshConnection = null; renderDshConnection(); syncDshLiveContext(); renderDshTasks(); }
const composer = createComposer({ document,
  session: { state, followUps, sessionFor },
  drafts: { attachmentDraft, fileAttachmentDraft, attachmentPreviews, queuedPreviews, clearSubmittedDraft, renderAttachments, autosizePrompt: () => autosizePrompt() },
  ledger: { performMutation, pendingMutations, scopedPending, currentSendAvailability: () => currentSendAvailability(), renderPendingMutations: () => renderPendingMutations() },
  thread: { restoreThreadReasoning: (...args) => restoreThreadReasoning(...args), loadThreads: (...args) => loadThreads(...args), syncStatus: () => syncStatus(), resetThreadDsh },
  view: { $, el, notice, activity, confirm: text => confirm(text), updateControls: () => updateControls(), renderMessages: (...args) => renderMessages(...args), scheduleRender: () => scheduleRender(), scrollBottom: () => scrollBottom(), renderContext: () => renderContext(), openProjectDialog: () => openProjectDialog(), openInlineCwd: () => openInlineCwd() } });
const { send, queueDraft, hasDraft, runningInputAvailable, drainAll, drainQueue, renderQueue } = composer;

// ---------- Context meter ----------
function renderContext() {
  const snapshot = state.thread ? state.contexts.get(state.thread.id) || null : null;
  const view = contextView(snapshot); const meter = $('context-meter');
  meter.dataset.known = String(view.known);
  meter.style.setProperty('--ctx-used', view.known ? String(Math.round(view.ratio * 100)) : '0');
  meter.dataset.level = !view.known ? 'unknown' : view.percentLeft <= 10 ? 'low' : view.percentLeft <= 25 ? 'warn' : 'ok';
  $('context-label').textContent = view.known ? view.label : '—';
  meter.title = view.detail; meter.setAttribute('aria-label', view.detail);
  meter.classList.toggle('hidden', !state.thread);
}

// ---------- Slash menu ----------
const slashMenu = createSlashMenu({ document, prompt: $('prompt'), menu: $('slash-menu'), el, rpc,
  context: () => ({ thread: !!state.thread, busy: state.busy, sending: state.sending, connected: state.connected, cwd: state.thread?.cwd || state.cwd }),
  commands: { new: newThread, compact: () => compactThread(), review: () => reviewLocalChanges(), fork: () => forkCurrentThread(), rename: () => openRename(), model: () => openReasoning(), usage: () => route('usage'), account: () => route('account'), terminal: () => showTerminal() },
  onDraftChange: () => { autosizePrompt(); updateControls(); } });
async function compactThread() {
  if (!state.thread || state.busy || state.sending) return;
  const threadId = state.thread.id; state.sending = true; updateControls(); activity('正在请求压缩上下文…');
  try { await performMutation('thread/compact/start', { threadId }); if (state.thread?.id === threadId) activity('已开始压缩上下文'); }
  catch (e) { showMutationFailure(e, '压缩上下文'); activity(''); }
  finally { state.sending = false; updateControls(); }
}
function autosizePrompt() { const prompt = $('prompt'); prompt.style.height = 'auto'; prompt.style.height = Math.min(prompt.scrollHeight, 220) + 'px'; }
// IME composition always wins: Enter/arrow keys confirm candidates and must not send or move the menu.
function onPromptKey(e) {
  if (e.isComposing || e.keyCode === 229) return;
  if (slashMenu.handleKey(e)) return;
  if (e.key === 'Tab' && !e.shiftKey && state.busy && state.thread && hasDraft()) { e.preventDefault(); queueDraft(); return; }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
}

function restoreThreadReasoning(result, override) {
 const model=typeof result.model==='string'?result.model:'';
 if(model&&![...$('model').options].some(option=>option.value===model))$('model').append(new Option(model+'（目录外）',model));
 $('model').value=model;state.reasoning=restoredReasoning(result.reasoningEffort);if(override)state.reasoning.override=override;populateEfforts();
}
function populateEfforts(modelChanged = false) {
 const active=effectiveModel(),model=active.model;if(modelChanged){const configured=sessionDefaults.snapshot().value?.model||null;state.reasoning=switchedReasoning(model,state.reasoning,{configuredModel:configured,selectedModel:$('model').value});}
 const select=$('effort');select.replaceChildren(new Option('默认 / 继承线程设置',''));
 for(const value of reasoningChoices(model))select.append(new Option(effortLabel(value),value));
 const explicit=reasoningParameter(state.reasoning);if(explicit&&![...select.options].some(option=>option.value===explicit))select.append(new Option(effortLabel(explicit),explicit));select.value=explicit||'';renderReasoning();
}
function renderReasoning() {
  const defaults=sessionDefaults.snapshot(), active=effectiveModel(), view=configuredReasoningView(active.model,state.reasoning,defaults.value,active.id), modelView=defaultModelView(state.models,$('model').value,defaults.value);
  const name=formatModelDisplayName(modelView.displayName)||'Codex 默认模型', effortText=view.effective?effortLabel(view.effective):'默认 / 未知';
  const label=view.effective?effortLabel(view.effective):(defaults.loading?'读取中…':'默认');
  const defaultLabel='默认模型 · 继承配置';
  $('model-trigger').replaceChildren(el('span','model-trigger-label',`${name} · ${effortText}`),icon(document,'down',{size:14}));
  $('model-trigger').title=modelView.source==='config'?`Codex 配置默认模型：${boundedText(modelView.id||'未知',512)}${modelView.outsideCatalog?'（不在当前模型目录）':''}`:name; $('reasoning-model-name').title=$('model-trigger').title; $('reasoning-model-name').textContent=name; $('reasoning-label').textContent=label;
  $('reasoning-label').title=view.source==='override'?'显式发送所选思考强度':view.source==='inherited'?'沿用服务端线程设置；不发送强度覆盖':view.configUnsupported?`Codex 配置默认强度 ${effortLabel(view.configured)} 不在当前模型支持范围；不会发送`:view.configSupport==='unknown'?`Codex 配置默认强度 ${effortLabel(view.configured)} 是否被当前模型支持未知；不会发送`:view.source==='config'?'Codex 配置默认强度；发送时不写入覆盖值':defaults.loading?'正在读取 Codex 配置默认值；尚未发送任何设置':defaults.error?'Codex 配置默认值读取失败；发送时不写入覆盖值，可打开模型列表重试':'未读取 Codex 配置默认值；发送时不写入覆盖值';
  const range=$('reasoning-range');range.max=String(Math.max(0,view.choices.length-1));range.value=String(Math.max(0,view.index));range.disabled=!view.choices.length||$('effort').disabled;
  range.setAttribute('aria-valuetext',view.effective?effortAccessibleLabel(view.effective)+(view.source==='config'?'（Codex 配置默认）':view.source==='inherited'?'（继承线程设置）':'（显式发送）'):view.configUnsupported?`配置强度 ${effortAccessibleLabel(view.configured)} 不被当前模型支持`:view.configSupport==='unknown'?`配置强度 ${effortAccessibleLabel(view.configured)} 是否被当前模型支持未知`:'默认强度未知');
  const ratio=Math.max(0,view.index)/Math.max(1,view.choices.length-1);
  $('reasoning-track').style.setProperty('--effort-fill',`calc(14px + (100% - 28px) * ${ratio})`);$('reasoning-track').classList.toggle('unknown',view.index<0);
  const ticks=document.createDocumentFragment();for(let i=0;i<view.choices.length;i++){const tick=el('i');tick.style.left=`${100*i/Math.max(1,view.choices.length-1)}%`;ticks.append(tick);} $('reasoning-ticks').replaceChildren(ticks);
  const entries=[{model:'',displayName:defaultLabel},...state.models.filter(m=>!m.hidden)];if($('model').value&&!entries.some(entry=>entry.model===$('model').value))entries.push({model:$('model').value,displayName:$('model').value+'（目录外）'});
  const options=document.createDocumentFragment();for(const entry of entries){const button=el('button','model-option');button.type='button';button.setAttribute('aria-pressed',String(entry.model===$('model').value));button.title=entry.model?`${formatModelDisplayName(entry.displayName||entry.model)} · ${entry.model}`:'继承 Codex 配置中的当前默认模型，不另行固定模型';button.append(el('span','',formatModelDisplayName(entry.displayName||entry.model)),entry.model===$('model').value?icon(document,'check',{size:15}):el('span'));button.addEventListener('click',()=>{$('model').value=entry.model;populateEfforts(true);showReasoningModels(false);$('reasoning-range').disabled?$('model-list-open').focus():$('reasoning-range').focus();});options.append(button);}
  if(defaults.loading)options.append(el('p','model-option-note','正在读取 Codex 配置默认值…'));
  else if(defaults.error){const retry=el('button','model-option');retry.type='button';retry.append(el('span','','重新读取 Codex 配置默认值'));retry.title='上次读取失败：'+boundedText(defaults.error,300);retry.addEventListener('click',()=>{sessionDefaults.retry();});options.append(retry);}
  $('model-options').replaceChildren(options);
}
function showReasoningModels(show){$('reasoning-controls').classList.toggle('hidden',show);$('reasoning-model-list').classList.toggle('hidden',!show);$('reasoning-popover').classList.toggle('models-open',show);}
function closeReasoning(focus=true){if($('reasoning-popover').classList.contains('hidden'))return;$('reasoning-popover').classList.add('hidden');$('model-trigger').setAttribute('aria-expanded','false');if(focus)$('model-trigger').focus();}
function openReasoning(){if($('model-trigger').disabled)return;renderReasoning();showReasoningModels(false);$('reasoning-popover').classList.remove('hidden');$('model-trigger').setAttribute('aria-expanded','true');($('reasoning-range').disabled?$('model-list-open'):$('reasoning-range')).focus();}
$('model-trigger').addEventListener('click',()=>{$('reasoning-popover').classList.contains('hidden')?openReasoning():closeReasoning();});
$('reasoning-range').addEventListener('input',()=>{const model=effectiveModel().model;state.reasoning.override=reasoningChoices(model)[Number($('reasoning-range').value)]||null;populateEfforts();});
$('reasoning-range').addEventListener('click',()=>{if($('reasoning-track').classList.contains('unknown')&&!$('reasoning-range').disabled){const model=effectiveModel().model;state.reasoning.override=reasoningChoices(model)[Number($('reasoning-range').value)]||null;populateEfforts();}});
$('reasoning-reset').addEventListener('click',()=>{const model=effectiveModel().model;state.reasoning=resetReasoning(model,state.reasoning);populateEfforts();if(!state.reasoning.override)notice('模型目录未提供默认强度，已取消本地覆盖；继续继承线程设置，不代表已清除服务端原强度。');});
$('model-list-open').addEventListener('click',()=>{showReasoningModels(true);const active=$('model-options').querySelector('[aria-pressed="true"]');active?.focus();active?.scrollIntoView({block:'nearest',inline:'nearest'});});
$('model-list-back').addEventListener('click',()=>{showReasoningModels(false);$('model-list-open').focus();});
$('effort').addEventListener('change',()=>{state.reasoning.override=$('effort').value||null;renderReasoning();});
$('reasoning-popover').addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeReasoning();}else if(['ArrowDown','ArrowUp'].includes(event.key)&&!$('reasoning-model-list').classList.contains('hidden')){const buttons=[...$('reasoning-model-list').querySelectorAll('button')];const index=buttons.indexOf(document.activeElement);event.preventDefault();const next=buttons[(index+(event.key==='ArrowDown'?1:buttons.length-1))%buttons.length];next?.focus();next?.scrollIntoView({block:'nearest',inline:'nearest'});}});
document.addEventListener('pointerdown',event=>{if(!event.target.closest('.model-control'))closeReasoning(false);});
document.addEventListener('focusin',event=>{if(!event.target.closest('.model-control'))closeReasoning(false);});
document.addEventListener('keydown',event=>{if(event.ctrlKey&&event.shiftKey&&event.key.toLowerCase()==='m'){event.preventDefault();openReasoning();}});
// model-loader:start
async function loadModels(current=()=>true) {
  const generation=++state.modelGeneration,selected=$('model').value,rows=[],seenModels=new Set(),seenCursors=new Set();let cursor=null;
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
  state.models=rows;$('model').replaceChildren(new Option('使用 Codex 配置默认模型',''));for(const model of rows.filter(m=>!m.hidden))$('model').append(new Option(formatModelDisplayName(model.displayName||model.model),model.model));if(selected&&!Array.from($('model').options).some(option=>option.value===selected))$('model').append(new Option(selected+'（目录外）',selected));$('model').value=selected;populateEfforts();
}
// model-loader:end
function renderRequests() {
  renderApprovals($('approvals'), { document, requests: state.requests, currentThreadId: state.thread?.id || null, api, notice, confirm: text => confirm(text), el, boundedText, permissionOptions, permissionResponse, formDefinition, formResponse, rerender: renderRequests });
}
function onEvent(message) {
  for(const handler of eventSubscribers){try{handler(message);}catch{notice('工具面板未能处理此事件；不会自动重发请求。',true);}}
  if(message.method==='account/updated'){resetAccountScopedViews('账户已更新');return;}
  if(message.method==='bridge/accountLogin'){accountLoginPanel.update(message.params);if(['completed','loggedOut'].includes(message.params?.state))resetAccountScopedViews('账户已改变');return;}
  if(message.method==='thread/tokenUsage/updated'){if(!state.connected)return;const snapshot=contextSnapshot(message.params);if(snapshot){state.contexts.set(snapshot.threadId,snapshot);if(snapshot.threadId===state.thread?.id)renderContext();}return;}
  if(message.method==='bridge/threadSessions'){applyThreadSessions(message.params);return;}
  if(message.method==='skills/changed'){slashMenu.invalidateSkills();return;}
  if (message.method === 'remoteControl/status/changed') { applyRemoteStatus(message.params); return; }
  if (message.method === 'bridge/dshSnapshot') { ingestDshSnapshot(message.params); return; }
  if (message.method === 'bridge/status') { const connected=!!message.params?.connected;setConnected(connected);if(connected&&!state.serverInstance)syncStatus().catch(error=>notice('连接已建立，但本地服务标识读取失败：'+error.message+'。目录尚未加载；可点击重新检查连接。',true)); if (message.params?.error) notice(message.params.error, true); return; }
  if (message.method === 'bridge/warning') { notice(message.params?.message || '本地桥接警告'); return; }
  if (message.id !== undefined && message.method) { state.requests.set(String(message.id), message); renderRequests(); if(preferencesView.current().approvalNotice)notice('收到待审批请求；请核对具体内容后选择，不会自动批准。'); return; }
  const p = message.params || {};
  if (message.method === 'serverRequest/resolved') { state.requests.delete(String(p.requestId)); renderRequests(); return; }
  if (message.method === 'error' && (!p.threadId || p.threadId === state.thread?.id)) { notice(p.error?.message || p.message || 'Codex 返回错误', true); return; }
  if (message.method === 'turn/started') { state.activeTurns.set(p.threadId, p.turn?.id); }
  if (message.method === 'turn/completed') { if(preferencesView.current().completionNotice&&!state.terminalTurns.has(p.turn?.id))notice('任务'+(p.turn?.status==='completed'?'已完成':p.turn?.status==='interrupted'?'已停止':'已结束，请查看结果')+'。'); for (const [key, request] of state.requests) if (request.params?.threadId === p.threadId && (!request.params?.turnId || request.params.turnId === p.turn?.id)) state.requests.delete(key); renderRequests(); state.activeTurns.delete(p.threadId); state.interruptingTurns.delete(p.turn?.id); state.terminalTurns.add(p.turn?.id); if (state.terminalTurns.size > 100) state.terminalTurns.delete(state.terminalTurns.values().next().value);
    // The queue only advances after a normal completion; anything else waits for the user.
    if (p.turn?.status !== 'completed') followUps.pause(p.threadId, p.turn?.status === 'interrupted' ? '任务已停止' : '任务未正常完成');
    setTimeout(() => drainQueue(p.threadId), 0); }
  if (!state.thread || p.threadId !== state.thread.id) return;
  const turnId = typeof p.turnId === 'string' ? p.turnId : p.turn?.id;
  if (message.method === 'item/started' || message.method === 'item/completed') {
    const extra = { _complete: message.method === 'item/completed' };
    if (turnId) extra._turnId = turnId;
    if (Number.isFinite(p.startedAtMs)) extra._startedAtMs = p.startedAtMs;
    if (Number.isFinite(p.completedAtMs)) extra._completedAtMs = p.completedAtMs;
    // A confirmed steer was shown locally; the native user item replaces it.
    if (p.item?.type === 'userMessage') { const text = itemText(p.item).trim(); for (const local of state.store.values()) if (local._local && local._turnId === turnId && itemText(local).trim() === text) state.store.delete(local.id); }
    state.store.upsert({ ...p.item, ...extra }); dshTasks.ingest(p.threadId, p.item); scheduleRender();
  }
  else if (message.method === 'item/mcpToolCall/progress') { if (dshTasks.progress(p.threadId, p.itemId, p.message)) scheduleRender(); }
  else if (message.method === 'turn/diff/updated') { state.ledger.setDiff(p.turnId, p.diff); scheduleRender(); }
  else if (message.method === 'item/fileChange/patchUpdated') { const item = state.store.items.get(p.itemId); state.store.upsert({ ...(item || { id: p.itemId, type: 'fileChange', status: 'inProgress' }), changes: p.changes, _turnId: p.turnId, _complete: false }); scheduleRender(); }
  else if (message.method === 'item/agentMessage/delta') { state.store.delta(p.itemId, p.delta); tagTurn(p.itemId, turnId); scheduleRender(); }
  else if (message.method === 'item/reasoning/summaryTextDelta') { const item = state.store.items.get(p.itemId) || { id: p.itemId, type: 'reasoning', summary: [] }; const summary = Array.isArray(item.summary) ? [...item.summary] : []; const index = Number.isSafeInteger(p.summaryIndex) && p.summaryIndex >= 0 && p.summaryIndex < 64 ? p.summaryIndex : summary.length; summary[index] = boundedText((summary[index] || '') + p.delta, 16000); state.store.upsert({ ...item, summary, _turnId: item._turnId || turnId, _complete: false }); scheduleRender(); }
  else if (message.method === 'item/commandExecution/outputDelta') { state.store.delta(p.itemId, p.delta, 'commandExecution', 'aggregatedOutput'); tagTurn(p.itemId, turnId); scheduleRender(); }
  else if (message.method === 'turn/started') { state.ledger.merge(p.turn, { observedStartMs: Date.now() }); state.turnId = p.turn?.id; state.busy = true; activity(''); renderMessages(); updateControls(); }
  else if (message.method === 'turn/completed') { state.ledger.merge(p.turn, { observedEndMs: Date.now() }); if (state.turnId === p.turn?.id || !state.turnId) { state.busy = false; state.turnId = null; } activity(p.turn?.status === 'failed' ? '任务未完成' : ''); if (p.turn?.error) notice(p.turn.error.message || JSON.stringify(p.turn.error), true); renderMessages(); renderQueue(); updateControls(); loadThreads().catch(() => {}); }
  else if (message.method === 'turn/plan/updated') { state.store.upsert({ id: `plan-${p.turnId}`, type: 'plan', text: p.explanation || '', content: p.plan, _turnId: p.turnId, _complete: true }); scheduleRender(); }
}
function tagTurn(itemId, turnId) { const item = state.store.items.get(itemId); if (item && turnId && !item._turnId) item._turnId = turnId; }
/** Bridge-owned sessions (this process only). Used to keep background work visible after navigation. */
function applyThreadSessions(params) {
  state.threadSessions = Array.isArray(params?.threads) ? params.threads.filter(row => typeof row?.threadId === 'string') : [];
  for (const row of state.threadSessions) if (row.activeTurnId && !state.terminalTurns.has(row.activeTurnId)) state.activeTurns.set(row.threadId, row.activeTurnId);
  const failed = state.threadSessions.find(row => row.releaseError); if (failed) notice(failed.releaseError, true);
  updateControls(); drainAll();
}
async function syncStatus() {
  const status = await api('/api/status'); applyAccessMode(state.lan || status.access === 'lan'); state.cliVersion = typeof status.version==='string'&&status.version ? boundedText(status.version,300) : null; state.desktop = status.desktop === true; if($('version-info'))$('version-info').textContent=state.cliVersion||'未知'; document.body.classList.toggle('native-desktop',state.desktop); $('runtime-close-info').textContent = state.desktop ? '关闭窗口时可选择退出并停止本应用后台、转入托盘继续运行或取消。托盘菜单可以重新打开或退出；退出可能中断本应用任务，独立 DSH 任务可能继续。' : '关闭窗口不等于停止服务。需要结束本次 GUI 服务时使用下面的按钮；正在运行的任务可能中断，独立 DSH 任务可能继续。'; $('reopen-info').textContent = state.desktop ? '再次启动会建立新连接并读取官方对话历史；不保存浏览器配置文件，不承诺无缝恢复。' : status.reopenAvailable === true ? '可安全重新打开本地 GUI' : status.reopenAvailable === false ? '当前不可用。关闭窗口后可能需要恢复原窗口或重新运行启动器；不会承诺能无缝重开。' : '未知（服务未提供重开状态）'; if (!state.desktop && status.reopenError) $('reopen-info').textContent += ' ' + boundedText(status.reopenError, 800); if(state.serverInstance !== (status.serverInstance || null)){deactivatePendingReconciler();historyCaps.unsupported.clear();pluginPanel.reset();configPanel.reset();resetUsage();prReviewPanel?.reset();resetRuntimePanel();dshLive.reset();remoteReset({statusMessage:'本地服务实例已变化，请重新读取远控状态。',pairMessage:'本地服务实例已变化，本机配对码显示已清除；不会撤销旧环境设备。',devicesMessage:'本地服务实例已变化，旧设备显示已清除；不会撤销旧环境设备。'});}state.serverInstance = status.serverInstance || null; state.demo = !!status.demo; setConnected(status.connected, status.demo ? '演示模式 · 不调用模型' : undefined); if(state.desktop){await loadDesktopState();preferencesView.syncHostTheme();} $('mode-info').textContent = status.demo ? '演示模式，不消耗额度' : '本地 Codex app-server';
  applyThreadSessions(status.threadSessions); state.requests.clear(); for (const request of status.pendingRequests || []) state.requests.set(String(request.id), request); renderRequests();
  if (status.demo) notice('当前是演示模式：仅测试界面和协议，不会调用真实模型。'); return status;
}
async function events() {
  let delay = 1000; let reconnected = false;
  while (!state.shuttingDown) {
    let reader; const controller = new AbortController(); state.eventController = controller;
    try {
      const response = await fetch('/api/events', { signal: controller.signal, headers: { Authorization: `Bearer ${token}` } }); if (!response.ok) throw new Error(`事件连接失败 (${response.status})`);
      reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; await syncStatus(); delay = 1000;
      if (reconnected && state.thread) { const current = state.thread; await openThread(current); } reconnected = true;
      while (true) {
        const { value, done } = await reader.read(); if (done) throw new Error('事件连接已关闭'); buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 8 * 1024 * 1024) throw new Error('事件超过界面缓冲限制');
        let split; while ((split = buffer.indexOf('\n\n')) >= 0) { const raw = buffer.slice(0, split); buffer = buffer.slice(split + 2); const data = raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n'); if (data) { try { onEvent(JSON.parse(data)); } catch (e) { notice('无法处理事件：' + e.message, true); } } }
      }
    } catch (e) { setConnected(false); if (!state.shuttingDown) activity('连接已断开，正在重连。不会自动重发消息。'); }
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
  uploadPasted(named(batch.images), named(batch.files));
});
async function uploadPasted(images, files) {
  const generation = state.openGeneration;
  if (images.length) await uploadChosenImages(images);
  if (files.length) await uploadChosenFiles(files);
  // The draft belongs to the composer, not a thread; switching threads keeps it, matching the file picker.
  if (generation !== state.openGeneration && (images.length || files.length)) notice('已在切换对话后完成附件准备；附件仍在当前输入框中，尚未发送。');
}
$('file-attachment-input').addEventListener('change',async()=>{const files=[...$('file-attachment-input').files];$('file-attachment-input').value='';if(files.length) await uploadChosenFiles(files);});
$('add-attachment').addEventListener('click', () => $('attachment-input').click());
$('attachment-input').addEventListener('change', async () => { const files = [...$('attachment-input').files]; $('attachment-input').value = ''; if (files.length) await uploadChosenImages(files); });
window.addEventListener('beforeunload', () => { for (const url of attachmentPreviews.values()) URL.revokeObjectURL(url); });
$('compose').addEventListener('submit', e => { e.preventDefault(); send(); });
$('queue-send').addEventListener('click', () => queueDraft());
$('prompt').addEventListener('input', () => { autosizePrompt(); updateControls(); slashMenu.update(); });
$('prompt').addEventListener('click', () => slashMenu.update());
$('prompt').addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== $('prompt')) slashMenu.close(); }, 0));
$('prompt').addEventListener('keydown', onPromptKey);
$('context-meter').addEventListener('click', () => notice($('context-meter').title));
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
$('new-thread').addEventListener('click', newThread); $('settings').addEventListener('click', () => openSettings('general')); $('cwd-button').addEventListener('click', openProjectDialog);
function saveSettings(e) { e.preventDefault(); selectProject({path:$('cwd-input').value.trim()}); }
$('refresh').addEventListener('click', () => {loadProjects();loadThreads().catch(e => notice(e.message, true));}); $('more-threads').addEventListener('click', () => loadThreads(true).catch(e => notice(e.message, true)));
$('earlier').addEventListener('click', async () => { $('earlier').disabled = true; try { await loadItems(true); } catch (e) { notice(e.message, true); } finally { $('earlier').disabled = false; } });
$('shutdown').addEventListener('click', async () => { if (!confirm(state.desktop ? '停止本窗口的 Codex app-server？Codex 任务可能中断，独立 DSH 任务可能继续。再次启动会重新连接官方历史，不会无缝恢复当前连接。' : '停止 GUI 本地服务？通过此 GUI 运行的任务可能会中断，独立 DSH 任务可能继续。')) return; state.shuttingDown = true; try { const result = await api('/api/shutdown', {}); if (result?.engineStopped !== true || result?.shutdownAccepted !== true) throw new Error('服务未确认引擎已停止，状态未知；请稍后检查连接状态。'); state.eventController?.abort(); setConnected(false, 'GUI 服务已停止'); activity(state.desktop ? '已停止服务。请关闭本窗口后重新启动应用；新连接会读取官方历史。' : '已停止服务。重新运行启动器即可打开。'); closeSettings(); } catch (e) { state.shuttingDown = false; notice(e.message, true); } });
$('model').addEventListener('change', () => populateEfforts(true)); $('dismiss-notice').addEventListener('click', () => { $('notice').classList.add('hidden'); $('settings-notice').classList.add('hidden'); });
$('rail-sidebar').addEventListener('click', () => sidebarController.toggle()); $('sidebar-overlay').addEventListener('click', () => sidebarController.close()); for(const id of ['close-sidebar','settings-sidebar-close']) $(id).addEventListener('click', () => sidebarController.close());
function showDetails(tab, force = false) {
  if (currentRoute !== 'chat') route('chat');
  const sameOpen = !$('details').classList.contains('hidden') && state.detailsTab === tab;
  const visible = force || !sameOpen; state.detailsTab = tab;
  $('details').classList.toggle('hidden', !visible); $('toggle-details').setAttribute('aria-pressed', String(visible && tab === 'tools'));
  $('open-dsh').setAttribute('aria-pressed', String(visible && tab === 'dsh'));
  $('tools-panel').classList.toggle('hidden', tab !== 'tools'); $('dsh-panel').classList.toggle('hidden', tab !== 'dsh');
  $('details-title').textContent = tab === 'dsh' ? 'DSH 任务' : '工具活动';
  for (const name of ['tools', 'dsh']) { $('tab-' + name).classList.toggle('active', name === tab); $('tab-' + name).setAttribute('aria-pressed', String(name === tab)); }
  syncDshLiveContext();
  if (visible) { if (tab === 'dsh') { renderDshConnection(); renderDshTasks(); } else renderTools(); }
}
$('toggle-details').addEventListener('click', () => showDetails('tools')); $('open-dsh').addEventListener('click', () => showDetails('dsh'));
$('tab-tools').addEventListener('click', () => showDetails('tools', true)); $('tab-dsh').addEventListener('click', () => showDetails('dsh', true));
$('close-details').addEventListener('click', () => { $('details').classList.add('hidden'); $('toggle-details').setAttribute('aria-pressed', 'false'); $('open-dsh').setAttribute('aria-pressed', 'false'); syncDshLiveContext(); });
$('refresh-dsh').addEventListener('click', refreshDsh); $('refresh-dsh-settings').addEventListener('click', refreshDsh);
for (const button of document.querySelectorAll('[data-prompt]')) button.addEventListener('click', () => { $('prompt').value = button.dataset.prompt; $('prompt').focus(); updateControls(); });
let searchTimer; $('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadThreads().catch(e => notice(e.message, true)), 250); });
document.addEventListener('keydown', e => { if ($('rename-dialog').open || $('project-dialog').open) { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') e.preventDefault(); return; } if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); newThread(); } if (e.key === 'Escape') { if (!$('thread-menu').classList.contains('hidden')) { closeThreadMenu(true); return; } if (activeMenu) { const previousMenu = activeMenu; closeWindowMenu(); const trigger=$('menu-' + previousMenu);if(trigger.getClientRects().length)trigger.focus();else if(!$('settings-dialog').classList.contains('hidden'))$('settings-back').focus();else $('prompt').focus();return; } if(sidebarController.isOverlayOpen()){sidebarController.close();return;} if(liveChanges.isOpen()){liveChanges.close();return;} if(currentRoute!=='chat'&&!e.defaultPrevented&&!document.activeElement?.closest?.('dialog,.reasoning-popover,#queue'))route('chat'); } });
function openInlineCwd(){openProjectDialog();}
function saveInlineCwd(){selectProject({path:$('cwd-inline-input').value.trim()});}
$('cwd-inline-save').addEventListener('click',saveInlineCwd);$('cwd-inline-input').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();saveInlineCwd();}});$('cwd-inline-cancel').addEventListener('click',()=>{$('cwd-setup').classList.add('hidden');$('prompt').focus();});
$('send-state-action').addEventListener('click',async()=>{const action=$('send-state-action').dataset.action;if(action==='cwd')openInlineCwd();else if(action==='pending'){$('pending-submissions').scrollIntoView({block:'nearest'});$('pending-submissions').querySelector('button')?.focus();}else if(action==='stop')$('stop').click();else if(action==='reconnect'){try{await syncStatus();connectionBootstrap.retry();sessionDefaults.retry();updateControls();}catch(error){notice('连接检查失败：'+error.message+'。没有重新发送消息。',true);}}});
$('settings-form').addEventListener('submit', saveSettings);
$('settings-back').addEventListener('click', closeSettings); $('settings-cancel').addEventListener('click', closeSettings);
$('rail-plugins').addEventListener('click',()=>openSettings('plugins'));
$('rail-home').addEventListener('click', () => route('chat')); $('rail-settings').addEventListener('click', () => openSettings('general')); $('rail-dsh').addEventListener('click', () => showDetails('dsh', true));
$('rail-usage').addEventListener('click', () => route('usage')); $('rail-account').addEventListener('click', () => route('account'));
let activeMenu = null;
function closeWindowMenu() { $('window-menu').classList.add('hidden'); for (const id of ['menu-file','menu-view','menu-app']) $(id).setAttribute('aria-expanded', 'false'); activeMenu = null; }
function openWindowMenu(name) {
  if (activeMenu === name) { closeWindowMenu(); return; }
  closeWindowMenu(); activeMenu = name; const menu = $('window-menu'); menu.dataset.menu = name;
  const entries = name === 'app' ? [['新对话',newThread],['打开项目…',openProjectDialog],['用量与性能',()=>route('usage')],['账户',()=>route('account')],['终端与 Git',showTerminal],['代码审查',showReview],['工具活动',()=>showDetails('tools',true)],['DSH 子代理',()=>showDetails('dsh',true)],['设置',()=>openSettings('general')],['帮助',()=>$('menu-help').click()]] : name === 'file' ? [['新对话', newThread], ['打开项目…', openProjectDialog], ['设置…', () => openSettings('general')]] : [['对话', () => route('chat')], ['用量与性能', () => route('usage')], ['账户', () => route('account')], ['终端与 Git', showTerminal], ['工具活动', () => showDetails('tools', true)], ['DSH 子代理', () => showDetails('dsh', true)], ['设置', () => openSettings('general')]];
  const fragment = document.createDocumentFragment();
  for (const [label, action] of entries) { const item = el('button', '', label); item.setAttribute('role', 'menuitem'); item.addEventListener('click', () => { closeWindowMenu(); action(); }); fragment.append(item); }
  fragment.append(el('small', '', '本地客户端菜单')); menu.replaceChildren(fragment); menu.classList.remove('hidden'); if(name==='app'){const rect=$('menu-app').getBoundingClientRect();menu.style.left=Math.max(8,Math.min(rect.left,innerWidth-240))+'px';menu.style.top=(rect.bottom+6)+'px';}else{menu.style.left='52px';menu.style.top='8px';} $('menu-' + name).setAttribute('aria-expanded', 'true'); menu.querySelector('button')?.focus();
}
$('menu-app').addEventListener('click',()=>openWindowMenu('app'));
$('menu-file').addEventListener('click', () => openWindowMenu('file')); $('menu-view').addEventListener('click', () => openWindowMenu('view'));
document.addEventListener('click', e => { if (!$('window-menu').contains(e.target) && !e.target.closest('#menu-file,#menu-view,#menu-app')) closeWindowMenu(); });
$('window-menu').addEventListener('keydown', e => { const buttons = [...$('window-menu').querySelectorAll('button')]; if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const n = buttons.indexOf(document.activeElement); buttons[(n + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus(); } });
$('menu-help').addEventListener('click', () => notice('Codex Light 支持本地聊天、历史、审批与 DSH 任务展示，通过本机 Codex CLI 工作。设置仅显示当前可用功能。'));
$('permissions-info').addEventListener('click', () => notice('新对话继承 Codex 当前有效的批准策略与沙箱配置，不再覆盖为固定值；已有对话沿用线程设置。本界面不会自动批准收到的请求。配置页可显式读取当前默认值。'));
$('settings-search').addEventListener('input', () => { const query = $('settings-search').value.trim().toLowerCase(); for (const item of document.querySelectorAll('.settings-nav-item')) item.classList.toggle('hidden', !item.textContent.toLowerCase().includes(query)); });
for (const button of document.querySelectorAll('[data-settings-section]')) button.addEventListener('click', () => {const wasOverlay=sidebarController.isOverlayOpen();selectSettingsSection(button.dataset.settingsSection);if(wasOverlay){sidebarController.closeForNavigation();$('settings-back').focus();}});
function selectSettingsSection(section = 'general') {
  if(section==='account'||section==='usage'){route(section);return;}
  const page = section === 'dsh' ? 'general' : (section === 'lan' && state.lan) ? 'general' : ['general','archived','remote','plugins','appearance','notifications','shortcuts','configuration','lan'].includes(section) ? section : 'general'; state.settingsPage = page;
  for (const name of ['general','archived','remote','plugins','appearance','notifications','shortcuts','configuration','lan']) $('settings-' + name).classList.toggle('hidden', name !== page);
  for (const item of document.querySelectorAll('[data-settings-section]')) item.classList.toggle('active', item.dataset.settingsSection === section);
  document.querySelector('.settings-content').scrollTop = 0;
  if (section === 'dsh') $('settings-dsh-heading').scrollIntoView({ behavior: 'instant', block: 'start' });
  if (page === 'general' && !state.lan) { dshConnectionView.activate(); dshConfigView.activate(); } else { dshConnectionView.deactivate(); dshConfigView.deactivate(); }
  if (page === 'archived') loadArchived().catch(e => notice(e.message, true));
  if(page==='plugins')pluginPanel.activate();else pluginPanel.deactivate();renderPluginPending();
  if(page==='lan')lanView.activate();else lanView.deactivate();
  if (page === 'remote'){if(state.connected)refreshRemote();else remoteReset({statusMessage:'尚未连接 Codex，无法读取远控状态。',pairMessage:'尚未连接，本机配对码显示已清除；不会撤销已配对设备。',devicesMessage:'未连接时设备列表不可用；不会撤销旧环境设备。'});}
  syncRuntimePanelActivity();
}
function rowsNode(rows) {
  const list = el('dl', 'status-rows'); for (const [label, value] of rows) list.append(el('dt', '', label), el('dd', '', value)); return list;
}
document.addEventListener('visibilitychange',()=>{remoteView.expireIfNeeded();syncDshLiveContext();syncPendingReconciler();syncRuntimePanelActivity();});
const workbench = createWorkbench({ document, state, $, el, api, notice, confirm: text => confirm(text), performMutation, scopedPending, pendingMutations, pendingReconcileErrors, eventSubscribers, showTerminal, openSettings });
const { terminalControls, showWorkspaceTab, renderGitPending } = workbench;
$('rail-terminal').addEventListener('click',showTerminal);$('terminal-back').addEventListener('click',closeSettings);
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
function canManageThread() { return !state.sending && !state.loadingThread && !state.busy && !pendingMutations.storageError && threadPendingRecords().length===0 && state.connected && !!state.thread; }
function closeThreadMenu(restoreFocus = false) { $('thread-menu').classList.add('hidden'); $('thread-menu-button').setAttribute('aria-expanded', 'false'); if (restoreFocus) $('thread-menu-button').focus(); }
function openRename() {
  closeThreadMenu(); if (!canManageThread()) return;
  state.renameTarget = { id: state.thread.id, name: state.thread.name || state.thread.preview || '' }; $('rename-input').value = state.renameTarget.name.slice(0,200); $('rename-dialog').showModal(); $('rename-input').focus(); $('rename-input').select();
}
async function renameThread(event) {
  event.preventDefault(); if (!state.renameTarget || state.sending || threadPendingRecords(state.renameTarget.id).length) return;
  const name = $('rename-input').value.trim(); if (!name) { $('rename-input').setCustomValidity('请输入名称'); $('rename-input').reportValidity(); return; } $('rename-input').setCustomValidity('');
  const target = state.renameTarget; state.sending = true; $('rename-save').disabled = true; $('rename-input').disabled = true; updateControls();
  try {
    await performMutation('thread/name/set', {threadId:target.id,name}); if (state.thread?.id === target.id) { state.thread.name = name; $('thread-title').textContent = name; }
    $('rename-dialog').close(); await loadThreads(); notice('对话名称已更新。');
  } catch (e) { $('rename-dialog').close(); showMutationFailure(e, '重命名'); }
  finally { state.sending = false; $('rename-save').disabled = false; $('rename-input').disabled = false; state.renameTarget = null; updateControls(); }
}
async function archiveCurrentThread() {
  closeThreadMenu(); if (!canManageThread()) return;
  const target = state.thread; if (!confirm(`将“${target.name || target.preview || '此对话'}”移入归档吗？可以从设置 → 已归档聊天恢复；不会删除项目文件。`)) return;
  state.sending = true; updateControls();
  try { await performMutation('thread/archive', {threadId:target.id}); state.sending = false; if (state.thread?.id === target.id) newThread(); await loadThreads(); notice('对话已归档，可在设置中恢复。'); }
  catch (e) { showMutationFailure(e, '归档'); }
  finally { state.sending = false; updateControls(); }
}
async function restoreArchived(thread) {
  if (state.sending || threadPendingRecords(thread.id).length) { notice('此对话的状态仍在自动同步，请稍后再试。'); return; }
  state.sending = true; updateControls(); renderArchived();
  try { await performMutation('thread/unarchive', {threadId:thread.id}); state.archivedThreads = state.archivedThreads.filter(row => row.id !== thread.id); await Promise.all([loadArchived(),loadThreads()]); notice('对话已恢复到最近列表。'); }
  catch (e) { showMutationFailure(e, '恢复归档'); }
  finally { state.sending = false; updateControls(); renderArchived(); }
}
async function forkCurrentThread() {
  closeThreadMenu(); if (!canManageThread()) return; const target = state.thread; const generation = state.openGeneration;
  state.sending = true; updateControls();
  try { const result = await performMutation('thread/fork', {threadId:target.id,excludeTurns:true}); await loadThreads(); if (generation === state.openGeneration && result.thread?.id) await openThread(result.thread); notice('对话分支已创建，没有发送模型请求。'); }
  catch (e) { showMutationFailure(e, '创建分支'); }
  finally { state.sending = false; updateControls(); }
}
async function reviewLocalChanges() {
  closeThreadMenu(); if (!canManageThread()) return; const target = state.thread; const generation = state.openGeneration;
  const message = state.demo ? '运行演示审查？演示模式不会调用真实模型，也不会修改文件。' : `审查当前项目的本地未提交改动？\n目录：${target.cwd || state.cwd}\n这会调用 Codex 模型并消耗你的推理额度。本界面不会自动提交、合并或发布改动。`;
  if (!confirm(message)) return; state.sending = true; updateControls(); activity('正在提交审查请求…');
  try {
    const result = await performMutation('review/start', {threadId:target.id,target:{type:'uncommittedChanges'},delivery:'inline'});
    if (generation === state.openGeneration) { state.turnId = result.turn?.id; state.busy = !!state.turnId && !state.terminalTurns.has(state.turnId) && !['completed','interrupted','failed'].includes(result.turn?.status); if (!state.busy) state.turnId = null; else state.ledger.activate(state.turnId, Date.now()); activity(''); renderMessages(); }
  } catch (e) { showMutationFailure(e, '审查请求'); }
  finally { state.sending = false; updateControls(); }
}
$('thread-menu-button').addEventListener('click', () => { if ($('thread-menu').classList.contains('hidden')) { closeWindowMenu(); $('thread-menu').classList.remove('hidden'); $('thread-menu-button').setAttribute('aria-expanded','true'); $('rename-thread').focus(); } else closeThreadMenu(true); });
$('rename-thread').addEventListener('click',openRename); $('fork-thread').addEventListener('click',forkCurrentThread); $('archive-thread').addEventListener('click',archiveCurrentThread); $('review-thread').addEventListener('click',showReview);
$('rename-form').addEventListener('submit',renameThread); $('rename-input').addEventListener('input',()=>$('rename-input').setCustomValidity(''));
for (const id of ['rename-close','rename-cancel']) $(id).addEventListener('click',()=>{if(!state.sending)$('rename-dialog').close();});
$('rename-dialog').addEventListener('cancel',event=>{if(state.sending)event.preventDefault();});
$('rename-dialog').addEventListener('close',()=>{if(!state.sending)state.renameTarget=null;});
document.addEventListener('click',event=>{if(!$('thread-menu').contains(event.target)&&event.target.id!=='thread-menu-button')closeThreadMenu();});
$('thread-menu').addEventListener('keydown',event=>{if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();const buttons=[...$('thread-menu').querySelectorAll('button')],n=buttons.indexOf(document.activeElement);buttons[(n+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}});

$('review-back').addEventListener('click',closeSettings);$('review-local-action').addEventListener('click',()=>{if(!state.thread){notice('先选择已有对话，再请求使用该会话的 Codex 模型审查本地改动。');closeSettings();return;}closeSettings();reviewLocalChanges();});
$('refresh-archived').addEventListener('click',()=>loadArchived()); $('more-archived').addEventListener('click',()=>loadArchived(true));
const preferencesView = createPreferences({ document, window, state, $, el, api, notice, confirm: text => confirm(text) });
const { loadDesktopState } = preferencesView;
applyAccessMode(access.lan);
watchKeyboard(window, document.documentElement);
// Keep the caret visible when the phone keyboard opens.
$('prompt').addEventListener('focus', () => { if (matchMedia('(pointer:coarse)').matches) setTimeout(() => $('compose').scrollIntoView({ block: 'end' }), 250); });
async function init() {
  renderPendingMutations(); renderAttachments(); renderReasoning(); remoteControls(); updateControls();
  try {
    const config = await api('/api/config'); await loadProjects({restore:!state.cwd&&!config.cwd}); setCwd(state.cwd || config.cwd); $('command-info').textContent = config.codexCommand || 'codex'; let status = await syncStatus();
    events();
    if(!status.connected)activity('正在等待 Codex 连接，连接成功后会自动加载模型与历史。');
  } catch (e) { setConnected(false); notice(e.message, true); activity('未发送任何模型请求'); }
}
init();
