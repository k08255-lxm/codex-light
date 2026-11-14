import http from 'node:http';
import os from 'node:os';
import {isIP} from 'node:net';
import {randomBytes,timingSafeEqual} from 'node:crypto';

const localOnly=['/api/lan','/api/shutdown','/api/reopen','/api/desktop','/api/runtime'];
const failure=(message,code,status=400)=>Object.assign(new Error(message),{code,status,outcome:'notExecuted'});
const privateV4=address=>{
 if(isIP(address)!==4)return false;
 const [a,b]=address.split('.').map(Number);
 return a===10||(a===172&&b>=16&&b<=31)||(a===192&&b===168);
};
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const forbidden=pathname=>localOnly.some(prefix=>pathname===prefix||pathname.startsWith(prefix+'/'));
function respond(res,status,message){
 if(res.destroyed||res.writableEnded)return;
 if(res.headersSent){res.destroy();return;}
 res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
 res.end(JSON.stringify({error:message}));
}

/** An opt-in second listener for the same application handler, never a proxy. */
export class LanAccess {
 #revision=0;#handler;#publicPaths;#networkInterfaces;#serverFactory;#session=null;#queue=Promise.resolve();#closed=false;#pairing=null;#preference=null;#restoreError=null;#restoring=false;#monitor=null;#store;#networkIdentity;
 constructor({handler,publicPaths=['/','/index.html'],networkInterfaces=os.networkInterfaces,serverFactory=listener=>http.createServer(listener),preferenceStore=null,networkIdentity=null}={}){
  if(typeof handler!=='function'||typeof networkInterfaces!=='function'||typeof serverFactory!=='function')throw new TypeError('LAN handler and providers must be functions');
  if(!Array.isArray(publicPaths)||publicPaths.some(value=>typeof value!=='string'||!value.startsWith('/')||/[?#]/.test(value)||value.startsWith('/api/')))throw new TypeError('LAN public paths must contain static paths only');
  this.#store=preferenceStore;this.#networkIdentity=networkIdentity;
  this.#handler=handler;this.#publicPaths=new Set(publicPaths);this.#networkInterfaces=networkInterfaces;this.#serverFactory=serverFactory;
 }
 #addresses(){
  const found=new Map();
  for(const [name,entries] of Object.entries(this.#networkInterfaces()))for(const entry of entries||[]){
   if(entry.internal!==false||!['IPv4',4].includes(entry.family)||!privateV4(entry.address))continue;
   if(!found.has(entry.address))found.set(entry.address,{name,address:entry.address,family:'IPv4'});
  }
  return [...found.values()];
 }
 status(){
  const session=this.#session,enabled=!!session?.token;
  return {enabled,restoring:this.#restoring,persistent:!!this.#preference,persistenceAvailable:!!this.#store&&!!this.#networkIdentity,restoreError:this.#restoreError,addresses:this.#addresses(),address:enabled?session.address:null,port:enabled?session.port:null,origin:enabled?session.origin:null,url:enabled?`${session.origin}/#token=${session.token}`:null,transport:'http',encrypted:false};
 }
 #serial(run){const next=this.#queue.then(run,run);this.#queue=next.catch(()=>{});return next;}
 #invalidate(session=this.#session){
  if(!session)return;
  this.#pairing=null;
  session.token=null;
  for(const socket of session.sockets)socket.destroy();
 }
 async #stop(){
  const session=this.#session;if(!session)return;
  this.#session=null;this.#invalidate(session);
  await new Promise((resolve,reject)=>{
   // Stop accepting first; tracked sockets also include SSE/upgrade connections.
   session.server.close(error=>error&&error.code!=='ERR_SERVER_NOT_RUNNING'?reject(error):resolve());
   for(const socket of session.sockets)socket.destroy();
  });
 }
 enable(input={}){this.#revision++;return this.#serial(()=>this.#enable(input));}
 async #enable(input={},saved=null,revision=this.#revision){
   if(this.#closed)throw failure('应用正在关闭，不能开启局域网访问','LAN_CLOSED',409);
   if(!plain(input)||Object.keys(input).some(key=>!['address','port','persistent','confirmed'].includes(key)))throw failure('局域网参数无效','LAN_INVALID_INPUT');
   const {address,port=0,persistent=!!this.#store}=input;
   if(typeof persistent!=='boolean')throw failure('恢复设置无效','LAN_INVALID_INPUT');
   if(persistent&&(!this.#store||!this.#networkIdentity))throw failure('当前环境不支持安全保存局域网恢复设置','LAN_PERSISTENCE_UNAVAILABLE',409);
   if(persistent&&!saved&&input.confirmed!==true)throw failure('请确认仅在可信网络启动后恢复访问','LAN_CONFIRMATION_REQUIRED',409);
   if(typeof address!=='string'||!this.#addresses().some(entry=>entry.address===address))throw failure('请选择当前可用的局域网 IPv4 地址','LAN_ADDRESS_UNAVAILABLE');
   if(!Number.isInteger(port)||port<0||port>65535)throw failure('局域网端口无效','LAN_INVALID_PORT');
   if(this.#session)throw failure('局域网访问已开启，请先关闭或轮换链接','LAN_ALREADY_ENABLED',409);
   const candidate=this.#addresses().find(row=>row.address===address);
   const network=persistent?await this.#networkIdentity(candidate.name):null;
   if(saved&&revision!==this.#revision)throw failure('恢复已取消','LAN_RESTORE_CANCELLED',409);
   if(saved&&saved.network!==network)throw failure('网络已变化；未恢复局域网访问，请重新确认并配对','LAN_NETWORK_CHANGED',409);
   const session={address,port:null,origin:null,token:null,sockets:new Set(),server:null};
   const server=this.#serverFactory((req,res)=>{this.#handle(req,res,session).catch(()=>respond(res,500,'局域网请求处理失败'));});
   session.server=server;server.maxConnections=128;server.headersTimeout=15000;server.requestTimeout=120000;
   server.on('connection',socket=>{session.sockets.add(socket);socket.on('close',()=>session.sockets.delete(socket));});
   server.on('upgrade',(_req,socket)=>socket.destroy());
   server.on('connect',(_req,socket)=>socket.destroy());
   // A runtime listener error must not leave a valid capability behind.
   server.on('error',()=>{if(this.#session===session){this.#invalidate(session);this.#session=null;this.#restoreError='监听服务出现错误，已停止访问；开启设置保持不变，请重试恢复。';clearInterval(this.#monitor);this.#monitor=null;if(server.listening)server.close();}});
   try{
    await new Promise((resolve,reject)=>{
     const failed=error=>{server.off('listening',ready);reject(error);};
     const ready=()=>{server.off('error',failed);resolve();};
     server.once('error',failed);server.once('listening',ready);
     server.listen({host:address,port,exclusive:true});
    });
    if(saved&&revision!==this.#revision)throw failure('恢复已取消','LAN_RESTORE_CANCELLED',409);
    if(this.#closed){await new Promise(resolve=>server.close(resolve));throw failure('应用正在关闭，不能开启局域网访问','LAN_CLOSED',409);}
    session.port=server.address().port;session.origin=new URL(`http://${address}:${session.port}`).origin;session.token=saved?.token||randomBytes(32).toString('hex');
    const preference=persistent?{version:1,address,port:session.port,token:session.token,network}:null;
    if(this.#store&&!saved)await this.#store.write(preference);
    this.#preference=preference;this.#restoreError=null;this.#session=session;
    if(persistent)this.#startMonitor();
    return this.status();
   }catch(error){
    for(const socket of session.sockets)socket.destroy();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    if(error.code==='LAN_CLOSED')throw error;
    if(error.code?.startsWith('LAN_'))throw error;
    throw failure('无法监听所选局域网地址或端口','LAN_LISTEN_FAILED',503);
   }
 }
 async restore(){const revision=this.#revision;return this.#serial(async()=>{
  if(!this.#store||this.#session||this.#closed)return this.status();
  this.#restoring=true;
  try{
   const saved=await this.#store.read();
   if(revision===this.#revision){this.#preference=saved;if(saved)await this.#enable({address:saved.address,port:saved.port,persistent:true},saved,revision);}
  }catch(error){
   if(error.code!=='LAN_RESTORE_CANCELLED')this.#restoreError=error.code==='LAN_NETWORK_CHANGED'?'网络已变化，未自动恢复。请在可信网络重新启用并配对。':error.code==='LAN_ADDRESS_UNAVAILABLE'?'原网络地址不可用，未自动恢复。请重新选择网络地址。':error.code==='LAN_LISTEN_FAILED'?'原端口不可用，未自动更换端口。请释放端口或重新配对。':'安全恢复失败，未开启访问；请重新确认设置。';
  }finally{this.#restoring=false;}
  return this.status();
 });}
 #startMonitor(){
  clearInterval(this.#monitor);this.#monitor=setInterval(()=>{this.#serial(async()=>{
   if(!this.#session||!this.#preference)return;
   try{const row=this.#addresses().find(x=>x.address===this.#preference.address);if(!row||await this.#networkIdentity(row.name)!==this.#preference.network)throw new Error('changed');}
   catch{await this.#stop();this.#restoreError='网络环境变化或无法验证，访问已关闭。请重新确认后恢复。';clearInterval(this.#monitor);this.#monitor=null;}
  }).catch(()=>{});},15000);this.#monitor.unref?.();
 }
 pairing(){
  const session=this.#session;
  if(!session?.token)throw failure('请先开启局域网访问','LAN_NOT_ENABLED',409);
  const ticket=randomBytes(32).toString('hex'),expiresAt=Date.now()+120000;
  this.#pairing={ticket,expiresAt};
  return {url:session.origin+'/#pair='+ticket,expiresAt};
 }
 cancelPairing(){this.#pairing=null;return {cancelled:true};}
 rotate(){
  this.#invalidate();
  return this.#serial(async()=>{
   if(this.#closed||!this.#session)throw failure('局域网访问尚未开启','LAN_NOT_ENABLED',409);
   const token=randomBytes(32).toString('hex');
   try{if(this.#preference){const next={...this.#preference,token};await this.#store.write(next);this.#preference=next;}this.#session.token=token;return this.status();}
   catch(error){await this.#stop();try{await this.#store?.write(null);this.#preference=null;}catch{}this.#restoreError='令牌轮换未能安全保存，当前访问已关闭。请成功关闭恢复设置后重新配对；未清除前旧配对可能在重启时恢复。';throw error;}
  });
 }
 disable(){this.#revision++;this.#invalidate();return this.#serial(async()=>{clearInterval(this.#monitor);this.#monitor=null;await this.#stop();try{await this.#store?.write(null);this.#preference=null;this.#restoreError=null;}catch(error){this.#restoreError='当前访问已关闭，但恢复设置清除失败；重启前请重试关闭。';throw error;}return this.status();});}
 close(){this.#revision++;this.#closed=true;this.#invalidate();return this.#serial(async()=>{clearInterval(this.#monitor);this.#monitor=null;await this.#stop();return this.status();});}
 async #handle(req,res,session){
  if(this.#closed||this.#session!==session||!session.token){respond(res,503,'局域网访问已关闭');return;}
  const counts=new Map();for(let index=0;index<req.rawHeaders.length;index+=2){const name=req.rawHeaders[index].toLowerCase();counts.set(name,(counts.get(name)||0)+1);}
  if(counts.get('host')!==1||(counts.get('origin')||0)>1||(counts.get('authorization')||0)>1){respond(res,400,'请求头无效');return;}
  const expectedHost=new URL(session.origin).host;
  if(req.headers.host!==expectedHost||(req.headers.origin!==undefined&&req.headers.origin!==session.origin)){respond(res,403,'拒绝外部来源');return;}
  if(typeof req.url!=='string'||!req.url.startsWith('/')||req.url.startsWith('//')){respond(res,400,'无效请求地址');return;}
  let url;try{url=new URL(req.url,session.origin);}catch{respond(res,400,'无效请求地址');return;}
  if(url.origin!==session.origin){respond(res,403,'拒绝外部来源');return;}
  if(url.hash||[...url.searchParams].some(([key,value])=>['token','access_token','authorization'].includes(key.toLowerCase())||value===session.token)){respond(res,400,'访问凭据只能通过 Authorization 请求头发送');return;}
  if(url.pathname==='/api/pairing/redeem'){
   if(req.method!=='POST'||!String(req.headers['content-type']||'').startsWith('application/json')){respond(res,405,'配对需要 JSON POST');return;}
   let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>256){respond(res,413,'配对请求过大');return;}}
   let input;try{input=JSON.parse(raw);}catch{respond(res,400,'配对请求无效');return;}
   const pairing=this.#pairing;
   if(!plain(input)||Object.keys(input).length!==1||typeof input.ticket!=='string'||!pairing||pairing.expiresAt<=Date.now()||!/^[a-f0-9]{64}$/.test(input.ticket)||!timingSafeEqual(Buffer.from(input.ticket),Buffer.from(pairing.ticket))){respond(res,401,'二维码已失效，请在电脑上重新生成');return;}
   this.#pairing=null;
   res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end(JSON.stringify({token:session.token}));return;
  }
  if(forbidden(url.pathname)){respond(res,403,'此操作仅限本机窗口');return;}
  const publicRead=['GET','HEAD'].includes(req.method)&&this.#publicPaths.has(url.pathname);
  if(!publicRead){
   const auth=req.headers.authorization,expected=`Bearer ${session.token}`;
   if(typeof auth!=='string'||Buffer.byteLength(auth)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(auth),Buffer.from(expected))){respond(res,401,'局域网访问凭据已失效');return;}
  }
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
  await this.#handler(req,res,{origin:session.origin,token:session.token,access:'lan'});
 }
}
