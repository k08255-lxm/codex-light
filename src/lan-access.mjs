import http from 'node:http';
import os from 'node:os';
import {isIP} from 'node:net';
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';

const localOnly=['/api/lan','/api/shutdown','/api/reopen','/api/desktop','/api/runtime'];
const failure=(message,code,status=400)=>Object.assign(new Error(message),{code,status,outcome:'notExecuted'});
const privateV4=address=>{
 if(isIP(address)!==4)return false;
 const [a,b]=address.split('.').map(Number);
 return a===10||(a===172&&b>=16&&b<=31)||(a===192&&b===168);
};
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const forbidden=pathname=>localOnly.some(prefix=>pathname===prefix||pathname.startsWith(prefix+'/'));
const validNonce=nonce=>typeof nonce==='string'&&/^[a-f0-9]{32}$/.test(nonce);
function endpointProof(token,nonce,tunnel){
 return createHmac('sha256',token).update((tunnel?'codecang-relay-v1:':'codecang-lan-v1:')+nonce).digest('hex');
}
function adapterPriority(name){
 // Interface names are the only adapter metadata exposed by os.networkInterfaces().
 if(/\b(?:vethernet|wsl2?|hyper-v|virtual|virtualbox|vmware|docker|vpn|openvpn|wireguard|wintun|tailscale|zerotier|tap-windows)\b|虚拟|虛擬/i.test(name)||/^(?:(?:virbr|docker|tun|utun|tap|wg)\d*|veth[0-9a-f]*)$/i.test(name))return 2;
 if(/\b(?:ethernet|wi[ -]?fi|wlan|wireless)\b|以太网|乙太網|无线|無線|イーサネット|이더넷|sans fil|inalámbric|беспровод/i.test(name)||/^(?:(?:en|eth|wlan)\d+|(?:en[opsc]|wl[ops])\d\w*|(?:en|wl)x[0-9a-f]{12})$/i.test(name))return 0;
 return 1;
}
function respond(res,status,message){
 if(res.destroyed||res.writableEnded)return;
 if(res.headersSent){res.destroy();return;}
 res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
 res.end(JSON.stringify({error:message}));
}

function tunnelEndpoint(input) {
 const invalid=()=>failure('请输入固定的 HTTPS 域名，仅填写源地址，例如 https://code.example.com','TUNNEL_INVALID_ORIGIN');
 if(!plain(input)||Object.keys(input).sort().join(',')!=='port,publicOrigin')throw failure('公网入口参数无效','TUNNEL_INVALID_INPUT');
 const {publicOrigin,port}=input;
 if(!Number.isInteger(port)||port<1||port>65535)throw failure('本机回源端口必须为 1–65535','TUNNEL_INVALID_PORT');
 if(typeof publicOrigin!=='string'||publicOrigin.length>2048||!/^https:\/\/[\p{L}0-9.-]+(?::[0-9]+)?\/?$/iu.test(publicOrigin))throw invalid();
 let url;
 try{url=new URL(publicOrigin);}catch{throw invalid();}
 const host=url.hostname;
 const labels=host.split('.');
 const tld=labels.at(-1);
 if(host.length>253||labels.length<2||isIP(host)||tld==='localhost'||!/^[a-z][a-z0-9-]*[a-z0-9]$/i.test(tld)||url.port==='0'||
   !labels.every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)))throw invalid();
 if(host==='trycloudflare.com'||host.endsWith('.trycloudflare.com'))throw failure('临时 Cloudflare 隧道不支持实时事件流，请使用命名隧道和固定域名','TUNNEL_QUICK_UNSUPPORTED');
 return {candidates:[{address:'127.0.0.1',family:'IPv4'}],mode:'single',port,publicOrigin:url.origin};
}

/** An opt-in listener for paired devices, on a LAN adapter or behind a local HTTPS tunnel connector. */
export class LanAccess {
 #retryTimer=null;#retryDelay=5000;
 #revision=0;#stopRevision=0;#handler;#publicPaths;#networkInterfaces;#serverFactory;#session=null;#queue=Promise.resolve();#closed=false;#pairing=null;#preference=null;#restoreError=null;#restoring=false;#monitor=null;#store;#networkIdentity;#networkSnapshot;#beforeListenerClose;#tunnel;
 constructor({handler,publicPaths=['/','/index.html'],networkInterfaces=os.networkInterfaces,serverFactory=listener=>http.createServer(listener),preferenceStore=null,networkIdentity=null,networkSnapshot=null,beforeListenerClose=null,tunnel=false}={}){
  if(typeof handler!=='function'||typeof networkInterfaces!=='function'||typeof serverFactory!=='function')throw new TypeError('LAN handler and providers must be functions');
  if(!Array.isArray(publicPaths)||publicPaths.some(value=>typeof value!=='string'||!value.startsWith('/')||/[?#]/.test(value)||value.startsWith('/api/')))throw new TypeError('LAN public paths must contain static paths only');
  this.#store=preferenceStore;this.#networkIdentity=networkIdentity;this.#networkSnapshot=networkSnapshot;this.#beforeListenerClose=beforeListenerClose;this.#tunnel=tunnel;
  this.#handler=handler;this.#publicPaths=new Set(publicPaths);this.#networkInterfaces=networkInterfaces;this.#serverFactory=serverFactory;
 }
 #addresses(){
  const found=new Map();
  for(const [name,entries] of Object.entries(this.#networkInterfaces()))for(const entry of entries||[]){
   if(entry.internal!==false||!['IPv4',4].includes(entry.family)||!privateV4(entry.address))continue;
   if(!found.has(entry.address))found.set(entry.address,{name,address:entry.address,family:'IPv4',adapters:new Map()});
   found.get(entry.address).adapters.set(name,{mac:entry.mac,netmask:entry.netmask});
  }
  return [...found.values()].sort((left,right)=>adapterPriority(left.name)-adapterPriority(right.name));
 }
 status(){
  const session=this.#session,enabled=!!session?.token;
  const preferred=enabled?session.listeners[0]:null;
  const endpoint={enabled,address:preferred?.address??null,port:preferred?.port??null,origin:preferred?.origin??null,url:preferred?`${preferred.origin}/#token=${session.token}`:null};
  if(this.#tunnel)return endpoint;
  const endpoints=enabled?session.listeners.map(({address,family,origin})=>({address,family,origin,url:`${origin}/#token=${session.token}`})):[];
  const addresses=this.#addresses().map(({name,address,family})=>({name,address,family}));
  return {...endpoint,mode:enabled?session.mode:null,endpoints,restoring:this.#restoring,retryScheduled:!!this.#retryTimer,persistent:!!this.#preference,persistenceAvailable:!!this.#store&&!!this.#networkIdentity,restoreError:this.#restoreError,addresses,transport:'http',encrypted:false};
 }
 #serial(run){const next=this.#queue.then(run,run);this.#queue=next.catch(()=>{});return next;}
 #invalidate(session=this.#session){
  if(!session)return;
  this.#pairing=null;
  session.token=null;
  for(const socket of session.sockets)socket.destroy();
 }
 #stop(){
  const session=this.#session;
  if(!session||session.closing)return session?.closing;
  this.#invalidate(session);
  session.stopping=true;
  clearInterval(this.#monitor);this.#monitor=null;
  session.closing=Promise.resolve().then(async()=>{
   if(!session.connectorStopped){
    await this.#beforeListenerClose?.();
    session.connectorStopped=true;
   }
   await this.#closeListeners(session);
   this.#session=null;
  }).finally(()=>{session.closing=null;});
  return session.closing;
 }
 async #closeListeners(session){
  // A connector may take time to exit. Reclaim connections accepted during that wait too.
  for(const socket of session.sockets)socket.destroy();
  const failures=await Promise.allSettled(session.listeners.map(({server})=>new Promise((resolve,reject)=>{
   server.close(error=>error&&error.code!=='ERR_SERVER_NOT_RUNNING'?reject(error):resolve());
  })));
  const failed=failures.find(result=>result.status==='rejected');
  if(failed)throw failed.reason;
 }
 enable(input={}){const stopRevision=this.#stopRevision;this.#revision++;return this.#serial(()=>this.#enable(input,null,this.#revision,stopRevision));}
 async #autoNetworks(candidates){
  if(!this.#networkSnapshot&&!this.#networkIdentity)return null;
  const names=[...new Set(candidates.flatMap(row=>[...row.adapters.keys()]))];
  try{
   const identities=this.#networkSnapshot?await this.#networkSnapshot(names):await Promise.all(names.map(name=>this.#networkIdentity(name)));
   if(!Array.isArray(identities)||identities.length!==names.length||!identities.every(id=>typeof id==='string'&&id.length>0))throw new Error('Missing network identity');
   return new Map(names.map((name,index)=>[name,identities[index]]));
  }catch{
   throw failure('无法确认当前网卡的网络身份。请检查网络，或选择单个可信地址。','LAN_NETWORK_UNVERIFIED',409);
  }
 }
 async #lanEndpoint(input,saved,revision){
   if(!plain(input)||Object.keys(input).some(key=>!['address','port','persistent','confirmed'].includes(key)))throw failure('局域网参数无效','LAN_INVALID_INPUT');
   const {address,port=0,persistent=address!=='auto'&&!!this.#store}=input;
   const mode=address==='auto'?'auto':'single';
   if(typeof persistent!=='boolean')throw failure('恢复设置无效','LAN_INVALID_INPUT');
   if(mode==='auto'&&persistent)throw failure('自动监听仅在本次运行中可用。请选择单个地址以保存可信网络配对。','LAN_PERSISTENCE_UNAVAILABLE',409);
   if(persistent&&(!this.#store||!this.#networkIdentity))throw failure('当前环境不支持安全保存局域网恢复设置','LAN_PERSISTENCE_UNAVAILABLE',409);
   if(persistent&&!saved&&input.confirmed!==true)throw failure('请确认仅在可信网络启动后恢复访问','LAN_CONFIRMATION_REQUIRED',409);
   const addresses=this.#addresses();
   const candidates=mode==='auto'?addresses:addresses.filter(row=>row.address===address);
   if(!candidates.length)throw failure('请选择当前可用的局域网地址','LAN_ADDRESS_UNAVAILABLE');
   if(!Number.isInteger(port)||port<0||port>65535)throw failure('局域网端口无效','LAN_INVALID_PORT');
   if(persistent&&candidates[0].adapters.size!==1)throw failure('多个网卡共用此地址，暂时无法确认可信网络','LAN_NETWORK_UNVERIFIED',409);
   const network=persistent?await this.#networkIdentity(candidates[0].name):null;
   if(saved&&revision!==this.#revision)throw failure('恢复已取消','LAN_RESTORE_CANCELLED',409);
   if(saved&&saved.network!==network)throw failure('网络已变化；未恢复局域网访问，请重新确认并配对','LAN_NETWORK_CHANGED',409);
   const networks=mode==='auto'?await this.#autoNetworks(candidates):null;
   return {candidates,mode,port,persistent,network,networks};
 }
 async #listen(session,candidate,port,publicOrigin){
   const endpoint={...candidate,port:null,origin:null,server:null};
   const server=this.#serverFactory((req,res)=>{this.#handle(req,res,session,endpoint).catch(()=>respond(res,500,'局域网请求处理失败'));});
   endpoint.server=server;session.listeners.push(endpoint);
   server.maxConnections=128;server.headersTimeout=15000;server.requestTimeout=120000;
   server.on('connection',socket=>{session.sockets.add(socket);socket.on('close',()=>session.sockets.delete(socket));});
   server.on('upgrade',(_req,socket)=>socket.destroy());
   server.on('connect',(_req,socket)=>socket.destroy());
   const listenerFailed=()=>{
    session.failed=true;
    if(this.#session!==session||session.stopping)return;
    this.#stopForRecovery('监听服务出现错误，访问已暂停。').catch(()=>{this.#restoreError='监听已停用，尚未完成关闭。请重试关闭访问。';});
   };
   server.on('error',listenerFailed);server.on('close',listenerFailed);
   await new Promise((resolve,reject)=>{
    const failed=error=>{server.off('listening',ready);reject(error);};
    const ready=()=>{server.off('error',failed);resolve();};
    server.once('error',failed);server.once('listening',ready);
    server.listen({host:candidate.address,port,exclusive:true});
   });
   endpoint.port=server.address().port;
   endpoint.origin=publicOrigin||new URL(`http://${candidate.address}:${endpoint.port}`).origin;
   return endpoint.port;
 }
 async #enable(input={},saved=null,revision=this.#revision,stopRevision=this.#stopRevision){
   const ensureCurrent=()=>{
    if(this.#closed)throw failure('应用正在关闭，不能开启远程访问','LAN_CLOSED',409);
    if(saved&&revision!==this.#revision)throw failure('恢复已取消','LAN_RESTORE_CANCELLED',409);
    if(stopRevision!==this.#stopRevision)throw failure('开启访问已取消','LAN_ENABLE_CANCELLED',409);
   };
   ensureCurrent();
   if(this.#session)throw failure('访问已开启，请先关闭或轮换链接','LAN_ALREADY_ENABLED',409);
   const {candidates,mode,port,publicOrigin,persistent,network,networks}=this.#tunnel?tunnelEndpoint(input):await this.#lanEndpoint(input,saved,revision);
   const session={mode,networks,token:null,sockets:new Set(),listeners:[],failed:false};
   const previousPreference=this.#preference;
   let wrotePreference=false;
   try{
    let listenPort=port;
    for(const candidate of candidates){
     ensureCurrent();
     listenPort=await this.#listen(session,candidate,listenPort,publicOrigin);
    }
    ensureCurrent();
    if(session.failed)throw new Error('LAN listener failed');
    const token=saved?.token||randomBytes(32).toString('hex');
    const preference=persistent?{version:1,address:candidates[0].address,port:listenPort,token,network}:null;
    if(this.#store&&!saved){await this.#store.write(preference);wrotePreference=true;}
    ensureCurrent();
    if(session.failed)throw new Error('LAN listener failed');
    session.token=token;
    this.#preference=preference;this.#restoreError=null;this.#session=session;
    this.#clearRetry();
    if(persistent||mode==='auto')this.#startMonitor(session);
    return this.status();
   }catch(error){
    if(this.#session===session)await this.#stop();
    else await this.#closeListeners(session);
    if(wrotePreference)await this.#store.write(previousPreference);
    this.#preference=previousPreference;
    if(error.code?.startsWith('LAN_'))throw error;
    throw failure(this.#tunnel?'无法监听本机回源端口，请检查端口是否已被占用。':mode==='auto'?'无法监听全部局域网地址或共用端口，请检查网卡和端口，或选择单个地址。':'无法监听所选局域网地址或端口','LAN_LISTEN_FAILED',503);
   }
 }
 #clearRetry(){
  clearTimeout(this.#retryTimer);this.#retryTimer=null;this.#retryDelay=5000;
 }
 #scheduleRestore(revision){
  if(revision!==this.#revision||this.#closed||this.#session||this.#retryTimer)return;
  this.#retryTimer=setTimeout(()=>{
   this.#retryTimer=null;
   void this.restore().catch(()=>{this.#scheduleRestore(revision);});
  },this.#retryDelay);
  this.#retryTimer.unref?.();
  this.#retryDelay=Math.min(this.#retryDelay*2,60000);
 }
 async #stopForRecovery(message){
  const revision=this.#revision;
  this.#restoreError=message;
  await this.#stop();
  if(this.#preference)this.#scheduleRestore(revision);
 }
 async restore(){const revision=this.#revision;return this.#serial(async()=>{
  if(revision!==this.#revision||!this.#store||this.#session||this.#closed)return this.status();
  this.#restoring=true;
  try{
   const saved=await this.#store.read();
   if(revision===this.#revision){
    this.#preference=saved;
    if(saved)await this.#enable({address:saved.address,port:saved.port,persistent:true},saved,revision);
    else {this.#clearRetry();this.#restoreError=null;}
   }
  }catch(error){
   if(revision===this.#revision){
    this.#restoreError=error.code==='LAN_NETWORK_CHANGED'?'等待原可信网络恢复。':error.code==='LAN_ADDRESS_UNAVAILABLE'?'等待原网络地址恢复。':error.code==='LAN_LISTEN_FAILED'?'等待原监听端口可用。':'等待重新核验已保存的局域网设置。';
    this.#scheduleRestore(revision);
   }
  }finally{this.#restoring=false;}
  return this.status();
 });}
 #startMonitor(session){
  clearInterval(this.#monitor);this.#monitor=setInterval(()=>{this.#serial(async()=>{
   if(session!==this.#session||!session.token)return;
   try{
    const current=this.#addresses();
    for(const bound of session.listeners){
     const same=current.find(row=>row.address===bound.address);
     // Binding an IPv4 address also serves other adapters assigned that same address.
     if(!same||same.adapters.size!==bound.adapters.size)throw new Error('address changed');
     for(const [name,adapter] of bound.adapters){
      const now=same.adapters.get(name);
      if(!now||now.mac!==adapter.mac||now.netmask!==adapter.netmask)throw new Error('adapter changed');
     }
    }
    if(session.networks){
     const next=await this.#autoNetworks(session.listeners);
     for(const [name,id] of session.networks)if(next.get(name)!==id)throw new Error('network changed');
    }else if(this.#preference){
     if(await this.#networkIdentity(session.listeners[0].name)!==this.#preference.network)throw new Error('network changed');
    }
   }catch{
    await this.#stopForRecovery(this.#preference?'网络暂时无法验证，等待原可信网络恢复。':'网络环境变化或无法验证，访问已关闭。请重新确认后开启。');
   }
  }).catch(()=>{});},15000);this.#monitor.unref?.();
 }
 pairing(input={}){
  const session=this.#session;
  if(!session?.token)throw failure('请先开启访问，再生成配对码','LAN_NOT_ENABLED',409);
  if(!plain(input)||Object.keys(input).some(key=>key!=='address'))throw failure('配对参数无效','LAN_INVALID_INPUT');
  const endpoint=input.address===undefined?session.listeners[0]:session.listeners.find(row=>row.address===input.address);
  if(!endpoint)throw failure('所选地址没有开启局域网访问','LAN_ADDRESS_UNAVAILABLE');
  const ticket=randomBytes(32).toString('hex'),expiresAt=Date.now()+120000;
  this.#pairing={ticket,expiresAt,origin:endpoint.origin};
  return {url:endpoint.origin+'/#pair='+ticket,expiresAt};
 }
 cancelPairing(){this.#pairing=null;return {cancelled:true};}
 rotate(){
  this.#invalidate();
  return this.#serial(async()=>{
   const session=this.#session;
   if(this.#closed||!session||session.stopping)throw failure('访问尚未开启','LAN_NOT_ENABLED',409);
   const token=randomBytes(32).toString('hex');
   try{if(this.#preference){const next={...this.#preference,token};await this.#store.write(next);this.#preference=next;}if(session.stopping)throw failure('访问已关闭','LAN_NOT_ENABLED',409);session.token=token;return this.status();}
   catch(error){await this.#stop();try{await this.#store?.write(null);this.#preference=null;}catch{}this.#restoreError='令牌轮换未能安全保存，当前访问已关闭。请成功关闭恢复设置后重新配对；未清除前旧配对可能在重启时恢复。';throw error;}
  });
 }
 disable(){this.#revision++;this.#stopRevision++;this.#clearRetry();this.#invalidate();return this.#serial(async()=>{await this.#stop();this.#clearRetry();try{await this.#store?.write(null);this.#preference=null;this.#restoreError=null;}catch(error){this.#restoreError='当前访问已关闭，但恢复设置清除失败；重启前请重试关闭。';throw error;}return this.status();});}
 close(){this.#revision++;this.#closed=true;this.#clearRetry();this.#invalidate();return this.#serial(async()=>{await this.#stop();return this.status();});}
 verifyRelayProof(nonce,proof){
  const token=this.#session?.token;
  if(!this.#tunnel||!token||!validNonce(nonce)||typeof proof!=='string'||!/^[a-f0-9]{64}$/.test(proof))return false;
  return timingSafeEqual(Buffer.from(proof,'hex'),Buffer.from(endpointProof(token,nonce,true),'hex'));
 }
 async #handlePairing(req,res,session,endpoint,prove){
  if(req.method!=='POST'||String(req.headers['content-type']||'').split(';',1)[0].trim().toLowerCase()!=='application/json'){respond(res,405,'配对需要 JSON POST');return;}
  const chunks=[];let length=0;
  for await(const chunk of req){
   length+=chunk.length;
   if(length>256){respond(res,413,'配对请求过大');return;}
   chunks.push(chunk);
  }
  if(this.#session!==session||!session.token){respond(res,503,'局域网访问已关闭');return;}
  let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{respond(res,400,'配对请求无效');return;}
  let result;
  if(prove){
   if(!plain(input)||Object.keys(input).length!==1||!validNonce(input.nonce)){respond(res,400,'配对请求无效');return;}
   result={proof:endpointProof(session.token,input.nonce,this.#tunnel)};
  }else{
   const pairing=this.#pairing;
   if(!plain(input)||Object.keys(input).length!==1||typeof input.ticket!=='string'||!pairing||pairing.origin!==endpoint.origin||pairing.expiresAt<=Date.now()||!/^[a-f0-9]{64}$/.test(input.ticket)||!timingSafeEqual(Buffer.from(input.ticket),Buffer.from(pairing.ticket))){respond(res,401,'二维码已失效，请在电脑上重新生成');return;}
   this.#pairing=null;
   result={token:session.token};
  }
  res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(JSON.stringify(result));
 }
 async #handle(req,res,session,endpoint){
  if(this.#closed||this.#session!==session||!session.token){respond(res,503,'局域网访问已关闭');return;}
  const counts=new Map();for(let index=0;index<req.rawHeaders.length;index+=2){const name=req.rawHeaders[index].toLowerCase();counts.set(name,(counts.get(name)||0)+1);}
  if(counts.get('host')!==1||(counts.get('origin')||0)>1||(counts.get('authorization')||0)>1){respond(res,400,'请求头无效');return;}
  const expectedHost=new URL(endpoint.origin).host;
  if(req.headers.host!==expectedHost||(req.headers.origin!==undefined&&req.headers.origin!==endpoint.origin)){respond(res,403,'拒绝外部来源');return;}
  if(typeof req.url!=='string'||!req.url.startsWith('/')||req.url.startsWith('//')){respond(res,400,'无效请求地址');return;}
  let url;try{url=new URL(req.url,endpoint.origin);}catch{respond(res,400,'无效请求地址');return;}
  if(url.origin!==endpoint.origin){respond(res,403,'拒绝外部来源');return;}
  if(url.hash||[...url.searchParams].some(([key,value])=>['token','access_token','authorization'].includes(key.toLowerCase())||value===session.token)){respond(res,400,'访问凭据只能通过 Authorization 请求头发送');return;}
  if(url.pathname==='/api/pairing/redeem'){
   await this.#handlePairing(req,res,session,endpoint,false);return;
  }
  if(url.pathname==='/api/pairing/prove'){
   if(url.search){respond(res,400,'配对请求无效');return;}
   await this.#handlePairing(req,res,session,endpoint,true);return;
  }
  if(forbidden(url.pathname)){respond(res,403,'此操作仅限本机窗口');return;}
  const publicRead=['GET','HEAD'].includes(req.method)&&this.#publicPaths.has(url.pathname);
  if(!publicRead){
   const auth=req.headers.authorization,expected=`Bearer ${session.token}`;
   if(typeof auth!=='string'||Buffer.byteLength(auth)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(auth),Buffer.from(expected))){respond(res,401,'局域网访问凭据已失效');return;}
  }
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
  await this.#handler(req,res,{origin:endpoint.origin,token:session.token,access:'lan'});
 }
}
