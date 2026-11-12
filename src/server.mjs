import http from 'node:http';
import {ConfigSettingsService} from './config-settings.mjs';
import {DesktopState} from './desktop-state.mjs';
import {ProjectStore} from './projects.mjs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {GitCommandActions} from './git-command-actions.mjs';
import {nativeCodex,resolveCodexRuntime} from './runtime-path.mjs';
import {RuntimeManager} from './runtime-manager.mjs';
import {PluginActionService} from './plugin-actions.mjs';
import {FileAttachmentStore} from './file-attachments.mjs';
import {AccountLoginService} from './account-login.mjs';
import {scanLocalCodexUsage} from './local-usage-scan.mjs';
import {PricingService} from './pricing.mjs';
import {StatisticsService,defaultStatisticsRoot} from './statistics.mjs';
import {ArtifactPreviewService} from './artifacts.mjs';
import {LanAccess} from './lan-access.mjs';
import {GitService} from './git.mjs';
import {TerminalService} from './terminal.mjs';
import { RpcClient } from './rpc.mjs';
import {validServerRequestId,findServerRequest} from './server-requests.mjs';
import {ThreadSessions} from './thread-sessions.mjs';
import { DemoClient } from './demo.mjs';
import { validateRpc, validateResponse } from './security.mjs';
import { OperationStore, MUTATING_METHODS } from './operations.mjs';
import { UploadStore } from './uploads.mjs';
import { DshReadService } from './dsh-read.mjs';
import {DshConfigSourcesService} from './dsh-config-sources.mjs';
import {DshConnectionService} from './dsh-connection.mjs';
import {PrReviewService} from './pr-review.mjs';
import {SessionDefaultsService} from './session-defaults.mjs';
import {REMOTE_METHODS,validateRemote} from './remote.mjs';
import { createReopener } from './reopen.mjs';
const publicDir=fileURLToPath(new URL('../public/',import.meta.url));
const publicFiles={'/config-settings-panel.js':'config-settings-panel.js','/preferences.js':'preferences.js','/plugin-actions-panel.js':'plugin-actions-panel.js','/account-login-panel.js':'account-login-panel.js','/local-usage-panel.js':'local-usage-panel.js','/usage-statistics.js':'usage-statistics.js','/token-pricing.js':'token-pricing.js','/plugins.js':'plugins.js','/plugins.css':'plugins.css','/pr-review-panel.js':'pr-review-panel.js','/terminal.js':'terminal.js','/vendor/xterm.mjs':'vendor/xterm.mjs','/vendor/addon-fit.mjs':'vendor/addon-fit.mjs','/vendor/xterm.css':'vendor/xterm.css','/approval-schemas.js':'approval-schemas.js','/':'index.html','/index.html':'index.html','/app.js':'app.js','/styles.css':'styles.css','/style.css':'style.css','/store.js':'store.js','/dsh.js':'dsh.js','/dsh-live.js':'dsh-live.js','/runtime-panel.js':'runtime-panel.js','/markdown.js':'markdown.js','/submissions.js':'submissions.js','/attachments.js':'attachments.js','/account.js':'account.js','/reasoning.js':'reasoning.js','/remote.js':'remote.js','/icons.js':'icons.js','/state.js':'state.js','/icon.svg':'icon.svg'};
const types={'.mjs':'text/javascript; charset=utf-8','.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
for(const file of ['format.js','chart.js','stats-view.js','account-view.js','live-changes.js','views.css','paste.js','artifacts.js','agents.js','access.js','lan-view.js','viewport.js','approvals-view.js','composer.js','dsh-view.js','preferences-view.js','remote-view.js','slash-menu.js','workbench-view.js','dsh-config-view.js','dsh-connection-view.js'])publicFiles['/ui/'+file]='ui/'+file;
for(const file of ['activity-feed.js','activity-feed.css','projects.js','project-navigation.js','project-navigation.css'])publicFiles['/'+file]=file;
async function body(req){let data='';for await(const chunk of req){data+=chunk;if(data.length>512*1024)throw new Error('请求太大');}try{return JSON.parse(data||'{}');}catch{throw new Error('无效 JSON');}}
export async function createServer({client,cwd='',command='codex',demo=false,port=0,reopen=false,desktop=false,onDesktopTheme,onDesktopPickFolder,desktopStateRoot,projectStore,projectsRoot,fileAttachmentRoot,token=randomBytes(32).toString('hex'),prReviewService,runtimeManager,statisticsRoot,lanOptions,dshConfigSourcesService,dshConnectionService}={}){
 let runtimeSource='configured';
 if(!client&&!demo){
  if(!command||command==='codex'||command==='codex.exe'){const resolved=resolveCodexRuntime();command=resolved.path;runtimeSource=resolved.source==='npm'||resolved.source==='desktop'?resolved.source:'configured';}
  else{command=nativeCodex({env:{...process.env,CODEX_LIGHT_CODEX:command}});runtimeSource='configured';}
 }else runtimeSource=demo?'demo':(client?'client':'configured');
 const temporaryState=desktop&&demo&&!desktopStateRoot?await mkdtemp(path.join(os.tmpdir(),'codex-light-demo-state-')):null;
 const desktopState=desktop?new DesktopState({root:desktopStateRoot||temporaryState||undefined}):null;
 const temporaryProjects=demo&&!projectStore&&!projectsRoot?await mkdtemp(path.join(os.tmpdir(),'codex-light-demo-projects-')):null;
 const projects=projectStore||new ProjectStore({root:projectsRoot||temporaryProjects||undefined});
 const rpc=client || (demo?new DemoClient():new RpcClient({command,cwd:cwd||os.homedir()}));
 const sessions=new ThreadSessions(rpc,{onEvent:message=>broadcast(message)});
 const artifacts=new ArtifactPreviewService({projects});
 const git=new GitService();
 const gitActions=new GitCommandActions();
 const pricing=new PricingService();
 const statistics=new StatisticsService({pricing,root:statisticsRoot??(!demo&&!client?defaultStatisticsRoot():null)});await statistics.load();
 let usageScan=null;
 const terminal=new TerminalService(rpc);
 const accountLogin=new AccountLoginService(rpc);
 const pluginActions=new PluginActionService({rpc});
 const configSettings=new ConfigSettingsService({rpc});
 const sessionDefaults=new SessionDefaultsService({rpc,demo});
 const dshConfigSources=dshConfigSourcesService||new DshConfigSourcesService({demo});
 const dshConnection=dshConnectionService||new DshConnectionService({rpc,demo});
 const requestTokens=new WeakMap();
 function presentRequest(request){let bridgeRequestToken=requestTokens.get(request);if(!bridgeRequestToken){bridgeRequestToken=randomBytes(24).toString('hex');requestTokens.set(request,bridgeRequestToken);}return {...request,bridgeRequestToken};}
 const prReview=prReviewService||new PrReviewService();
 const fileUploads=new FileAttachmentStore(fileAttachmentRoot?{root:fileAttachmentRoot}:{});
 const loginTimers=new Set();
 const dsh=new DshReadService(rpc);const uploads=new UploadStore();const streams=new Set();const operations=new OperationStore({hooks:desktopState?{before:r=>desktopState.before(r),after:r=>desktopState.after(r)}:undefined});const runtime=runtimeManager||new RuntimeManager({currentPath:command,currentSource:runtimeSource,operations,rpc});let origin;let stopping=false;let closing;let serviceShutdown;let shutdownError=null;let engineStopped=false;let reopener;let reopenError=null;let remoteEnvironment=null;const remoteClients=new Set();let remotePairing=null;let pairingTimer;
 function clearPairing(){clearTimeout(pairingTimer);remotePairing=null;for(const entry of operations.entries.values())if(entry.method==='remoteControl/pairing/start'&&entry.result){delete entry.result.pairingCode;delete entry.result.manualPairingCode;entry.result.expired=true;}}
 const json=(res,status,data)=>{if(res.destroyed || res.writableEnded)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
 const handle=async(req,res,context)=>{
  const requestOrigin=context?.origin??origin,requestToken=context?.token??token,requestAccess=context?.access==='lan'?'lan':'local',requestDesktop=desktop&&requestAccess==='local';
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
  const styleNonce=randomBytes(24).toString('base64');
  res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${styleNonce}'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
  if(req.headers.host!==new URL(requestOrigin).host || (req.headers.origin && req.headers.origin!==requestOrigin)){json(res,403,{error:'拒绝外部来源'});return;}
  let url;try{url=new URL(req.url,requestOrigin);}catch{json(res,400,{error:'无效请求地址'});return;}
  if(url.origin!==requestOrigin){json(res,403,{error:'拒绝外部来源'});return;}
  if(url.pathname==='/health' && req.method==='GET'){json(res,200,{app:'codex-light',serverInstance:operations.serverInstance,pid:process.pid});return;}
  if(url.pathname.startsWith('/api/')){
   const auth=req.headers.authorization||'';const expected=`Bearer ${requestToken}`;
   if(Buffer.byteLength(auth)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(auth),Buffer.from(expected))){json(res,401,{error:'访问凭据已失效，请重新启动 GUI'});return;}
   try{
    if(['/api/dsh/config-sources/','/api/dsh/connection/'].some(prefix=>url.pathname.startsWith(prefix))&&requestAccess!=='local'){json(res,403,{error:'DSH 配置和连接管理仅限本机',code:'LOCAL_ONLY',outcome:'notExecuted'});return;}
    if(stopping&&req.method==='POST'&&url.pathname!=='/api/shutdown')throw Object.assign(new Error('Light 正在关闭，此请求未发送'),{code:'CLIENT_CLOSING',outcome:'notExecuted',status:409});
    if(url.pathname==='/api/events' && req.method==='GET'){
     res.writeHead(200,{'Content-Type':'text/event-stream','Connection':'keep-alive'});res.write(': connected\n\n');streams.add(res);
     const heartbeat=setInterval(()=>{if(res.writableLength>4*1024*1024)res.destroy();else res.write(': keepalive\n\n');},15000);
     req.on('close',()=>{streams.delete(res);clearInterval(heartbeat);});return;
    }
    if(url.pathname==='/api/status' && req.method==='GET'){json(res,200,{connected:rpc.connected,demo,desktop:requestDesktop,access:requestAccess,stopping,engineStopped,shutdownError,threadSessions:sessions.snapshot(),persistenceWarning:operations.persistenceWarning||desktopState?.persistenceWarning||null,version:rpc.version||null,error:rpc.lastError||null,pendingRequests:[...rpc.requests.values()].map(presentRequest),serverInstance:operations.serverInstance,operationRetentionMs:operations.retentionMs,reopenAvailable:requestAccess==='local'&&!!reopener,reopenError:requestAccess==='local'?reopenError:null});return;}
    if(url.pathname==='/api/operations' && req.method==='GET'){json(res,200,operations.get(url.searchParams.get('requestId')));return;}
    if(url.pathname==='/api/config' && req.method==='GET'){json(res,200,{cwd,codexCommand:command});return;}
    if(url.pathname==='/api/projects'&&req.method==='GET'){json(res,200,{...await projects.list(),canPickFolder:requestDesktop&&typeof onDesktopPickFolder==='function'});return;}
    if(url.pathname==='/api/desktop/preferences'&&req.method==='GET'){if(!desktopState)throw new Error('仅桌面模式支持本机状态');json(res,200,{preferences:await desktopState.preferences()});return;}
    if(url.pathname==='/api/desktop/receipts'&&req.method==='GET'){if(!desktopState)throw new Error('仅桌面模式支持本机状态');json(res,200,{receipts:await desktopState.list(),persistenceWarning:operations.persistenceWarning||desktopState.persistenceWarning});return;}
    if(req.method!=='POST'){json(res,405,{error:'不支持的操作'});return;}
    if(url.pathname.startsWith('/api/dsh/connection/')){
     const action=url.pathname.slice('/api/dsh/connection/'.length),input=await body(req);
     if(!['status','plan','connect'].includes(action))throw Object.assign(new Error('未知 DSH 连接操作'),{code:'INVALID_INPUT',status:400});
     json(res,200,await dshConnection[action](input));return;
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
     if(Number(req.headers['content-length'])>uploads.maxFile)throw new Error('单张图片不能超过 10 MiB');
     json(res,200,await uploads.add(req,{filename}));return;
    }
    const input=await body(req);
    if(url.pathname.startsWith('/api/lan/')){
     if(requestAccess!=='local')throw Object.assign(new Error('此操作仅限本机窗口'),{status:403});
     const action=url.pathname.slice('/api/lan/'.length);
     if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('局域网参数无效');
     if(action==='enable'){json(res,200,await lan.enable(input));return;}
     if(!['status','disable','rotate'].includes(action)||Object.keys(input).length)throw new Error('局域网操作参数无效');
     json(res,200,await lan[action]());return;
    }
    if(url.pathname==='/api/desktop/pick-folder'){
     if(!desktop||typeof onDesktopPickFolder!=='function'){json(res,409,{error:'当前窗口不支持原生文件夹选择'});return;}
     if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)throw new Error('文件夹选择参数无效');
     const selected=await onDesktopPickFolder();
     if(selected!==null&&(typeof selected!=='string'||selected.length>4096||selected.includes('\0')||!path.isAbsolute(selected)))throw new Error('原生文件夹选择返回了无效路径');
     json(res,200,{path:selected});return;
    }
    if(['/api/projects/add','/api/projects/select','/api/projects/remove'].includes(url.pathname)){
     const action=url.pathname.slice('/api/projects/'.length),field=action==='add'?'path':'id';
     if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).join(',')!==field||typeof input[field]!=='string')throw new Error('项目参数无效');
     json(res,200,await projects[action](input[field]));return;
    }
    if(url.pathname==='/api/session/defaults'){
     json(res,200,await sessionDefaults.read(input));return;
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
    if(url.pathname.startsWith('/api/config-settings/')){
     if(demo)throw new Error('演示模式不读取或更改真实配置');if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('配置参数无效');
     const action=url.pathname.slice('/api/config-settings/'.length);
     if(action==='read'){if(Object.keys(input).some(k=>k!=='cwd'))throw new Error('配置读取参数无效');json(res,200,await configSettings.read(input));return;}
     if(action==='plan'){if(Object.keys(input).some(k=>k!=='edits'))throw new Error('配置计划参数无效');json(res,200,configSettings.plan(input.edits));return;}
     if(action==='apply'){const {requestId,...params}=input;json(res,200,await operations.execute(requestId,'config/apply',params,()=>configSettings.apply(params)));return;}
     throw new Error('未知配置操作');
    }
    if(url.pathname==='/api/plugins/plan'){
     if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['handle','action'].includes(k)))throw new Error('插件计划参数无效');
     if(demo)throw new Error('演示模式不安装真实插件');json(res,200,await pluginActions.plan(input.handle,input.action));return;
    }
    if(url.pathname==='/api/plugins/apply'){
     if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('插件参数无效');if(demo)throw new Error('演示模式不修改真实插件');
     const {requestId,...params}=input;json(res,200,await operations.execute(requestId,'plugin/apply',params,()=>pluginActions.apply(params)));return;
    }
    if(url.pathname.startsWith('/api/account/')){
     const action=url.pathname.slice('/api/account/'.length);if(!['start','cancel','logout','snapshot'].includes(action))throw new Error('未知账号操作');
     if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('账号参数无效');if(demo)throw new Error('演示模式不更改真实账号');
     if(action==='snapshot'){if(Object.keys(input).length)throw new Error('账号参数无效');json(res,200,accountLogin.snapshot());return;}
     const {requestId,...params}=input;const result=await operations.execute(requestId,`account/${action}`,params,()=>accountLogin[action](params));
     if(action==='start'){
      const scrub=()=>{const entry=operations.entries.get(requestId);if(entry?.result){delete entry.result.authUrl;delete entry.result.verificationUrl;delete entry.result.userCode;entry.result.redacted=true;}};
      if(accountLogin.snapshot().state!=='waiting')scrub();else{const timer=setTimeout(()=>{scrub();loginTimers.delete(timer);},600000);timer.unref();loginTimers.add(timer);}
     }json(res,200,result);return;
    }
    if(url.pathname==='/api/artifacts/preview'){
     const image=await artifacts.preview(input);
     if(res.destroyed||res.writableEnded)return;
     res.setHeader('Content-Security-Policy',"sandbox; default-src 'none'; script-src 'none'; object-src 'none'; frame-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'");
     res.writeHead(200,{'Content-Type':image.mime,'Content-Length':image.bytes.length,'Content-Disposition':'attachment; filename="artifact.'+({'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif','image/vnd.microsoft.icon':'ico','image/svg+xml':'svg'})[image.mime]+'"','X-Artifact-Width':String(image.width),'X-Artifact-Height':String(image.height)});res.end(image.bytes);return;
    }
    if(url.pathname==='/api/statistics/query'){json(res,200,statistics.query(input));return;}
    if(['/api/local-usage/scan','/api/statistics/import'].includes(url.pathname)){
     if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>k!=='directory')||typeof input.directory!=='string'||input.directory.length>4096)throw new Error('扫描目录参数无效');
     if(demo)throw new Error('演示模式不读取本机历史');if(usageScan)throw new Error('已有扫描正在进行');
     const controller=new AbortController();usageScan=controller;const timeout=setTimeout(()=>controller.abort(),60000);const disconnect=()=>{if(!res.writableEnded)controller.abort();};res.once('close',disconnect);
     try{const scan=await scanLocalCodexUsage(input.directory,{signal:controller.signal});statistics.importLocal(scan);json(res,200,url.pathname==='/api/statistics/import'?{imported:true,scan:{filesRead:scan.filesRead,bytesRead:scan.bytesRead,partial:scan.partial,diagnosticCounts:scan.diagnosticCounts},statistics:statistics.query({scope:'local'})}:scan);}finally{clearTimeout(timeout);res.off('close',disconnect);usageScan=null;}return;
    }
    if(url.pathname==='/api/pricing/status'){if(Object.keys(input).length)throw new Error('价格参数无效');json(res,200,pricing.status());return;}
    if(url.pathname==='/api/pricing/refresh'){if(Object.keys(input).length)throw new Error('价格参数无效');if(demo)throw new Error('演示模式不请求真实价格服务');json(res,200,await pricing.refresh());return;}
    if(url.pathname==='/api/pricing/model'){if(Object.keys(input).some(k=>k!=='model'))throw new Error('价格参数无效');json(res,200,pricing.get(input.model));return;}
    if(url.pathname.startsWith('/api/runtime/')){
     if(demo)throw new Error('演示模式不读取真实运行引擎，也不联网或升级');
     const action=url.pathname.slice('/api/runtime/'.length);
     if(action==='status'||action==='check'){
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)throw new Error('运行引擎参数无效');
      json(res,200,await runtime[action]());return;
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
     if(stopping)throw Object.assign(new Error('Light 正在关闭，此请求未发送'),{code:'CLIENT_CLOSING',outcome:'notExecuted',status:409});
     if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['method','params','requestId','attachmentIds','fileAttachmentIds','confirmedFileAttachmentIds','confirmed'].includes(key)))throw new Error('RPC 请求格式无效');
     if(MUTATING_METHODS.has(input.method))operations.validate(input.requestId);
     let params;
     try {
      if((input.attachmentIds!==undefined||input.fileAttachmentIds!==undefined||input.confirmedFileAttachmentIds!==undefined) && !['turn/start','turn/steer'].includes(input.method))throw new Error('此操作不接受附件');
      const attachmentInputs=input.attachmentIds===undefined?[]:uploads.resolve(input.attachmentIds);
      const files=input.fileAttachmentIds===undefined?[]:await fileUploads.resolve(input.fileAttachmentIds);
      if(files.length+attachmentInputs.length>5)throw new Error('每次最多五个图片和文件附件');
      const accepted=input.confirmedFileAttachmentIds??[];if(!Array.isArray(accepted)||new Set(accepted).size!==accepted.length||accepted.some(id=>!files.some(file=>file.id===id)))throw new Error('附件风险确认无效');
      if(files.some(file=>file.riskWarning&&!accepted.includes(file.id)))throw new Error('请确认未知或压缩附件仅作为本地引用，不自动执行或解包');
      for(const file of files)attachmentInputs.push({type:'text',text:`用户选择的本地附件（仅路径引用，内容尚未读取；请按当前权限读取，不执行或自动解包）：${JSON.stringify({name:file.name,path:file.path,category:file.category,size:file.size})}`,text_elements:[]});
      params=REMOTE_METHODS.has(input.method)?validateRemote(input.method,input.params||{},{confirmed:input.confirmed,activeEnvironmentId:remoteEnvironment,allowedClientIds:remoteClients}):validateRpc(input.method,input.params||{},{hasAttachments:attachmentInputs.length>0});
      if(input.method==='remoteControl/pairing/status'&&(!remotePairing||!Object.entries(params).some(([key,value])=>value&&remotePairing[key]===value)))throw new Error('配对码不属于本界面当前请求或已过期，请重新创建配对码');
      if(attachmentInputs.length)params={...params,input:[...params.input.filter(item=>item.text.trim()),...attachmentInputs]};
     } catch(error) {
      if(operations.entries.has(input.requestId))Object.assign(error,{outcome:'unknown',code:'REQUEST_ID_CONFLICT'});
      throw error;
     }
     const run=async()=>{
      if(params.cwd){try{const info=await stat(params.cwd);if(!info.isDirectory())throw new Error('工作目录不是文件夹');}catch(error){error.outcome='notExecuted';throw error;}}
      if(!rpc.connected)throw Object.assign(new Error(rpc.lastError || 'Codex 正在连接，请稍后重试'),{code:'NOT_CONNECTED',outcome:'notExecuted'});
      if(input.method==='remoteControl/pairing/start')clearPairing();
      const output=await sessions.call(input.method,params);statistics.acknowledge(input.method,params,output);if(output?.thread)artifacts.bindThread(output.thread);observeRemote(input.method,params,output);return output;
     };
     const dshGeneration=dsh.generation;
     const result = MUTATING_METHODS.has(input.method)
       ? await operations.execute(input.requestId,input.method,params,run)
       : await run();
     if(input.method==='plugin/list')result.actionHandles=pluginActions.observeCatalog(params,result);
     if(dshGeneration===dsh.generation && input.method.startsWith('thread/'))dsh.bindThread(result?.thread);
     const historyThread=result?.thread?.id || params.threadId;
     if(input.method==='thread/items/list')for(const row of [...(result?.data||[])].reverse())dsh.observe(historyThread,row.item||row,{older:true});
     if(result?.thread?.turns)for(const turn of result.thread.turns)for(const item of turn.items||[])dsh.observe(historyThread,item,{older:true});
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
     broadcast({method:'bridge/dshSnapshot',params:snapshot});json(res,200,snapshot);return;
    }
    if(url.pathname==='/api/respond'){
     if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['id','bridgeRequestToken','result','error'].includes(key))||!validServerRequestId(input.id)||Object.hasOwn(input,'error')===Object.hasOwn(input,'result'))throw new Error('审批响应参数无效');
     const request=findServerRequest(rpc.requests,input.id);if(!request||typeof input.bridgeRequestToken!=='string'||input.bridgeRequestToken!==presentRequest(request).bridgeRequestToken)throw Object.assign(new Error('该审批已结束或已更新，请刷新待处理请求'),{code:'STALE_APPROVAL',status:409});
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
 const lan=new LanAccess({...lanOptions,handler:handle,publicPaths:Object.keys(publicFiles)});
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
 function broadcast(message){const exposed=message.id!==undefined&&typeof message.method==='string'?presentRequest(message):message;const event=`data: ${JSON.stringify(exposed)}\n\n`;for(const res of streams){if(res.destroyed){streams.delete(res);continue;}if(res.writableLength>4*1024*1024){streams.delete(res);res.destroy();}else res.write(event);}}
 accountLogin.on('event',event=>{if(['completed','failed','canceled','loggedOut','unknown','closed'].includes(event.params.state)){for(const entry of operations.entries.values())if(entry.method==='account/start'&&entry.result){delete entry.result.authUrl;delete entry.result.verificationUrl;delete entry.result.userCode;entry.result.redacted=true;}}broadcast(event);});
 terminal.on('event',broadcast);
 rpc.on('event',message=>{statistics.observe(message);sessions.observe(message);if(message.method==='account/updated'||(message.method==='bridge/status'&&message.params?.connected===false)){pluginActions.clear();configSettings.clear();dsh.clear();}accountLogin.observe(message);if(message.method==='account/login/completed'){dsh.clear();return;}terminal.observe(message);if(message.method==='bridge/status'&&message.params?.connected===false)terminal.disconnected();if(message.method==='remoteControl/status/changed')observeRemote('remoteControl/status/read',{},message.params);if(['item/started','item/completed'].includes(message.method))dsh.observe(message.params?.threadId,message.params?.item);broadcast(message);});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 origin=`http://127.0.0.1:${server.address().port}`;
 if(reopen){try{reopener=await createReopener({url:`${origin}/#token=${token}`,serverInstance:operations.serverInstance});}catch{reopenError='安全重开通道不可用；关闭窗口后请恢复原窗口，不会通过不安全方式返回访问令牌';}}
 function reportShutdownFailure(error){shutdownError={code:error.code||'SHUTDOWN_FAILED',message:'本地服务关闭失败，不能确认所有资源已释放'};broadcast({method:'bridge/shutdown',params:{state:'failed',...shutdownError,engineStopped}});}
 function shutdownServices(){
  if(serviceShutdown)return serviceShutdown;
  stopping=true;configSettings.clear();gitActions.plans.clear();pluginActions.clear();
  for(const timer of loginTimers)clearTimeout(timer);loginTimers.clear();usageScan?.abort();clearPairing();
  serviceShutdown=Promise.all([lan.close(),terminal.close(),accountLogin.close(),Promise.resolve(runtime.close?.()),sessions.close().then(()=>rpc.close()).then(()=>{engineStopped=true;})]).then(async()=>{
   dsh.clear();await Promise.all([uploads.close(),fileUploads.close(),statistics.close(),artifacts.close()]);
   await desktopState?.queue;await projects.queue;
   if(temporaryState)await rm(temporaryState,{recursive:true,force:true});
   if(temporaryProjects)await rm(temporaryProjects,{recursive:true,force:true});
  }).catch(error=>{reportShutdownFailure(error);throw error;});
  return serviceShutdown;
 }
 function close(){
  if(closing)return closing;
  const stopped=shutdownServices();
  for(const res of streams)res.end();streams.clear();server.closeAllConnections();
  closing=Promise.all([stopped,new Promise(resolve=>server.close(resolve)),Promise.resolve(reopener?.close())]);return closing;
 }
 const started=rpc.start().catch(error=>{rpc.lastError=error.message;return null;});
 return {server,lan,rpc,sessions,statistics,artifacts,operations,uploads,fileUploads,dsh,terminal,runtime,projectStore:projects,reopenEndpoint:reopener?.endpoint,origin,token,url:`${origin}/#token=${token}`,close,started};
}
if(process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 const args=process.argv.slice(2);const get=key=>args.includes(key)?args[args.indexOf(key)+1]:undefined;
 const app=await createServer({demo:args.includes('--demo'),reopen:true,cwd:get('--cwd')||'',command:get('--codex')||process.env.CODEX_LIGHT_CODEX||'codex'});
 if(process.send)process.send({url:app.url,serverInstance:app.operations.serverInstance,reopenEndpoint:app.reopenEndpoint});else console.log(`Codex Light 本地地址（仅自己使用）：\n${app.url}\n关闭此进程会停止 GUI 后端。`);
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>app.close().then(()=>process.exit()));
}
