import {createStatisticsRecovery} from './statistics-recovery.mjs';
import {NativeStorageMaintenance} from './native-storage-maintenance.mjs';
import {StorageOperationReservation} from './storage-operation-reservation.mjs';
import {DshWakeup} from './dsh-wakeup.mjs';
import {WslNativeDshBridge} from './dsh-wsl-native.mjs';
import {WslWindowsDshBridge} from './dsh-wsl-windows.mjs';
import {StorageMaintenance} from './storage-maintenance.mjs';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {ConfigSettingsService} from './config-settings.mjs';
import {createSkillsManagement} from './skills-management.mjs';
import {createSkillImporter} from './skill-import.mjs';
import {EngineOnboarding,EngineSetupStore} from './engine-onboarding.mjs';
import {DesktopState} from './desktop-state.mjs';
import {ProjectStore} from './projects.mjs';
import {projectPathKey} from '../public/projects.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {GitCommandActions} from './git-command-actions.mjs';
import {nativeCodex,resolveCodexRuntime,probeCodexVersion,parseCodexVersion} from './runtime-path.mjs';
import {WslRuntime,WslSelectionStore,validateWslSelection,wslProfileId,wslPathToHost,hostPathToWsl,mapWslRequest,mapWslResponse} from './wsl-runtime.mjs';
import {RuntimeManager,windowsRuntimeOccupied} from './runtime-manager.mjs';
import {RuntimeAutomation,RuntimeAutomationStore} from './runtime-automation.mjs';
import {AppUpdateService} from './app-update.mjs';
import {startUpdateChecks} from '../public/ui/auto-update.js';
import {assertUpdateIdle,UpdateReservation} from './app-update-safety.mjs';
import {PluginActionService} from './plugin-actions.mjs';
import {FileAttachmentStore,FILE_ATTACHMENT_REFERENCE_PREFIX} from './file-attachments.mjs';
import {AccountLoginService} from './account-login.mjs';
import {scanLocalCodexUsage,discoverLocalCodexUsageDirectories} from './local-usage-scan.mjs';
import {defaultRolloutRoots,readInlineHistoryContext} from './inline-history.mjs';
import {contextSnapshot} from '../public/context-usage.js';
import {PricingService} from './pricing.mjs';
import {TitleSummaryService} from './title-summary.mjs';
import {StatisticsService,defaultStatisticsRoot} from './statistics.mjs';
import {ArtifactPreviewService} from './artifacts.mjs';
import {FilePreviewService} from './file-preview.mjs';
import {LanAccess} from './lan-access.mjs';
import {LanPreferenceStore,windowsNetworkIdentity,windowsNetworkSnapshot} from './lan-preferences.mjs';
import {loadRemoteHostId} from './remote-host-identity.mjs';
import {SshRelay} from './ssh-relay.mjs';
import {GitService} from './git.mjs';
import {TerminalService} from './terminal.mjs';
import { RpcClient } from './rpc.mjs';
import {validServerRequestId,findServerRequest} from './server-requests.mjs';
import {ThreadSessions} from './thread-sessions.mjs';
import {ThreadReads} from './thread-reads.mjs';
import {MobileNotificationFeed} from './mobile-notification-feed.mjs';
import {ThreadListService} from './thread-list.mjs';
import { DemoClient } from './demo.mjs';
import { validateRpc, validateResponse } from './security.mjs';
import { OperationStore, MUTATING_METHODS } from './operations.mjs';
import { UploadStore } from './uploads.mjs';
import { DshReadService } from './dsh-read.mjs';
import {DshConfigSourcesService} from './dsh-config-sources.mjs';
import {DshConnectionService} from './dsh-connection.mjs';
import {PrReviewService} from './pr-review.mjs';
import {SessionDefaultsService} from './session-defaults.mjs';
import {SessionPermissions,validPermissionMode} from './session-permissions.mjs';
import {accountIdentityKey} from '../public/account-identity.js';
import {REMOTE_METHODS,validateRemote} from './remote.mjs';
import { createReopener } from './reopen.mjs';

const sharedAccountMethods=new Set(['account/read','account/usage/read','account/rateLimits/read','account/updated','account/rateLimits/updated']);
function localManagement(method) {
 return typeof method==='string'&&(method.startsWith('remoteControl/')||method==='bridge/accountLogin'
  ||(method.startsWith('account/')&&!sharedAccountMethods.has(method)));
}
function requireLocalManagement(access) {
 if(access!=='local')throw Object.assign(new Error('账号和设备管理请在电脑上操作'),{status:403,code:'LOCAL_ONLY',outcome:'notExecuted'});
}
const publicDir=fileURLToPath(new URL('../public/',import.meta.url));
const publicFiles={'/config-settings-panel.js':'config-settings-panel.js','/preferences.js':'preferences.js','/plugin-actions-panel.js':'plugin-actions-panel.js','/account-login-panel.js':'account-login-panel.js','/local-usage-panel.js':'local-usage-panel.js','/usage-statistics.js':'usage-statistics.js','/token-pricing.js':'token-pricing.js','/plugins.js':'plugins.js','/plugins.css':'plugins.css','/pr-review-panel.js':'pr-review-panel.js','/terminal.js':'terminal.js','/vendor/xterm.mjs':'vendor/xterm.mjs','/vendor/addon-fit.mjs':'vendor/addon-fit.mjs','/vendor/xterm.css':'vendor/xterm.css','/approval-schemas.js':'approval-schemas.js','/':'index.html','/index.html':'index.html','/app.js':'app.js','/styles.css':'styles.css','/style.css':'style.css','/store.js':'store.js','/dsh.js':'dsh.js','/dsh-live.js':'dsh-live.js','/runtime-panel.js':'runtime-panel.js','/markdown.js':'markdown.js','/submissions.js':'submissions.js','/attachments.js':'attachments.js','/account.js':'account.js','/reasoning.js':'reasoning.js','/remote.js':'remote.js','/icons.js':'icons.js','/state.js':'state.js','/icon.svg':'icon.svg'};
publicFiles['/code-format.js']='code-format.js';
publicFiles['/vendor/qrcode.js']='vendor/qrcode.js';publicFiles['/ui/pairing.js']='ui/pairing.js';publicFiles['/ui/back-navigation.js']='ui/back-navigation.js';publicFiles['/ui/auto-update.js']='ui/auto-update.js';publicFiles['/ui/welcome-greeting.js']='ui/welcome-greeting.js';
publicFiles['/ui/update-indicator.js']='ui/update-indicator.js';
publicFiles['/ui/desktop-close-preference.js']='ui/desktop-close-preference.js';
publicFiles['/ui/navigation-history.js']='ui/navigation-history.js';publicFiles['/ui/shell-polish.css']='ui/shell-polish.css';
publicFiles['/ui/thread-completion.js']='ui/thread-completion.js';publicFiles['/ui/mobile-layout.js']='ui/mobile-layout.js';
publicFiles['/ui/task-notifications.js']='ui/task-notifications.js';
publicFiles['/ui/task-phase.js']='ui/task-phase.js';
publicFiles['/ui/question-notifications.js']='ui/question-notifications.js';
publicFiles['/ui/skills-view.js']='ui/skills-view.js';
publicFiles['/context-usage.js']='context-usage.js';
publicFiles['/ui/context-details.js']='ui/context-details.js';
publicFiles['/ui/conversation-scroll.js']='ui/conversation-scroll.js';
publicFiles['/ui/offline-snapshot.js']='ui/offline-snapshot.js';
publicFiles['/ui/file-preview.js']='ui/file-preview.js';publicFiles['/ui/file-preview.css']='ui/file-preview.css';
const types={'.mjs':'text/javascript; charset=utf-8','.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
publicFiles['/session-controls.js']='session-controls.js';publicFiles['/session-controls.css']='session-controls.css';
publicFiles['/ui/agent-inspector.js']='ui/agent-inspector.js';
publicFiles['/account-quota.js']='account-quota.js';publicFiles['/ui/account-view.css']='ui/account-view.css';
publicFiles['/delegated-changes.js']='delegated-changes.js';publicFiles['/agent-changes.js']='agent-changes.js';publicFiles['/ui/tool-activity.js']='ui/tool-activity.js';
publicFiles['/change-stats.js']='change-stats.js';
publicFiles['/delegation-monitor.js']='delegation-monitor.js';
publicFiles['/agent-history.js']='agent-history.js';
publicFiles['/wsl-runtime-panel.js']='wsl-runtime-panel.js';
publicFiles['/reasoning-timing.js']='reasoning-timing.js';
publicFiles['/async-answer.js']='async-answer.js';
publicFiles['/ui/async-input.js']='ui/async-input.js';
publicFiles['/ui/agent-avatar.js']='ui/agent-avatar.js';
publicFiles['/account-identity.js']='account-identity.js';
publicFiles['/ui/title-settings.js']='ui/title-settings.js';
publicFiles['/ui/settings-search.js']='ui/settings-search.js';
publicFiles['/ui/update-indicator.js']='ui/update-indicator.js';
publicFiles['/ui/optimistic-messages.js']='ui/optimistic-messages.js';
for(const file of ['about-view.js','about-view.css','notifications.js'])publicFiles['/ui/'+file]='ui/'+file;
publicFiles['/ui/storage-view.js']='ui/storage-view.js';
publicFiles['/ui/panel-resize.js']='ui/panel-resize.js';publicFiles['/ui/panel-resize.css']='ui/panel-resize.css';publicFiles['/project-name-dialog.js']='project-name-dialog.js';
for(const file of ['history-auto-load.js','format.js','chart.js','stats-view.js','account-view.js','live-changes.js','views.css','paste.js','artifacts.js','agents.js','access.js','lan-view.js','tunnel-view.js','access-pairing-view.js','viewport.js','approvals-view.js','composer.js','dsh-view.js','preferences-view.js','remote-view.js','slash-menu.js','workbench-view.js','dsh-config-view.js','dsh-connection-view.js'])publicFiles['/ui/'+file]='ui/'+file;
for(const file of ['app-confirm-dialog.js','lan-confirm-dialog.js','history-viewport.js','engine-onboarding.js','engine-onboarding.css','activity-feed.js','activity-feed.css','projects.js','project-navigation.js','project-navigation.css'])publicFiles['/'+file]=file;
async function body(req){let data='';for await(const chunk of req){data+=chunk;if(data.length>512*1024)throw new Error('请求太大');}try{return JSON.parse(data||'{}');}catch{throw new Error('无效 JSON');}}
export async function createServer({client,cwd='',command='codex',demo=false,port=0,reopen=false,desktop=false,desktopUpdateTransport='msi',onDesktopTheme,onDesktopPickFolder,onDesktopLaunchInstaller,desktopStateRoot,nativeStorage,storageMaintenance,storageRoot,projectStore,projectsRoot,fileAttachmentRoot,token=randomBytes(32).toString('hex'),prReviewService,runtimeManager,appUpdateService,contextHistoryReader=readInlineHistoryContext,statisticsRoot,lanOptions,dshConfigSourcesService,dshConnectionService,wslRuntimeService,wslSelectionStore:providedWslSelectionStore,engineNativeCandidate}={}){
 let runtimeSource='configured',wslCandidate=null,wslLaunch=null,runtimeStartupError=null;
 const wslRuntime=wslRuntimeService||new WslRuntime();
 const wslSelectionStore=providedWslSelectionStore||new WslSelectionStore(desktopStateRoot?{root:desktopStateRoot}:{});
 const runtimeAutomation=desktop&&!demo&&!client&&process.platform==='win32'?new RuntimeAutomation({store:new RuntimeAutomationStore(wslSelectionStore.root)}):null;
 if(runtimeAutomation){
  runtimeAutomation.explicit=!!process.env.CODEX_LIGHT_CODEX||!!command&&!['codex','codex.exe'].includes(command);
  await runtimeAutomation.load();
 }
 const detectSetupNative=engineNativeCandidate||(async()=>{let candidate;try{candidate=resolveCodexRuntime();}catch(error){if(error.code==='CODEX_NOT_FOUND')return null;throw error;}const version=candidate[candidate.source]?.version||candidate.version||(candidate.source==='env'?probeCodexVersion(candidate.path):null);if(!version)throw new Error('Windows Codex exists but its version could not be verified');return {available:true,version,path:candidate.path,source:candidate.source};});
 const engineSetup=new EngineOnboarding({store:new EngineSetupStore(wslSelectionStore.root),supported:desktop&&!demo&&wslRuntime.platform==='win32',nativeCandidate:detectSetupNative,listDistributions:()=>wslRuntime.distributions(),discoverRunning:typeof wslRuntime.discoverRunning==='function'?()=>wslRuntime.discoverRunning():null,probeDistribution:distribution=>wslRuntime.probe({distribution}),saveSelection:async selection=>{if(selection.target==='native'&&!(await detectSetupNative())?.available)throw new Error('Windows runtime is no longer available');return saveRuntimeSelection(selection);},current:()=>wslCurrent,busy:()=>runtime.upgrading||sessions.queues.size>0||sessions.snapshot().threads.some(t=>t.state!=='idle')});
 await engineSetup.initialize();
 let wslSelection=null;
 if((!client||wslRuntimeService)&&!demo){
  try{
   if(wslRuntime.platform==='win32')wslSelection=await wslSelectionStore.read();
   if(wslSelection){wslCandidate=await wslRuntime.probe(wslSelection);wslPathToHost(wslCandidate.home,wslCandidate.distribution);wslPathToHost(wslCandidate.codexHome,wslCandidate.distribution);wslLaunch=wslRuntime.launch(wslCandidate);command=wslLaunch.command;runtimeSource='wsl';}
   else if(!client&&(!command||command==='codex'||command==='codex.exe')){const resolved=resolveCodexRuntime({preferredSource:runtimeAutomation?.state.source});command=resolved.path;runtimeSource=resolved.source;}
   else if(!client){command=nativeCodex({env:{...process.env,CODEX_LIGHT_CODEX:command}});runtimeSource='configured';}
  }catch(error){runtimeStartupError=error;wslCandidate=null;wslLaunch=null;}
 }else runtimeSource=demo?'demo':(client?'client':'configured');
 const wslActive=!!wslSelection;
 const runtimeProfile=wslActive?wslProfileId(wslCandidate||wslSelection):null;
 const runtimeDescriptor={kind:wslActive?'wsl':'native',distribution:wslSelection?.distribution||null};
 const wslCurrent=wslActive?{target:'wsl',distribution:wslSelection.distribution,user:wslCandidate?.user||wslSelection.user,...(wslSelection.codexPath?{codexPath:wslSelection.codexPath}:{})}:{target:'native'};
 const wslLimitations=['WSL 模式可读取所选发行版的 Git 状态和差异；暂存、提交和推送请在 WSL 终端操作。','DSH 必须显式选择所在环境；Windows DSH 仅支持 Windows 盘目录，自动唤醒仅投递到原父对话，失败时可通过 dsh_wait 获取结果。'];
 async function wslStatus(canSelect=true){const selected=wslRuntime.platform==='win32'&&!demo?await wslSelectionStore.read():null;const next=selected?{target:'wsl',...selected}:{target:'native'};return {supported:wslRuntime.platform==='win32'&&!demo,canSelect:canSelect&&wslRuntime.platform==='win32'&&!demo,current:wslCurrent,selected:next,restartRequired:JSON.stringify(next)!==JSON.stringify(wslCurrent),limitations:wslLimitations,...(wslActive?{engineVersion:parseCodexVersion(rpc.version)}:{})};}
 function assertEngineSelectionIdle(){if(runtime.upgrading||sessions.queues.size||sessions.snapshot().threads.some(t=>t.state!=='idle'))throw Object.assign(new Error('Finish active work before changing runtime'),{code:'RUNTIME_BUSY',outcome:'notExecuted'});}
 async function saveRuntimeSelection(selection){
  assertEngineSelectionIdle();
       if(!selection||Array.isArray(selection)||Object.keys(selection).some(key=>!['target','distribution','user','codexPath'].includes(key)))throw new Error('Invalid WSL selection');
       if(selection.target==='native'){if(Object.keys(selection).length!==1)throw new Error('Native selection accepts no WSL parameters');assertEngineSelectionIdle();await wslSelectionStore.save(null);}
       else if(selection.target==='wsl'){const candidate=await wslRuntime.probe(validateWslSelection({distribution:selection.distribution,...(selection.user!==undefined?{user:selection.user}:{}),...(selection.codexPath!==undefined?{codexPath:selection.codexPath}:{})}));if(!candidate.available)throw new Error('无法确定所选非交互环境中的 Linux Codex，请检查诊断或指定 Linux 绝对路径');assertEngineSelectionIdle();await wslSelectionStore.save({distribution:candidate.distribution,user:candidate.user,...(selection.codexPath?{codexPath:selection.codexPath}:{})});}
       else throw new Error('Unknown runtime target');
  return wslStatus();
 }
 const configuredStateRoot=desktopStateRoot||projectStore?.root||projectsRoot;
 if(runtimeProfile){
  const profileBase=path.join(wslSelectionStore.root,'wsl-profiles',runtimeProfile);
  statisticsRoot??=path.join(profileBase,'statistics');projectsRoot??=path.join(profileBase,'projects');fileAttachmentRoot??=path.join(profileBase,'attachments');
 }
 const temporaryState=desktop&&demo&&!desktopStateRoot?await mkdtemp(path.join(os.tmpdir(),'codex-light-demo-state-')):null;
 const desktopState=desktop?new DesktopState({root:desktopStateRoot||temporaryState||undefined}):null;
 const temporaryProjects=demo&&!projectStore?.root&&!projectsRoot?await mkdtemp(path.join(os.tmpdir(),'codex-light-demo-projects-')):null;
 const projects=projectStore||new ProjectStore({root:projectsRoot||temporaryProjects||undefined,...(wslCandidate?{wslDistribution:wslCandidate.distribution}:{})});
 const projectHistory=typeof projects.submitted==='function'?projects:new ProjectStore({root:projectsRoot||temporaryProjects||undefined});
 // The app's user data outlives an update and is shared by the Windows and WSL engines.
 const remoteDirectory=path.join(desktopState?.root||configuredStateRoot||(runtimeProfile?wslSelectionStore.root:projectHistory.root),'remote-access');
 let hostIdPromise;
 function hostId(){
  hostIdPromise??=loadRemoteHostId(remoteDirectory).catch(()=>{
   hostIdPromise=null;
   throw Object.assign(new Error('无法安全读取或保存此电脑的远控 ID，请检查用户数据目录。'),{code:'REMOTE_ID_UNAVAILABLE',status:503,outcome:'notExecuted'});
  });
  return hostIdPromise;
 }
 async function remoteIdentity(required){
  try{return {remoteHostId:await hostId(),remoteHostName:os.hostname()};}
  catch(error){if(required)throw error;return {remoteHostId:null,remoteHostName:os.hostname(),remoteIdentityWarning:error.message};}
 }
 const linuxProjectlessRoot=wslCandidate?path.posix.join(wslCandidate.home,'.local','share','codecang','projectless-threads'):null;
 const projectlessRoot=linuxProjectlessRoot?wslPathToHost(linuxProjectlessRoot,wslCandidate.distribution):path.join(projectHistory.root,'projectless-threads');
 const projectlessKey=projectPathKey(projectlessRoot)+'/';
 const isProjectless=cwd=>{const key=projectPathKey(cwd);return key.startsWith(projectlessKey)&&/^[a-f0-9]{32}$/.test(key.slice(projectlessKey.length));};
 const projectlessWslCommand=(...args)=>wslRuntime.invoke(['--distribution',wslCandidate.distribution,'--user',wslCandidate.user,'--exec',...args]);
 async function newProjectlessDirectory(){
  const id=randomBytes(16).toString('hex');
  if(!wslCandidate)return projectHistory.createProjectlessDirectory(id);
  const directory=path.posix.join(linuxProjectlessRoot,id);
  await projectlessWslCommand('/bin/mkdir','-p','-m','700','--',directory);
  return wslPathToHost(directory,wslCandidate.distribution);
 }
 async function withConversationMetadata(method,output){
  if(!output?.thread&&(method!=='thread/list'||!Array.isArray(output?.data)))return output;
  const submitted=await projectHistory.submitted().catch(()=>({}));
  const apply=thread=>{
   if(!thread?.id)return thread;
   const submittedAt=Object.hasOwn(submitted,thread.id)?submitted[thread.id]:null;
   return {...thread,...(isProjectless(thread.cwd)?{projectless:true}:{}),...(submittedAt?{submittedAt}:{})};
  };
  return output.thread?{...output,thread:apply(output.thread)}:{...output,data:output.data.map(apply)};
 }
 const rpc=client || (demo?new DemoClient():new RpcClient(wslLaunch?{...wslLaunch,mapRequest:params=>mapWslRequest(params,value=>wslRuntime.toLinux(value,wslCandidate)),mapResponse:value=>mapWslResponse(value,wslCandidate.distribution)}:{command,cwd:cwd||os.homedir()}));
 if(runtimeStartupError){rpc.connected=false;rpc.start=async()=>{throw runtimeStartupError;};}
 const sessions=new ThreadSessions(rpc,{onEvent:message=>broadcast(message),onThreadLoaded:result=>statistics.thread(result?.thread,result)});
 const threadReads=new ThreadReads();
 const mobileNotifications=new MobileNotificationFeed();
 const threadList=new ThreadListService(rpc);
 const artifacts=new ArtifactPreviewService({projects,...(wslCandidate?{wslDistribution:wslCandidate.distribution,rolloutRoots:['sessions','archived_sessions'].map(part=>wslPathToHost(wslCandidate.codexHome+'/'+part,wslCandidate.distribution))}:{})});
 const files=new FilePreviewService({projects,...(wslCandidate?{wslDistribution:wslCandidate.distribution}:{})});
 const git=new GitService(wslCandidate?{run:(directory,args)=>wslRuntime.gitRead(directory,args,wslCandidate),validateDirectory:async directory=>{await wslRuntime.toLinux(directory,wslCandidate);await projects.directory(directory);}}:{});
 const gitActions=new GitCommandActions();
 const metadataRoot=statisticsRoot??(!demo&&!client?defaultStatisticsRoot():null);
 const sessionPermissions=new SessionPermissions(metadataRoot,runtimeProfile||['native',process.env.CODEX_HOME||os.homedir()]);
 let observedPermissionIdentity;
 async function permissionIdentity(){
  if(demo)return 'demo';
  if(!rpc.connected)throw new Error('Codex 尚未连接，无法读取对话批准方式。');
  if(observedPermissionIdentity!==undefined)return observedPermissionIdentity;
  const generation=accountIdentityGeneration;
  const result=await rpc.call('account/read',{refreshToken:false});
  if(generation!==accountIdentityGeneration||!rpc.connected)throw new Error('Codex 账户已变化，请重新读取对话批准方式。');
  return observedPermissionIdentity=accountIdentityKey(result);
 }
 const pricing=new PricingService({root:metadataRoot});await pricing.load();
 const statistics=new StatisticsService({pricing,root:metadataRoot});await statistics.load();
 const contextLive=new Map(),contextFiles=new Map(),contextReads=new Map();
 const contextRoots=wslActive?(wslCandidate?['sessions','archived_sessions'].map(dir=>wslPathToHost(wslCandidate.codexHome+'/'+dir,wslCandidate.distribution)):[]):defaultRolloutRoots();
 function rememberContext(map,id,value){map.delete(id);map.set(id,value);if(map.size>512)map.delete(map.keys().next().value);}
 async function readThreadContext(threadId){
  if(!contextFiles.has(threadId))return null;
  const live=contextLive.get(threadId);
  if(live)return live;
  if(contextReads.has(threadId))return contextReads.get(threadId);
  const generation=accountIdentityGeneration,wirePath=contextFiles.get(threadId);
  if(typeof wirePath!=='string'||contextReads.size>=4)return null;
  const reading=(async()=>{
   let saved=null;
   try{
    const rollout=wslCandidate?wslPathToHost(hostPathToWsl(wirePath,wslCandidate.distribution),wslCandidate.distribution):wirePath;
    saved=await contextHistoryReader({rollout,threadId,roots:contextRoots,caseSensitive:wslActive});
   }catch{/* An unavailable source leaves the thread's context metrics unknown. */}
   if(generation!==accountIdentityGeneration||contextFiles.get(threadId)!==wirePath)return null;
   return contextLive.get(threadId)||saved;
  })();
  contextReads.set(threadId,reading);
  try{return await reading;}finally{if(contextReads.get(threadId)===reading)contextReads.delete(threadId);}
 }
 const titleSummary=new TitleSummaryService(rpc,{root:metadataRoot,demo,...(wslCandidate?{
  codexHome:wslCandidate.codexHome,scratchRoot:wslPathToHost('/tmp',wslCandidate.distribution),toHost:value=>wslPathToHost(value,wslCandidate.distribution),
 }:{ }),onEvent:message=>broadcast(message)});await titleSummary.load();
 let accountIdentityGeneration=0,accountIdentityPending=null;
 function clearStatisticsAccount(){accountIdentityGeneration++;statistics.setAccount(null);accountIdentityPending=null;observedPermissionIdentity=undefined;sessionPermissions.resetAnonymous();contextLive.clear();contextFiles.clear();contextReads.clear();}
 async function readStatisticsAccount(){
  if(demo||!rpc.connected)return;
  if(accountIdentityPending)return accountIdentityPending;
  const generation=accountIdentityGeneration;
  const task=(async()=>{try{const result=await rpc.call('account/read',{refreshToken:false});if(generation===accountIdentityGeneration)statistics.setAccount(result);}catch{if(generation===accountIdentityGeneration)statistics.setAccount(null);}})();
  accountIdentityPending=task;try{await task;}finally{if(accountIdentityPending===task)accountIdentityPending=null;}
 }
 let usageScan=null,usageScanPromise=null,usageScanDirectory=null,publishLocalScan=false,modelRecovery=createStatisticsRecovery(),modelRecoveryError=null,dshResetError=null;
 function importUsageDirectory(directory,{recoveryOnly=false}={}){
  if(wslActive){
   if(!wslCandidate)throw new Error('WSL environment is unavailable');
   const linux=hostPathToWsl(directory,wslCandidate.distribution),relative=path.posix.relative(wslCandidate.codexHome,linux);
   if(relative==='..'||relative.startsWith('../')||path.posix.isAbsolute(relative))throw new Error('Select history inside the active WSL Codex home');
   directory=wslPathToHost(linux,wslCandidate.distribution);
  }
  if(usageScanPromise){
   const exact=wslActive||process.platform!=='win32';
   if(exact?path.resolve(directory)===path.resolve(usageScanDirectory):path.resolve(directory).toLowerCase()===path.resolve(usageScanDirectory).toLowerCase()){
    if(!recoveryOnly)publishLocalScan=true;
    return usageScanPromise;
   }
   if(!recoveryOnly&&!publishLocalScan)return usageScanPromise.catch(()=>{}).then(()=>{
    if(stopping)throw new Error('应用正在关闭。');
    return importUsageDirectory(directory);
   });
   throw new Error('已有其他目录的扫描正在进行');
  }
  const controller=new AbortController();usageScan=controller;usageScanDirectory=directory;publishLocalScan=!recoveryOnly;
  const timeout=setTimeout(()=>controller.abort(),60000);
  usageScanPromise=(async()=>{
   const scan=await scanLocalCodexUsage(directory,{signal:controller.signal,cacheRoot:metadataRoot});
   if(controller.signal.aborted)throw new Error('扫描已取消，请重试');
   if(!scan.filesRead&&(scan.partial||scan.candidates))throw new Error(scan.diagnosticCounts?.['access-denied']?'无法读取 Codex 日志目录':scan.diagnosticCounts?.cancelled?'扫描已取消，请重试':'目录中没有可读取的 Codex 日志');
   const {recovered}=statistics.importLocal(scan,{publishLocal:publishLocalScan});modelRecoveryError=null;
   if(recovered.updatedRows||recovered.tokenRows)broadcast({method:'bridge/statisticsRecovered',params:{}},{localOnly:true});
   return scan;
  })().finally(()=>{clearTimeout(timeout);usageScan=null;usageScanPromise=null;usageScanDirectory=null;});
  return usageScanPromise;
 }
 const terminal=new TerminalService(rpc,wslActive?{shellCommand:['/bin/sh']}:{});
 const accountLogin=new AccountLoginService(rpc);
 const pluginActions=new PluginActionService({rpc});
 const configSettings=new ConfigSettingsService({rpc});
 const skillsManagement=createSkillsManagement(rpc,{wsl:wslActive});
 const skillImporter=desktop&&!demo&&!wslActive&&typeof onDesktopPickFolder==='function'?createSkillImporter({chooseFolder:onDesktopPickFolder}):null;
 const sessionDefaults=new SessionDefaultsService({rpc,demo});
 const dshConfigSources=dshConfigSourcesService||new DshConfigSourcesService({demo});
 let dshWakeup=null,dshWakeupError=null;
 if(wslCandidate&&!demo){try{dshWakeup=new DshWakeup({root:path.join(wslSelectionStore.root,'wsl-profiles',runtimeProfile,'callbacks'),targetIdentity:runtimeProfile,rpc,sessions,onEvent:broadcast,beforeSend:()=>{if(stopping||engineStopped)throw Object.assign(new Error('Application is stopping'),{code:'CLIENT_CLOSING',outcome:'notExecuted'});updateReservation.assertOpen();if(storage.running)throw Object.assign(new Error('Storage maintenance is active'),{code:'STORAGE_BUSY',outcome:'notExecuted'});if(runtime.upgrading)throw Object.assign(new Error('Runtime upgrade is active'),{code:'RUNTIME_BUSY',outcome:'notExecuted'});}});}catch{dshWakeupError='Automatic DSH wakeup could not initialize; use dsh_wait until callback state is repaired.';}}
 const dshConnection=dshConnectionService||new DshConnectionService({rpc,demo,callbackStatus:()=>dshWakeup?{...dshWakeup.status(),...(dshWakeupError?{error:dshWakeupError}:{})}:null,...(wslCandidate?{bundles:{'native-wsl':new WslNativeDshBridge({candidate:wslCandidate,runtime:wslRuntime,queueDescriptor:dshWakeup?.descriptorPath}),windows:new WslWindowsDshBridge({candidate:wslCandidate,wsl:wslRuntime,queueDescriptor:dshWakeup?.descriptorPath})}}:{})});
 const requestTokens=new WeakMap();
 function availableRequests(access){return [...rpc.requests].filter(([,request])=>access==='local'||!localManagement(request.method));}
 function presentRequest(request){let bridgeRequestToken=requestTokens.get(request);if(!bridgeRequestToken){bridgeRequestToken=randomBytes(24).toString('hex');requestTokens.set(request,bridgeRequestToken);}return {...request,bridgeRequestToken};}
 const prReview=prReviewService||new PrReviewService();
 const fileUploads=new FileAttachmentStore(fileAttachmentRoot?{root:fileAttachmentRoot}:{});
 const loginTimers=new Set();
 const appVersion=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;
 const updateReservation=new UpdateReservation();
 const storageReservation=new StorageOperationReservation();
 const appUpdates=appUpdateService||new AppUpdateService({currentVersion:appVersion,updateTransport:desktop?desktopUpdateTransport:'msi',...(desktop?{launchFn:async(file,metadata)=>{
  if(typeof onDesktopLaunchInstaller!=='function')throw Object.assign(new Error('当前桌面宿主不支持启动应用安装程序'),{outcome:'notExecuted',code:'APP_UPDATE_HOST_UNAVAILABLE'});
  return onDesktopLaunchInstaller(file,metadata);
 }}:{})});
 const dsh=new DshReadService(rpc);const uploads=new UploadStore();const streams=new Map();const operations=new OperationStore({hooks:desktopState?{before:r=>desktopState.before(r),after:r=>desktopState.after(r)}:undefined});const runtime=runtimeManager||new RuntimeManager({currentPath:runtimeStartupError?'':command,currentSource:runtimeSource,operations,rpc,...(process.platform==='win32'&&!client?{occupancy:windowsRuntimeOccupied}:{})});let origin;let stopping=false;let closing;let serviceShutdown;let shutdownError=null;let engineStopped=false;let reopener;let reopenError=null;let remoteEnvironment=null;const remoteClients=new Set();let remotePairing=null;let pairingTimer;let stopAutomaticUpdates;
 if(runtimeAutomation)runtimeAutomation.emit=()=>broadcast({method:'bridge/runtimeUpdate',params:runtimeAutomation.snapshot()},{localOnly:true});
 let automaticStartup;
 function runtimeView(status){
  if(!runtimeAutomation)return status;
  return {...status,automatic:{...runtimeAutomation.snapshot(),explicit:runtimeAutomation.explicit},startupError:runtimeStartupError?.message||null};
 }
 function clearPairing(){clearTimeout(pairingTimer);remotePairing=null;for(const entry of operations.entries.values())if(entry.method==='remoteControl/pairing/start'&&entry.result){delete entry.result.pairingCode;delete entry.result.manualPairingCode;entry.result.expired=true;}}
 const storage=storageMaintenance||new NativeStorageMaintenance({native:nativeStorage,reservation:storageReservation,root:storageRoot||(process.platform==='win32'&&process.env.LOCALAPPDATA?path.join(process.env.LOCALAPPDATA,'CodexLight'):null),activeProfile:process.env.CODEX_LIGHT_ACTIVE_WEBVIEW_PROFILE||null,imageFiles:()=>uploads.storageFiles?.()||[...uploads.records.values()].map(r=>({path:r.path,size:r.size,ownedTemp:true,cleanupEligible:false})),imageLease:fn=>uploads.withMaintenance?uploads.withMaintenance(fn):fn(),busy:()=>!!(uploads.reserved||uploads.writes?.size||appUpdates.downloading||appUpdates.installing||sessions.queues.size||rpc.requests.size||sessions.snapshot().threads.some(t=>t.state!=='idle')||[...terminal.sessions.values()].some(t=>!['exited','error','disconnected'].includes(t.state))||[...dsh.threads.values()].some(t=>[...t.tasks.values()].some(x=>!['completed','failed','cancelled','canceled','interrupted','context_exhausted'].includes(String(x.status).toLowerCase()))))});
 const json=(res,status,data)=>{if(res.destroyed || res.writableEnded)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
 const handle=async(req,res,context)=>{
  const requestOrigin=context?.origin??origin,requestToken=context?.token??token,requestAccess=context?.access==='lan'?'lan':'local',requestDesktop=desktop&&requestAccess==='local';
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
  const styleNonce=randomBytes(24).toString('base64');
  res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${styleNonce}'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
  if(req.headers.host!==new URL(requestOrigin).host || (req.headers.origin && req.headers.origin!==requestOrigin)){json(res,403,{error:'拒绝外部来源'});return;}
  let url;try{url=new URL(req.url,requestOrigin);}catch{json(res,400,{error:'无效请求地址'});return;}
  if(url.origin!==requestOrigin){json(res,403,{error:'拒绝外部来源'});return;}
  if(url.pathname==='/health' && req.method==='GET'){json(res,200,{app:'codex-light',serverInstance:operations.serverInstance,pid:process.pid});return;}
  if(url.pathname.startsWith('/api/')){
   const auth=req.headers.authorization||'';const expected=`Bearer ${requestToken}`;
   if(Buffer.byteLength(auth)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(auth),Buffer.from(expected))){json(res,401,{error:'访问凭据已失效，请重新启动 GUI'});return;}
   try{
    if(wslActive&&(url.pathname.startsWith('/api/dsh/config-sources/')||url.pathname.startsWith('/api/git/')&&url.pathname!=='/api/git/read')){json(res,409,{error:url.pathname.startsWith('/api/git/')?'WSL 模式暂不提供 Git 写操作；可读取状态和差异，暂存、提交和推送请在 WSL 终端操作。':'WSL 模式暂不支持编辑 Windows DSH 配置来源；可在 DSH 连接中选择 Windows DSH。',code:'WSL_UNSUPPORTED',outcome:'notExecuted'});return;}
    if(wslActive&&!wslCandidate&&url.pathname==='/api/git/read')throw Object.assign(new Error('所选 WSL 运行环境不可用，请恢复连接后读取 Git。'),{code:'WSL_RUNTIME_UNAVAILABLE',status:409,outcome:'notExecuted'});
    if(['/api/dsh/config-sources/','/api/dsh/connection/'].some(prefix=>url.pathname.startsWith(prefix))&&requestAccess!=='local'){json(res,403,{error:'DSH 配置和连接管理仅限本机',code:'LOCAL_ONLY',outcome:'notExecuted'});return;}
    if(url.pathname.startsWith('/api/storage/')&&requestAccess!=='local'){json(res,403,{error:'存储清理仅限本机，远程设备不能清理宿主数据',code:'LOCAL_ONLY',outcome:'notExecuted'});return;}
    if(storage.running&&req.method==='POST')throw Object.assign(new Error('本机存储维护中，请稍后再试'),{code:'STORAGE_BUSY',status:409,outcome:'notExecuted'});
    if(url.pathname.startsWith('/api/app-update/')&&requestAccess!=='local'){json(res,403,{error:'应用更新仅限本机操作',code:'LOCAL_ONLY',outcome:'notExecuted'});return;}
    if(desktopUpdateTransport==='velopack'&&req.method==='POST'&&!['/api/app-update/status','/api/shutdown'].includes(url.pathname))updateReservation.assertOpen();
    if(stopping&&req.method==='POST'&&url.pathname!=='/api/shutdown')throw Object.assign(new Error('Light 正在关闭，此请求未发送'),{code:'CLIENT_CLOSING',outcome:'notExecuted',status:409});
    if(url.pathname==='/api/events' && req.method==='GET'){
     res.writeHead(200,{'Content-Type':'text/event-stream','Connection':'keep-alive'});res.write(': connected\n\n');streams.set(res,requestAccess);
     res.write(`data: ${JSON.stringify({method:'bridge/threadReads',params:threadReads.snapshot()})}\n\n`);
     const heartbeat=setInterval(()=>{if(res.writableLength>4*1024*1024)res.destroy();else res.write(': keepalive\n\n');},15000);
     req.on('close',()=>{streams.delete(res);clearInterval(heartbeat);});return;
    }
    if(url.pathname==='/api/mobile/notification-state'){
     if(requestAccess!=='lan'){json(res,403,{error:'仅配对设备可读取手机通知状态',code:'LAN_ONLY'});return;}
     if(req.method!=='GET'){res.setHeader('Allow','GET');json(res,405,{error:'不支持的操作'});return;}
     json(res,200,mobileNotifications.snapshot({connected:rpc.connected===true&&!stopping,serverInstance:operations.serverInstance,threads:sessions.snapshot().threads,requests:new Map(availableRequests(requestAccess).map(([id,request])=>[id,presentRequest(request)]))}));return;
    }
    if(url.pathname==='/api/status' && req.method==='GET'){
     const identity=await remoteIdentity(requestAccess!=='local');
     if(identity.remoteHostId)res.setHeader('X-CodeCang-Remote-Host-Id',identity.remoteHostId);
     json(res,200,{...identity,connected:rpc.connected,runtimeTarget:wslActive?'wsl':'native',runtimeUnsupported:wslActive?['gitWrite','dshConfigSources','runtimeUpgrade',...(!wslCandidate?['dshConnection','gitRead']:[])]:[],demo,desktop:requestDesktop,access:requestAccess,canImportSkill:requestDesktop&&!!skillImporter,stopping,engineStopped,shutdownError,threadSessions:sessions.snapshot(),persistenceWarning:operations.persistenceWarning||desktopState?.persistenceWarning||null,version:rpc.version||null,error:rpc.lastError||null,dshError:dsh.releaseError||dshResetError,dshWakeup:dshWakeup?.status()||{automaticWakeup:false,error:dshWakeupError},pendingRequests:availableRequests(requestAccess).map(([,request])=>presentRequest(request)),serverInstance:operations.serverInstance,operationRetentionMs:operations.retentionMs,reopenAvailable:requestAccess==='local'&&!!reopener,reopenError:requestAccess==='local'?reopenError:null,...(requestDesktop?{appUpdate:{...appUpdates.status(),demo}}:{})});return;
    }
    if(url.pathname==='/api/lan/tunnel/status'&&req.method==='GET'){
     if(requestAccess!=='local')throw Object.assign(new Error('此操作仅限本机窗口'),{status:403});
     json(res,200,await tunnelStatus());return;
    }
    if(url.pathname==='/api/operations' && req.method==='GET'){
     const operation=operations.get(url.searchParams.get('requestId'));
     if(localManagement(operation.method)||/^(?:app-update|runtime)\//.test(operation.method))requireLocalManagement(requestAccess);
     json(res,200,operation);return;
    }
    if(url.pathname==='/api/config' && req.method==='GET'){json(res,200,{cwd,codexCommand:command});return;}
    if(url.pathname==='/api/projects'&&req.method==='GET'){json(res,200,{...await projects.list(),canPickFolder:requestDesktop&&typeof onDesktopPickFolder==='function'});return;}
    if(url.pathname==='/api/desktop/preferences'&&req.method==='GET'){if(!desktopState)throw new Error('仅桌面模式支持本机状态');json(res,200,{preferences:await desktopState.preferences()});return;}
    if(url.pathname==='/api/desktop/receipts'&&req.method==='GET'){if(!desktopState)throw new Error('仅桌面模式支持本机状态');json(res,200,{receipts:await desktopState.list(),persistenceWarning:operations.persistenceWarning||desktopState.persistenceWarning});return;}
    if(req.method!=='POST'){json(res,405,{error:'不支持的操作'});return;}
    if(url.pathname==='/api/thread-reads'){
     if(requestAccess!=='lan'){json(res,403,{error:'仅配对设备可上报对话已读',code:'LAN_ONLY'});return;}
     const reads=threadReads.read(await body(req));
     if(reads)broadcast({method:'bridge/threadReads',params:reads});
     json(res,200,{});return;
    }
    if(url.pathname.startsWith('/api/dsh/connection/')){
     const action=url.pathname.slice('/api/dsh/connection/'.length),input=await body(req);
     if(action!=='modelReminder'&&wslActive&&!wslCandidate)throw Object.assign(new Error('The selected WSL runtime is unavailable; reconnect it before configuring DSH.'),{code:'WSL_RUNTIME_UNAVAILABLE',status:409,outcome:'notExecuted'});
     if(!['status','plan','connect','testConnection','modelStatus','saveModel','modelReminder'].includes(action))throw Object.assign(new Error('未知 DSH 连接操作'),{code:'INVALID_INPUT',status:400});
     const result=await dshConnection[action](input);
     if(action==='status'&&!demo&&!result.selectionRequired&&dshConnection.modelStatus)result.modelStatusAvailable=true;
     json(res,200,result);return;
    }
    if(url.pathname.startsWith('/api/dsh/config-sources/')){
     const action=url.pathname.slice('/api/dsh/config-sources/'.length),input=await body(req);
     json(res,200,action==='status'?dshConfigSources.status(input):await dshConfigSources.execute(action,input));return;
    }
    if(url.pathname==='/api/desktop/theme'){
     if(!desktop||typeof onDesktopTheme!=='function'){json(res,409,{error:'当前窗口不支持原生主题同步'});return;}
     const value=await body(req);
     if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['theme','visualStyle'].includes(key))||!['light','dark'].includes(value.theme)||(Object.hasOwn(value,'visualStyle')&&!['codex','claude'].includes(value.visualStyle)))throw new Error('无效主题');
     if(Object.hasOwn(value,'visualStyle'))onDesktopTheme(value.theme,value.visualStyle);else onDesktopTheme(value.theme);
     json(res,200,{theme:value.theme,...(Object.hasOwn(value,'visualStyle')?{visualStyle:value.visualStyle}:{})});return;
    }
    if(url.pathname==='/api/file-uploads'){
     if(Number(req.headers['content-length'])>20*1024*1024)throw new Error('文件不能超过 20 MiB');
     const filename=decodeURIComponent(String(req.headers['x-filename']||''));const mime=String(req.headers['x-file-mime']||'application/octet-stream');
     const record=await fileUploads.add(req,{filename,mime});const {path:privatePath,...visible}=record;json(res,200,visible);return;
    }
    if(url.pathname==='/api/uploads'){
     const header=req.headers['x-filename'];const filename=header?decodeURIComponent(String(header)):'image';
     if(Number(req.headers['content-length'])>uploads.maxFile)throw new Error('单张图片不能超过 6 MiB');
     json(res,200,await uploads.add(req,{filename}));return;
    }
    const input=await body(req);
    if(desktopUpdateTransport==='velopack'&&!['/api/app-update/status','/api/shutdown'].includes(url.pathname))updateReservation.assertOpen();
    if(storage.running)throw Object.assign(new Error('本机存储维护中，请稍后再试'),{code:'STORAGE_BUSY',status:409,outcome:'notExecuted'});
    if(url.pathname.startsWith('/api/storage/')){
     const action=url.pathname.slice('/api/storage/'.length);
     const keys={scan:'',plan:'category',apply:'confirmed,id,manifestDigest',restore:'confirmed,recoveryId'};
     if(!Object.hasOwn(keys,action)||!input||typeof input!=='object'||Array.isArray(input)||(!(action==='plan'&&['category','category,mode'].includes(Object.keys(input).sort().join(',')))&&!(action==='apply'&&Object.keys(input).sort().join(',')==='confirmed,id,manifestDigest,msiConfirmed'&&typeof input.msiConfirmed==='boolean')&&Object.keys(input).sort().join(',')!==keys[action]))throw Object.assign(new Error('存储操作参数无效'),{code:'STORAGE_INVALID',status:400,outcome:'notExecuted'});
     if(demo&&action!=='scan')throw Object.assign(new Error('演示模式不能清理真实文件'),{code:'STORAGE_DEMO',status:409,outcome:'notExecuted'});
     json(res,200,await storage[action](input));return;
    }
    if(url.pathname.startsWith('/api/app-update/')){
     const action=url.pathname.slice('/api/app-update/'.length);
     if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('应用更新参数无效');
     if(action==='network-restored'&&requestDesktop&&stopAutomaticUpdates){
      if(Object.keys(input).length)throw new Error('应用更新参数无效');
      stopAutomaticUpdates.reconnect();json(res,200,{});return;
     }
     if(action==='status'||action==='check'){
      if(Object.keys(input).length)throw new Error('应用更新参数无效');
      const result=action==='status'?appUpdates.status():await appUpdates.check();json(res,200,{...result,demo});return;
     }
     if(!['download','install'].includes(action)){json(res,404,{error:'未知应用更新操作',outcome:'notExecuted'});return;}
     if(demo)throw Object.assign(new Error('演示模式不能下载或安装真实应用更新'),{code:'APP_UPDATE_DEMO',outcome:'notExecuted'});
     const keys=action==='download'?'requestId,version':'confirmed,requestId,version';
     if(Object.keys(input).sort().join(',')!==keys)throw Object.assign(new Error('应用更新参数无效'),{code:'APP_UPDATE_INPUT_INVALID',outcome:'notExecuted'});
     const {requestId,...params}=input;
     const runUpdate=()=>storageReservation.run('update',()=>appUpdates[action](params));
     const result=await operations.execute(requestId,'app-update/'+action,params,()=>action==='install'&&desktopUpdateTransport==='velopack'?updateReservation.run(()=>assertUpdateIdle({rpc,sessions,terminal,dsh,operations,runtime,requestId}),runUpdate):runUpdate());json(res,200,{...result,demo});return;
    }
    if(url.pathname.startsWith('/api/lan/')){
     if(requestAccess!=='local')throw Object.assign(new Error('此操作仅限本机窗口'),{status:403});
     const isTunnel=url.pathname.startsWith('/api/lan/tunnel/');
     const manager=isTunnel?tunnel:lan;
     const action=url.pathname.slice((isTunnel?'/api/lan/tunnel/':'/api/lan/').length);
     if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('远程访问参数无效');
     if(isTunnel){
      if(action==='enable'){json(res,200,await queueTunnel(()=>tunnel.enable(input)));return;}
      if(Object.keys(input).length)throw new Error('公网入口操作参数无效');
      if(action==='status'){json(res,200,await tunnelStatus());return;}
      if(action==='ssh/prepare'){
       const result=await queueTunnel(async()=>{
        const endpoint=tunnel.status();
        if(!endpoint.enabled)throw Object.assign(new Error('请先开启这台电脑的公网入口。'),{status:409});
        const id=await hostId();
        if(stopping||!tunnel.status().enabled)throw Object.assign(new Error('公网入口已关闭。'),{status:409});
        sshRelay??=new SshRelay({keyDir:path.join(remoteDirectory,'ssh')});
        return sshRelay.prepare({publicOrigin:endpoint.origin,port:endpoint.port,hostId:id,verifyRelayProof:(nonce,proof)=>tunnel.verifyRelayProof(nonce,proof)});
       });
       json(res,200,result);return;
      }
      if(action==='ssh/stop'){await queueTunnel(()=>sshRelay?.stop());json(res,200,relayStatus());return;}
      if(action==='disable'){json(res,200,await queueTunnel(()=>tunnel.disable()));return;}
     }
     if(action==='enable'){json(res,200,await manager.enable(input));return;}
     if(action==='pairing'&&!isTunnel){json(res,200,await lan.pairing(input));return;}
     const allowed=['status','disable','rotate','pairing','cancelPairing'];
     if(!isTunnel)allowed.push('restore');
     if(!allowed.includes(action)||Object.keys(input).length)throw new Error('远程访问操作参数无效');
     json(res,200,await manager[action]());return;
    }
    if(url.pathname==='/api/desktop/pick-folder'){
     if(!desktop||typeof onDesktopPickFolder!=='function'){json(res,409,{error:'当前窗口不支持原生文件夹选择'});return;}
     if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)throw new Error('文件夹选择参数无效');
     const selected=await onDesktopPickFolder();
     if(selected!==null&&(typeof selected!=='string'||selected.length>4096||selected.includes('\0')||!path.isAbsolute(selected)))throw new Error('原生文件夹选择返回了无效路径');
     json(res,200,{path:selected});return;
    }
    if(url.pathname==='/api/projects/open'){
     if(requestAccess!=='local')throw Object.assign(new Error('在资源管理器中打开仅限本机'),{status:403});
     if(process.platform!=='win32')throw new Error('当前系统不支持 Windows 资源管理器');
     if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).join(',')!=='id'||typeof input.id!=='string')throw new Error('项目参数无效');
     const snapshot=await projects.list(),project=snapshot.projects.find(item=>item.id===input.id);if(!project)throw new Error('找不到该项目，请刷新项目列表。');
     const directory=await projects.directory(project.path);
     if(!path.win32.isAbsolute(directory)||directory.startsWith('/')||directory.startsWith('-'))throw new Error('项目文件夹路径无效');
     await new Promise((resolve,reject)=>{const child=spawn(path.join(process.env.SystemRoot||'C:\\Windows','explorer.exe'),[directory],{shell:false,windowsHide:true,stdio:'ignore'});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});});
     json(res,200,{opened:true});return;
    }
    if(url.pathname==='/api/projects/update'){
     if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.id!=='string'||Object.keys(input).some(key=>!['id','name','pinned'].includes(key)))throw new Error('项目参数无效');
     const {id,...changes}=input;const {submissions,...snapshot}=await projects.updateMetadata(id,changes);json(res,200,snapshot);return;
    }
    if(['/api/projects/add','/api/projects/select','/api/projects/remove'].includes(url.pathname)){
     const action=url.pathname.slice('/api/projects/'.length),field=action==='add'?'path':'id';
     if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>key!==field&&(action!=='add'||key!=='recent'))||
        (typeof input[field]!=='string'&&(action!=='select'||input[field]!==null))||(input.recent!==undefined&&typeof input.recent!=='boolean'))throw new Error('项目参数无效');
     if(action==='add'&&isProjectless(input.path))throw new Error('无项目对话的专用目录不能添加为项目。');
     const {submissions,...snapshot}=await projects[action](input[field],input.recent);json(res,200,snapshot);return;
    }
    if(url.pathname==='/api/session/defaults'){
     json(res,200,await sessionDefaults.read(input));return;
    }
    if(url.pathname==='/api/thread/context'){
     if(!input||Object.keys(input).join(',')!=='threadId'||typeof input.threadId!=='string'||!input.threadId||input.threadId.length>256||/[\x00-\x20\x7f]/.test(input.threadId))throw new Error('上下文用量参数无效');
     json(res,200,{snapshot:await readThreadContext(input.threadId)});return;
    }
    if(url.pathname==='/api/session/permission'){
     const keys=Object.keys(input||{}).sort().join(',');
     if(!['threadId','mode,scope,threadId'].includes(keys))throw new Error('对话批准方式参数无效');
     const identity=await permissionIdentity();
     const writing=keys!=='threadId';
     const saved=await sessionPermissions.access(identity,input.threadId,writing?input:null);
     if(writing)broadcast({method:'bridge/sessionPermissionChanged',params:{threadId:input.threadId,scope:saved.scope}});
     json(res,200,saved);return;
    }
    if(url.pathname.startsWith('/api/pr/')){
     if(demo)throw new Error('演示模式不读取真实 GitHub 数据，也不调用 GitHub CLI');
     if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('PR 参数无效');
     const action=url.pathname.slice('/api/pr/'.length);
     const allow=fields=>{for(const key of Object.keys(input))if(!fields.includes(key))throw new Error(`不支持参数 ${key}`);};
     const pick=fields=>Object.fromEntries(fields.filter(key=>Object.hasOwn(input,key)).map(key=>[key,input[key]]));
     if(action==='status'){allow([]);json(res,200,await prReview.status());return;}
     if(action==='list'){allow(['filter','state','page','repository']);json(res,200,await prReview.list(pick(['filter','state','page','repository'])));return;}
     if(action==='detail'){allow(['url']);if(typeof input.url!=='string')throw new Error('PR 链接参数无效');json(res,200,await prReview.detail({url:input.url}));return;}
     if(action==='section'){allow(['url','kind','page']);if(typeof input.url!=='string'||typeof input.kind!=='string')throw new Error('PR 内容参数无效');json(res,200,await prReview.section(pick(['url','kind','page'])));return;}
     throw new Error('未知 PR 操作');
    }
    if(url.pathname==='/api/desktop/preferences'){
     if(!desktopState||!input||Object.keys(input).join(',')!=='preferences')throw new Error('本机偏好参数无效');
     json(res,200,{preferences:await desktopState.preferences(input.preferences)});return;
    }
    if(url.pathname==='/api/desktop/receipts/ack'){
     if(!desktopState||!input||Object.keys(input).sort().join(',')!=='confirmed,requestIds'||input.confirmed!==true)throw new Error('需明确确认具体待核对记录');
     if(input.requestIds?.some(id=>operations.entries.get(id)?.state==='pending'))throw new Error('操作仍在执行，不能移除记录');
     await desktopState.ack(input.requestIds);for(const id of input.requestIds){const entry=operations.entries.get(id);if(entry)delete entry.persistenceWarning;}if(![...operations.entries.values()].some(entry=>entry.persistenceWarning)){operations.persistenceWarning=null;desktopState.persistenceWarning=null;}json(res,200,{acknowledged:input.requestIds});return;
    }
    if(url.pathname.startsWith('/api/skills/import/')){
     if(!requestDesktop)throw Object.assign(new Error('技能导入仅限本机桌面'),{status:403,outcome:'notExecuted'});
     if(!skillImporter)throw Object.assign(new Error(wslActive?'WSL 引擎暂不支持从 Windows 文件夹导入技能':'当前窗口不支持导入技能'),{status:409,outcome:'notExecuted'});
     if(!rpc.connected)throw Object.assign(new Error('请先连接 Codex 引擎'),{status:409,outcome:'notExecuted'});
     if(url.pathname==='/api/skills/import/pick'){
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)throw Object.assign(new Error('技能选择参数无效'),{status:400,outcome:'notExecuted'});
      json(res,200,await skillImporter.pick());return;
     }
     if(url.pathname==='/api/skills/import/install'){
      const result=await skillImporter.install(input);
      broadcast({method:'skills/changed',params:{}});
      json(res,200,result);return;
     }
     json(res,404,{error:'未知的技能导入操作',outcome:'notExecuted'});return;
    }
    if(url.pathname==='/api/skills/list'){
     json(res,200,await skillsManagement.list(input));return;
    }
    if(url.pathname==='/api/skills/set-enabled'){
     const {requestId,...params}=input;
     const result=await operations.execute(requestId,'skills/config/write',params,async()=>{
      const saved=await skillsManagement.setEnabled(params);
      broadcast({method:'skills/changed',params:{}});
      return saved;
     });
     json(res,200,result);return;
    }
    if(url.pathname.startsWith('/api/config-settings/')){
     if(demo)throw new Error('演示模式不读取或更改真实配置');if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('配置参数无效');
     const action=url.pathname.slice('/api/config-settings/'.length);
     if(action==='read'){if(Object.keys(input).some(k=>k!=='cwd'))throw new Error('配置读取参数无效');json(res,200,await configSettings.read(input));return;}
     if(action==='plan'){if(Object.keys(input).some(k=>k!=='edits'))throw new Error('配置计划参数无效');json(res,200,configSettings.plan(input.edits));return;}
     if(action==='apply'){const {requestId,...params}=input;json(res,200,await operations.execute(requestId,'config/apply',params,()=>configSettings.apply(params)));return;}
     throw new Error('未知配置操作');
    }
    if(url.pathname==='/api/plugins/status'){
     if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||typeof input.handle!=='string'||!/^[a-f0-9-]{36}$/i.test(input.handle))throw new Error('插件状态核对参数无效');
     if(demo)throw new Error('演示模式不读取真实插件状态');
     json(res,200,await pluginActions.checkStatus(input.handle,{allowToggle:requestAccess==='local'}));return;
    }
    if(url.pathname==='/api/plugins/plan'){
     if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['handle','action'].includes(k)))throw new Error('插件计划参数无效');
     if(demo)throw new Error('演示模式不安装真实插件');json(res,200,await pluginActions.plan(input.handle,input.action,{allowToggle:requestAccess==='local'}));return;
    }
    if(url.pathname==='/api/plugins/apply'){
     if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('插件参数无效');if(demo)throw new Error('演示模式不修改真实插件');
     const {requestId,...params}=input;json(res,200,await operations.execute(requestId,'plugin/apply',params,()=>pluginActions.apply(params,{allowToggle:requestAccess==='local'})));return;
    }
    if(url.pathname.startsWith('/api/account/')){
     requireLocalManagement(requestAccess);
     const action=url.pathname.slice('/api/account/'.length);if(!['start','cancel','logout','snapshot'].includes(action))throw new Error('未知账号操作');
     if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('账号参数无效');if(demo)throw new Error('演示模式不更改真实账号');
     if(action==='snapshot'){if(Object.keys(input).length)throw new Error('账号参数无效');json(res,200,accountLogin.snapshot());return;}
     const {requestId,...params}=input;const result=await operations.execute(requestId,`account/${action}`,params,()=>accountLogin[action](params));
     if(action==='start'){
      const scrub=()=>{const entry=operations.entries.get(requestId);if(entry?.result){delete entry.result.authUrl;delete entry.result.verificationUrl;delete entry.result.userCode;entry.result.redacted=true;}};
      if(accountLogin.snapshot().state!=='waiting')scrub();else{const timer=setTimeout(()=>{scrub();loginTimers.delete(timer);},600000);timer.unref();loginTimers.add(timer);}
     }json(res,200,result);return;
    }
    if(url.pathname==='/api/files/preview'){json(res,200,await files.preview(input));return;}
    if(url.pathname==='/api/files/download'){
     const file=await files.download(input);
     if(res.destroyed||res.writableEnded)return;
     const name=encodeURIComponent(file.name).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16));
     res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':file.bytes.length,'Content-Disposition':"attachment; filename=\"download\"; filename*=UTF-8''"+name});
     res.end(file.bytes);return;
    }
    if(url.pathname==='/api/artifacts/preview'){
     const image=await artifacts.preview(input);
     if(res.destroyed||res.writableEnded)return;
     if(requestAccess==='local'&&image.localPath){const header=encodeURIComponent(image.localPath);if(header.length<=7000)res.setHeader('X-Artifact-Local-Path',header);}
     res.setHeader('Content-Security-Policy',"sandbox; default-src 'none'; script-src 'none'; object-src 'none'; frame-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'");
     res.writeHead(200,{'Content-Type':image.mime,'Content-Length':image.bytes.length,'Content-Disposition':'attachment; filename="artifact.'+({'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif','image/vnd.microsoft.icon':'ico','image/svg+xml':'svg'})[image.mime]+'"','X-Artifact-Width':String(image.width),'X-Artifact-Height':String(image.height)});res.end(image.bytes);return;
    }
    if(url.pathname==='/api/statistics/query'){
     // Account RPC must not stall local usage rendering while the engine is slow.
     await Promise.race([readStatisticsAccount(),new Promise(resolve=>{const timer=setTimeout(resolve,200);timer.unref?.();})]);
     const result=statistics.query(input);
     if(!demo&&!stopping&&requestAccess==='local'&&!input.cursor&&input.scope!=='local'&&(result.coverage?.unknownModelRows>0||result.coverage?.completeTokenRows<result.coverage?.observedTurns)){
      // Serve committed observations immediately. A completed reconciliation notifies the visible first page.
      void modelRecovery.run(async()=>{
       try{const found=await discoverLocalCodexUsageDirectories(wslCandidate?{env:{CODEX_HOME:wslPathToHost(wslCandidate.codexHome,wslCandidate.distribution)},home:wslPathToHost(wslCandidate.home,wslCandidate.distribution)}:wslActive?{env:{},home:''}:{});
       if(found.directory&&!stopping)await importUsageDirectory(found.directory,{recoveryOnly:true});modelRecoveryError=null;
       }catch(error){modelRecoveryError=error.message;}
      });
      if(modelRecoveryError)result.coverage.modelRecoveryError=modelRecoveryError;
     }
     json(res,200,result);return;
    }
    if(url.pathname==='/api/statistics/directories'){
     if(Object.keys(input).length)throw new Error('目录发现参数无效');
     if(requestAccess!=='local')throw Object.assign(new Error('本机日志目录仅限本机访问'),{status:403});
     json(res,200,demo?{directory:null,directories:[]}:await discoverLocalCodexUsageDirectories(wslCandidate?{env:{CODEX_HOME:wslPathToHost(wslCandidate.codexHome,wslCandidate.distribution)},home:wslPathToHost(wslCandidate.home,wslCandidate.distribution)}:wslActive?{env:{},home:''}:{}));return;
    }
    if(['/api/local-usage/scan','/api/statistics/import'].includes(url.pathname)){
     if(requestAccess!=='local')throw Object.assign(new Error('本机日志导入仅限本机操作'),{status:403});
     if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>k!=='directory')||typeof input.directory!=='string'||input.directory.length>4096)throw new Error('扫描目录参数无效');
     if(demo)throw new Error('演示模式不读取本机历史');
     const scan=await importUsageDirectory(input.directory);
     json(res,200,url.pathname==='/api/statistics/import'?{imported:true,scan:{filesRead:scan.filesRead,bytesRead:scan.bytesRead,diskBytesRead:scan.diskBytesRead,cacheHits:scan.cacheHits,partial:scan.partial,diagnosticCounts:scan.diagnosticCounts},statistics:statistics.query({scope:'local'})}:scan);return;
    }
    if(url.pathname==='/api/pricing/ensure'){if(Object.keys(input).length)throw new Error('价格参数无效');json(res,200,demo?pricing.status():await pricing.ensureFresh());return;}
    if(url.pathname==='/api/pricing/status'){if(Object.keys(input).length)throw new Error('价格参数无效');json(res,200,pricing.status());return;}
    if(url.pathname==='/api/pricing/refresh'){if(Object.keys(input).length)throw new Error('价格参数无效');if(demo)throw new Error('演示模式不请求真实价格服务');json(res,200,await pricing.refresh());return;}
    if(url.pathname==='/api/pricing/model'){if(Object.keys(input).some(k=>!['model','provider'].includes(k)))throw new Error('价格参数无效');json(res,200,{...pricing.get(input.model,input.provider),candidates:pricing.candidates(input.model)});return;}
    if(url.pathname==='/api/pricing/configure'){json(res,200,await pricing.configure(input));return;}
    if(url.pathname.startsWith('/api/title-summary/')){
     if(requestAccess!=='local')throw Object.assign(new Error('标题设置仅限本机访问'),{status:403});
     const action=url.pathname.slice('/api/title-summary/'.length);
     if(['status','models'].includes(action)&&Object.keys(input).length)throw new Error('标题设置参数无效');
     if(action==='test')json(res,200,await titleSummary.testModel(input));
     else if(action==='configure')json(res,200,await titleSummary.configure(input));
     else if(action==='models')json(res,200,await titleSummary.models());
     else if(action==='status')json(res,200,titleSummary.status());
     else throw new Error('未知标题设置操作');
     return;
    }
    if(url.pathname.startsWith('/api/runtime/onboarding/')){
     if(requestAccess!=='local'||!requestDesktop)throw Object.assign(new Error('Engine setup is local desktop only'),{status:403,code:'LOCAL_ONLY'});
     if(!engineSetup.supported)throw new Error('Engine setup is unavailable');
     const action=url.pathname.slice('/api/runtime/onboarding/'.length);
     if(action!=='complete'&&Object.keys(input).length)throw new Error('Invalid engine setup parameters');
     if(action==='status'){json(res,200,await engineSetup.inventory());return;}
     if(action==='discover'){json(res,200,await engineSetup.discover());return;}
     if(action==='complete'){json(res,200,await engineSetup.complete(input));return;}
     throw new Error('Unknown engine setup action');
    }
    if(url.pathname.startsWith('/api/runtime/')){
     if(url.pathname.startsWith('/api/runtime/wsl/')){
      const action=url.pathname.slice('/api/runtime/wsl/'.length);
      if(action==='status'){if(Object.keys(input).length)throw new Error('Invalid WSL status parameters');json(res,200,await wslStatus(requestAccess==='local'));return;}
      if(requestAccess!=='local')throw Object.assign(new Error('WSL runtime selection is local-only'),{status:403,code:'LOCAL_ONLY'});
      if(demo||wslRuntime.platform!=='win32')throw new Error('WSL is unavailable in this runtime');
      if(action==='discover-running'){if(Object.keys(input).length)throw new Error('Invalid discovery parameters');json(res,200,{...await wslStatus(),...await wslRuntime.discoverRunning()});return;}
      if(action==='discover'){if(Object.keys(input).length)throw new Error('Invalid discovery parameters');json(res,200,{...await wslStatus(),...await wslRuntime.discover()});return;}
      if(action==='select'){
       json(res,200,await saveRuntimeSelection(input));return;
      }
      throw new Error('Unknown WSL action');
     }
     if(requestAccess!=='local')throw Object.assign(new Error('Windows 运行引擎管理仅限本机'),{status:403,code:'LOCAL_ONLY'});
     if(wslActive){
      if(!['/api/runtime/status','/api/runtime/check'].includes(url.pathname))throw Object.assign(new Error('Manage the WSL Codex CLI inside its Linux distribution'),{code:'WSL_UNSUPPORTED',outcome:'notExecuted'});
      json(res,200,{current:{source:'wsl',path:wslCandidate?.codexPath||null,version:parseCodexVersion(rpc.version)},npm:{available:false,path:null,version:null},desktop:{available:false,path:null,version:null},latest:null,canUpgrade:false,blockedReason:'请在所选 WSL 发行版内更新 Codex',upgrading:false});return;
     }
     if(demo)throw new Error('演示模式不读取真实运行引擎，也不联网或升级');
     const action=url.pathname.slice('/api/runtime/'.length);
     if(action==='status'||action==='check'){
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)throw new Error('运行引擎参数无效');
      const status=await runtime[action]();
      if(action==='check'&&runtimeAutomation){runtimeAutomation.checkError=null;await runtimeAutomation.consider(status);}
      json(res,200,runtimeView(status));return;
     }
     if(action==='preferences'){
      if(!requestDesktop||!runtimeAutomation)throw Object.assign(new Error('持久化引擎设置仅限 Windows 桌面应用'),{status:403,code:'LOCAL_ONLY'});
      const status=await runtime.status();await runtimeAutomation.configure(input,status);
      json(res,200,runtimeView(status));return;
     }
     if(action==='upgrade'){
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='confirmed,requestId,version')throw new Error('升级参数无效');
      const {requestId,...params}=input;
      const result=await operations.execute(requestId,'runtime/upgrade',params,()=>runtime.upgrade(params,{requestId}));
      json(res,200,result);return;
     }
     throw new Error('未知运行引擎操作');
    }
    if(url.pathname==='/api/git/plan'){if(demo)throw new Error('演示模式不修改真实仓库');json(res,200,await gitActions.plan(input));return;}
    if(url.pathname==='/api/git/apply'){
     if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Git 参数无效');if(demo)throw new Error('演示模式不修改真实仓库');
     const {requestId,...params}=input;json(res,200,await operations.execute(requestId,'git/apply',params,()=>gitActions.apply(params)));return;
    }
    if(url.pathname==='/api/git/read'){json(res,200,await git.read(input));return;}
    if(url.pathname.startsWith('/api/terminal/')){
     const action=url.pathname.slice('/api/terminal/'.length);
     if(!['open','write','resize','terminate','snapshot'].includes(action))throw new Error('未知终端操作');
     if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('终端参数无效');
     if(demo)throw new Error('演示模式不启动真实终端');
     if(action==='open'){
      const {requestId,...params}=input;
      const result=await operations.execute(requestId,'terminal/open',params,()=>terminal.open(params));json(res,200,result);return;
     }
     try{json(res,200,await terminal[action](input));}catch(error){if(action==='write')error.outcome='unknown';throw error;}return;
    }
    if(url.pathname==='/api/rpc'){
     if(localManagement(input?.method))requireLocalManagement(requestAccess);
     if(stopping)throw Object.assign(new Error('Light 正在关闭，此请求未发送'),{code:'CLIENT_CLOSING',outcome:'notExecuted',status:409});
     if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['method','params','requestId','attachmentIds','fileAttachmentIds','confirmedFileAttachmentIds','confirmed','permissionMode'].includes(key)))throw new Error('RPC 请求格式无效');
     if(input.permissionMode!==undefined&&(input.method!=='thread/start'||!validPermissionMode(input.permissionMode)))throw new Error('对话批准方式无效');
     if(MUTATING_METHODS.has(input.method))operations.validate(input.requestId);
     let params,titleInput;
     try {
      if(input.method==='thread/delete'&&input.confirmed!==true)throw new Error('删除对话需要明确确认');
      if((input.attachmentIds!==undefined||input.fileAttachmentIds!==undefined||input.confirmedFileAttachmentIds!==undefined) && !['turn/start','turn/steer'].includes(input.method))throw new Error('此操作不接受附件');
      const attachmentInputs=input.attachmentIds===undefined?[]:await uploads.resolveInline(input.attachmentIds);
      const files=input.fileAttachmentIds===undefined?[]:await fileUploads.resolve(input.fileAttachmentIds);
      if(files.length+attachmentInputs.length>5)throw new Error('每次最多五个图片和文件附件');
      const accepted=input.confirmedFileAttachmentIds??[];if(!Array.isArray(accepted)||new Set(accepted).size!==accepted.length||accepted.some(id=>!files.some(file=>file.id===id)))throw new Error('附件风险确认无效');
      if(files.some(file=>file.riskWarning&&!accepted.includes(file.id)))throw new Error('请确认未知或压缩附件仅作为本地引用，不自动执行或解包');
      for(const file of files)attachmentInputs.push({type:'text',text:FILE_ATTACHMENT_REFERENCE_PREFIX+JSON.stringify({name:file.name,path:wslCandidate?await wslRuntime.toLinux(file.path,wslCandidate):file.path,category:file.category,size:file.size}),text_elements:[]});
      params=REMOTE_METHODS.has(input.method)?validateRemote(input.method,input.params||{},{confirmed:input.confirmed,activeEnvironmentId:remoteEnvironment,allowedClientIds:remoteClients}):validateRpc(input.method,input.params||{},{hasAttachments:attachmentInputs.length>0});
      if(input.method==='turn/start')titleInput=params.input.filter(item=>item.type==='text').map(item=>({type:'text',text:item.text}));
      if(input.method==='remoteControl/pairing/status'&&(!remotePairing||!Object.entries(params).some(([key,value])=>value&&remotePairing[key]===value)))throw new Error('配对码不属于本界面当前请求或已过期，请重新创建配对码');
      if(attachmentInputs.length)params={...params,input:[...params.input.filter(item=>item.text.trim()),...attachmentInputs]};
     } catch(error) {
      if(operations.entries.has(input.requestId))Object.assign(error,{outcome:'unknown',code:'REQUEST_ID_CONFLICT'});
      throw error;
     }
     const run=async(currentThread)=>{
      if(params.cwd){try{
       if(wslCandidate&&isProjectless(params.cwd))await projectlessWslCommand('/bin/test','-d',hostPathToWsl(params.cwd,wslCandidate.distribution));
       else if(!(await stat(params.cwd)).isDirectory())throw new Error('工作目录不是文件夹');
      }catch(error){error.outcome='notExecuted';throw error;}}
      if(!rpc.connected)throw Object.assign(new Error(rpc.lastError || 'Codex 正在连接，请稍后重试'),{code:'NOT_CONNECTED',outcome:'notExecuted'});
      let effective=params;
      if(input.method==='thread/start'&&!params.cwd){
       try{effective={...params,cwd:await newProjectlessDirectory()};}
       catch{throw Object.assign(new Error('无法创建无项目对话的独立工作目录。'),{outcome:'notExecuted'});}
      }
      if(input.method==='remoteControl/pairing/start')clearPairing();
      if(['turn/start','review/start','thread/compact/start'].includes(input.method))await readStatisticsAccount();
      await titleSummary.beforeRpc(input.method,titleInput?{...params,input:titleInput}:params);
      const identity=input.permissionMode?await permissionIdentity():null;
      const identityGeneration=accountIdentityGeneration;
      const forward=()=>input.method==='thread/summary'?titleSummary.summarizeSavedThread(currentThread):sessions.call(input.method,effective);
      const output=input.method==='thread/list'?await threadList.http(req,res,params):MUTATING_METHODS.has(input.method)?await threadList.mutate(forward):await forward();statistics.acknowledge(input.method,effective,output);if(output?.thread){artifacts.bindThread(output.thread);files.bindThread(output.thread);}
      if(output?.thread?.id&&identityGeneration===accountIdentityGeneration)rememberContext(contextFiles,output.thread.id,output.thread.path||contextFiles.get(output.thread.id)||null);
      if(input.method==='account/read'&&identityGeneration===accountIdentityGeneration)observedPermissionIdentity=accountIdentityKey(output);
      if(input.permissionMode&&output?.thread?.id){
       const choice={scope:sessionPermissions.scope(identity),mode:input.permissionMode};
       try{output.sessionPermission=await sessionPermissions.access(identity,output.thread.id,choice);}
       catch{output.sessionPermission={...choice,warning:'对话已创建，但批准方式未能保存。'};}
      }
      titleSummary.acknowledge(input.method,params,output);
      if(['turn/start','turn/steer'].includes(input.method))artifacts.observe(params.threadId,{type:'userMessage',content:params.input});
      if((input.method==='turn/start'&&output?.turn?.id)||(input.method==='turn/steer'&&output?.turnId)){
       const submittedAt=Date.now();let activityWarning;
       try{await projectHistory.recordSubmission(params.threadId,submittedAt);}
       catch{activityWarning='消息已发送，但最近活动未能保存。';}
       broadcast({method:'bridge/threadSubmission',params:{threadId:params.threadId,submittedAt}});
       return {...output,submittedAt,...(activityWarning?{activityWarning}:{})};
      }
      observeRemote(input.method,params,output);
      if(input.method==='thread/delete'){
       if(!output||typeof output!=='object'||Array.isArray(output))throw Object.assign(new Error('运行引擎未确认删除结果'),{outcome:'unknown'});
       return {threadId:params.threadId};
      }
      return withConversationMetadata(input.method,output);
     };
     const dshGeneration=dsh.generation;
     const result = MUTATING_METHODS.has(input.method)
       ? await operations.execute(input.requestId,input.method,input.permissionMode?{...params,permissionMode:input.permissionMode}:params,()=>{
        if(['thread/name/set','thread/archive','thread/delete','thread/summary'].includes(input.method))return sessions.runIdle(params.threadId,run);
        return run();
       })
       : await run();
     if(input.method==='plugin/list')result.actionHandles=pluginActions.observeCatalog(params,result,{allowToggle:requestAccess==='local'});
     if(dshGeneration===dsh.generation && input.method.startsWith('thread/'))dsh.bindThread(result?.thread);
     const historyThread=result?.thread?.id || params.threadId;
     if(input.method==='thread/items/list')for(const row of [...(result?.data||[])].reverse()){dsh.observe(historyThread,row.item||row,{older:true});artifacts.observe(historyThread,row.item||row);}
     if(input.method==='thread/turns/list')for(const turn of result?.data||[])for(const item of turn.items||[])artifacts.observe(historyThread,item);
     if(result?.thread?.turns)for(const turn of result.thread.turns)for(const item of turn.items||[]){dsh.observe(historyThread,item,{older:true});artifacts.observe(historyThread,item);}
     json(res,200,result);return;
    }
    if(url.pathname==='/api/dsh/monitor'){
     if(demo)throw new Error('演示模式不读取真实 DSH 任务');
     if(!rpc.connected)throw new Error('Codex 尚未连接');
     json(res,200,await dsh.monitor(input));return;
    }
    if(url.pathname==='/api/dsh/read'){
     if(demo)throw new Error('演示模式不读取真实 DSH 任务');
     if(!rpc.connected)throw new Error('Codex 尚未连接');
     const snapshot=await dsh.read(input);
     if(input.kind!=='history')broadcast({method:'bridge/dshSnapshot',params:snapshot});json(res,200,snapshot);return;
    }
    if(url.pathname==='/api/respond'){
     if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['id','bridgeRequestToken','result','error'].includes(key))||!validServerRequestId(input.id)||Object.hasOwn(input,'error')===Object.hasOwn(input,'result'))throw new Error('审批响应参数无效');
     const request=findServerRequest(rpc.requests,input.id);
      if(localManagement(request?.method))requireLocalManagement(requestAccess);
      if(!request||typeof input.bridgeRequestToken!=='string'||input.bridgeRequestToken!==presentRequest(request).bridgeRequestToken)throw Object.assign(new Error('该审批已结束或已更新，请刷新待处理请求'),{code:'STALE_APPROVAL',status:409});
     if(input.error){if(typeof input.error!=='object'||Array.isArray(input.error)||Object.keys(input.error).some(key=>!['code','message'].includes(key))||input.error.code!==-32601||(input.error.message!==undefined&&typeof input.error.message!=='string'))throw new Error('仅支持拒绝未知请求');rpc.respond(input.id,null,{code:-32601,message:'This GUI does not support this request.'});}
     else rpc.respond(input.id,validateResponse(request,input.result));
     json(res,200,{ok:true});return;
    }
    if(url.pathname==='/api/shutdown'){
     if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)throw new Error('关闭参数无效');
     try{await shutdownServices();}catch(error){throw Object.assign(new Error('关闭未完成，请查看关闭状态核对引擎是否退出'),{code:error.code||'SHUTDOWN_FAILED',outcome:'unknown',status:500});}
     res.once('finish',()=>setTimeout(()=>{close().catch(reportShutdownFailure);},50));
     json(res,200,{engineStopped:true,shutdownAccepted:true});return;
    }
    json(res,404,{error:'未知 API'});
   }catch(e){json(res,e.status||400,{error:e.message,code:e.code,outcome:e.outcome||'notExecuted',notExecuted:!e.outcome||e.outcome==='notExecuted',serverInstance:operations.serverInstance});}return;
  }
  if(!['GET','HEAD'].includes(req.method)){json(res,405,{error:'不支持的操作'});return;}
  const filename=publicFiles[url.pathname];if(!filename){json(res,404,{error:'不存在'});return;}
  try{let bytes=await readFile(path.join(publicDir,filename));if(filename==='index.html')bytes=Buffer.from(bytes.toString('utf8').replace(/<head>/i,`<head><meta name="codex-light-style-nonce" content="${styleNonce}">`));res.writeHead(200,{'Content-Type':types[path.extname(filename)]});res.end(bytes);}catch{json(res,404,{error:'资源未找到'});}
 };
 const server=http.createServer((req,res)=>handle(req,res));
 let sshRelay,tunnelQueue=Promise.resolve();
 const relayStatus=()=>sshRelay?.status||{state:'off',message:''};
 const tunnelStatus=async()=>({...tunnel.status(),sshRelay:relayStatus(),...await remoteIdentity(false)});
 function queueTunnel(operation){
  const result=tunnelQueue.then(()=>{
   if(stopping)throw Object.assign(new Error('应用正在关闭。'),{status:409});
   return operation();
  });
  tunnelQueue=result.catch(()=>{});
  return result;
 }
 const lanPersistence=desktop&&!demo&&process.platform==='win32'?{preferenceStore:new LanPreferenceStore({root:path.join(desktopState.root,'lan')}),networkIdentity:windowsNetworkIdentity,networkSnapshot:windowsNetworkSnapshot}:{};
 const lan=new LanAccess({...lanPersistence,...lanOptions,handler:handle,publicPaths:Object.keys(publicFiles)});
 const tunnel=new LanAccess({tunnel:true,handler:handle,publicPaths:Object.keys(publicFiles),beforeListenerClose:()=>sshRelay?.stop()});
 function observeRemote(method,params,result){
  if(['remoteControl/status/read','remoteControl/enable','remoteControl/disable'].includes(method)){const env=result?.environmentId||null;if(env!==remoteEnvironment){remoteEnvironment=env;remoteClients.clear();clearPairing();}}
  if(method==='remoteControl/client/list'){if(!params.cursor)remoteClients.clear();for(const client of result?.data||[])if(typeof client.clientId==='string')remoteClients.add(client.clientId);}
  if(method==='remoteControl/client/revoke')remoteClients.delete(params.clientId);
  if(method==='remoteControl/pairing/start'){
   clearTimeout(pairingTimer);
   const expiry=result?.expiresAt;
   if(!Number.isSafeInteger(expiry)||!Number.isSafeInteger(expiry*1000)||expiry*1000<=Date.now()){clearPairing();if(result&&typeof result==='object'){delete result.pairingCode;delete result.manualPairingCode;result.expired=true;}return;}
   remotePairing=result;
   if(typeof result.environmentId==='string'&&result.environmentId!==remoteEnvironment){remoteEnvironment=result.environmentId;remoteClients.clear();}
   const expire=()=>{const remaining=expiry*1000-Date.now();if(remaining<=0)clearPairing();else{pairingTimer=setTimeout(expire,Math.min(remaining,2147483647));pairingTimer.unref();}};expire();
  }
  if(method==='remoteControl/pairing/status'&&result?.claimed)clearPairing();
 }
 function broadcast(message,{localOnly=false}={}){localOnly=localOnly||localManagement(message.method);const exposed=message.id!==undefined&&typeof message.method==='string'?presentRequest(message):message;const event=`data: ${JSON.stringify(exposed)}\n\n`;for(const [res,access] of streams){if(res.destroyed){streams.delete(res);continue;}if(localOnly&&access!=='local')continue;if(res.writableLength>4*1024*1024){streams.delete(res);res.destroy();}else res.write(event);}}
 function resetThreadReads(){threadReads.reset();broadcast({method:'bridge/threadReads',params:threadReads.snapshot()});}
 accountLogin.on('event',event=>{if(['starting','loggingOut','completed','loggedOut','unknown','closed'].includes(event.params.state))clearStatisticsAccount();if(['completed','failed','canceled','loggedOut','unknown','closed'].includes(event.params.state)){for(const entry of operations.entries.values())if(entry.method==='account/start'&&entry.result){delete entry.result.authUrl;delete entry.result.verificationUrl;delete entry.result.userCode;entry.result.redacted=true;}}broadcast(event);if(event.params.state==='loggedOut')resetThreadReads();});
 terminal.on('event',broadcast);
 function clearDsh(){dsh.clear().then(()=>{dshResetError=null;},error=>{dshResetError=error?.message||'子代理读取会话清理失败';});}
 rpc.on('event',message=>{
  if(titleSummary.observe(message))return;
  if(message.method==='account/updated'||(message.method==='bridge/status'&&message.params?.connected===false))clearStatisticsAccount();
  const threadId=message.params?.threadId||message.params?.thread?.id;
  if(threadId&&dsh.isReaderThread(threadId))return;
  if(message.method==='account/login/completed'&&message.params?.success===true){resetThreadReads();pluginActions.clear();}
  threadReads.observe(message);
  mobileNotifications.observe(message);
  statistics.observe(message);sessions.observe(message);threadList.observe(message);
  if(message.method==='bridge/status'&&message.params?.connected===true)void dshWakeup?.refreshAccount();
  if(message.method==='account/updated'||message.method==='account/login/completed'){void dshWakeup?.refreshAccount({changed:true});}
  if(['item/started','item/completed'].includes(message.method)){try{dshWakeup?.observe(threadId,message.params?.item);}catch{dshWakeup?.close();dshWakeupError='Callback binding persistence failed; automatic wakeup disabled.';}}
  if(message.method==='account/updated'||(message.method==='bridge/status'&&message.params?.connected===false)){pluginActions.clear();configSettings.clear();clearDsh();}
  accountLogin.observe(message);
  if(message.method==='account/login/completed'){clearDsh();return;}
  terminal.observe(message);
  if(message.method==='bridge/status'&&message.params?.connected===false)terminal.disconnected();
  if(message.method==='thread/tokenUsage/updated'){
   const snapshot=contextSnapshot(message.params);
   if(snapshot)rememberContext(contextLive,snapshot.threadId,{...snapshot,source:'live'});
  }
  if(['thread/archived','thread/deleted'].includes(message.method)){
   contextFiles.delete(message.params?.threadId);contextLive.delete(message.params?.threadId);
  }
  if(message.method==='remoteControl/status/changed')observeRemote('remoteControl/status/read',{},message.params);
  if(['item/started','item/completed'].includes(message.method)){dsh.observe(message.params?.threadId,message.params?.item);artifacts.observe(message.params?.threadId,message.params?.item);}
  broadcast(message);
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 origin=`http://127.0.0.1:${server.address().port}`;
 if(desktop&&!demo&&appUpdates.status().supported){
  stopAutomaticUpdates=startUpdateChecks({
   check:()=>{updateReservation.assertOpen();return appUpdates.check({automatic:true});},
   onStatus:status=>broadcast({method:'bridge/appUpdate',params:{...status,demo}},{localOnly:true}),
   // Keep a successfully checked release within the downloader's one-hour validation window.
   interval:55*60*1000,setTimer:(callback,delay)=>setTimeout(callback,delay).unref(),
  });
 }
 void dshWakeup?.refreshAccount();
 dshWakeup?.start();
 void lan.restore().catch(()=>{});
 if(reopen){try{reopener=await createReopener({url:`${origin}/#token=${token}`,serverInstance:operations.serverInstance});}catch{reopenError='安全重开通道不可用；关闭窗口后请恢复原窗口，不会通过不安全方式返回访问令牌';}}
 function reportShutdownFailure(error){shutdownError={code:error.code||'SHUTDOWN_FAILED',message:'本地服务关闭失败，不能确认所有资源已释放'};broadcast({method:'bridge/shutdown',params:{state:'failed',...shutdownError,engineStopped}});}
 function shutdownServices(){
  if(serviceShutdown)return serviceShutdown;
  stopping=true;stopAutomaticUpdates?.();runtimeAutomation?.close();dshWakeup?.close();configSettings.clear();gitActions.plans.clear();pluginActions.clear();
  for(const timer of loginTimers)clearTimeout(timer);loginTimers.clear();usageScan?.abort();clearPairing();
  const stopEngine=(async()=>{try{await Promise.all([sessions.close(),dsh.close(),titleSummary.close()]);}finally{await rpc.close();engineStopped=true;}})();
  const closeTunnel=async()=>{await tunnel.close();await tunnelQueue;await sshRelay?.close();};
  serviceShutdown=Promise.all([lan.close(),closeTunnel(),terminal.close(),accountLogin.close(),Promise.resolve(runtime.close?.()),Promise.resolve(appUpdates.close?.()),stopEngine]).then(async()=>{
   await automaticStartup;await runtimeAutomation?.queue;await usageScanPromise?.catch(()=>{});
   await Promise.all([uploads.close(),fileUploads.close(),statistics.close(),pricing.close(),artifacts.close(),files.close()]);
   await desktopState?.queue;await projects.queue;
   if(temporaryState)await rm(temporaryState,{recursive:true,force:true});
   if(temporaryProjects)await rm(temporaryProjects,{recursive:true,force:true});
  }).catch(error=>{reportShutdownFailure(error);throw error;});
  return serviceShutdown;
 }
 function close(){
  if(closing)return closing;
  const stopped=shutdownServices();
  for(const res of streams.keys())res.end();streams.clear();server.closeAllConnections();
  closing=Promise.all([stopped,new Promise(resolve=>server.close(resolve)),Promise.resolve(reopener?.close())]);return closing;
 }
 const started=(async()=>{
  if(runtimeAutomation&&!wslActive){
   automaticStartup=runtimeAutomation.beforeEngineStart(runtime,runtimeSource);
   const executable=await automaticStartup;
   if(executable){command=executable;rpc.command=executable;runtime.currentPath=executable;}
   if(!stopping)runtimeAutomation.start(runtime,runtimeSource);
  }
  if(!stopping)return rpc.start();
  return null;
 })().catch(error=>{rpc.lastError=error.message;return null;});
 return {runtimeDescriptor,server,lan,rpc,sessions,statistics,artifacts,operations,uploads,fileUploads,dsh,terminal,runtime,appUpdates,projectStore:projects,reopenEndpoint:reopener?.endpoint,origin,token,url:`${origin}/#token=${token}`,close,started};
}
if(process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 const args=process.argv.slice(2);const get=key=>args.includes(key)?args[args.indexOf(key)+1]:undefined;
 const app=await createServer({demo:args.includes('--demo'),reopen:true,cwd:get('--cwd')||'',command:get('--codex')||process.env.CODEX_LIGHT_CODEX||'codex'});
 if(process.send)process.send({url:app.url,serverInstance:app.operations.serverInstance,reopenEndpoint:app.reopenEndpoint});else console.log(`码舱 CodeCang 本地地址（仅自己使用）：\n${app.url}\n关闭此进程会停止 GUI 后端。`);
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>app.close().then(()=>process.exit()));
}
