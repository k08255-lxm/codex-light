import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {createLoginState,MAX_DISTINCT_LOGIN_IDS} from './account-login-state.mjs';
const alias=id=>createHash('sha256').update(id,'utf8').digest('hex');
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,allowed)=>{if(!object(x)||Object.keys(x).some(k=>!allowed.includes(k)))throw new Error('账号操作参数无效');};
const validId=x=>typeof x==='string'&&x.length>0&&x.length<=256&&!/[\x00-\x1f\x7f]/.test(x);
function official(value){if(typeof value!=='string'||value.length>16384)throw new Error('登录地址需复核，未打开');let url;try{url=new URL(value);}catch{throw new Error('登录地址需复核，未打开');}if(url.protocol!=='https:'||!['auth.openai.com','chatgpt.com'].includes(url.hostname)||url.username||url.password||url.port)throw new Error('登录地址需复核，未打开');return url.href;}
export class AccountLoginService extends EventEmitter{
 constructor(rpc){super();this.rpc=rpc;this.current=null;this.pending=null;this.generation=0;this.state='idle';this.closed=false;this.loginState=createLoginState();this.acceptedCount=0;this.early=[];}
 publish(state,extra={}){this.state=state;const event={method:'bridge/accountLogin',params:{state,...extra}};this.emit('event',event);return event.params;}
 snapshot(){return {state:this.state,loginId:this.current};}
 async cancelOwned(id){try{const result=await this.rpc.call('account/login/cancel',{loginId:id});if(!['canceled','notFound'].includes(result?.status))throw new Error();const state=this.loginState.snapshot();if(state.status==='pending'&&state.loginId===alias(id))this.loginState.cancel(alias(id));return result;}catch{throw new Error('无法确认登录已取消；请在官方登录页面停止操作并重新检查账号状态');}}
 async start(input){exact(input,['type']);if(!['chatgpt','chatgptDeviceCode'].includes(input.type))throw new Error('只支持官方网页登录或设备码登录');if(this.closed||this.pending||this.current||!['idle','completed','failed','canceled','loggedOut'].includes(this.state))throw new Error('已有账号操作进行中或结果未知，不能重复开始');if(this.acceptedCount>=MAX_DISTINCT_LOGIN_IDS)throw new Error('本次会话登录操作已达上限，请关闭后重新检查');
  const generation=++this.generation;this.publish('starting');this.early=[];
  const task=(async()=>{
   let result;try{result=await this.rpc.call('account/login/start',{type:input.type});}catch{if(generation===this.generation)this.publish('unknown');throw new Error('登录请求结果未知；不会自动重试，请检查官方账号状态');}
   const id=result?.loginId;
   if(this.closed||generation!==this.generation){if(validId(id))await this.cancelOwned(id);throw new Error('此登录操作已中断，未打开登录页面');}
   if(!validId(id)){this.publish('unknown');throw new Error('官方登录响应格式无效，需检查账号状态');}
   try{this.loginState.begin(alias(id));this.acceptedCount++;}catch{this.publish('unknown');await this.cancelOwned(id);throw new Error('登录标识重复或状态不可复用，已请求取消；需重新检查账号状态');}
   let output;try{
    if(result.type!==input.type)throw new Error();
    if(input.type==='chatgpt')output={type:result.type,loginId:id,authUrl:official(result.authUrl)};
    else{if(typeof result.userCode!=='string'||!result.userCode||result.userCode.length>128||/[\x00-\x1f\x7f]/.test(result.userCode))throw new Error();output={type:result.type,loginId:id,verificationUrl:official(result.verificationUrl),userCode:result.userCode};}
   }catch{try{await this.cancelOwned(id);}catch{}this.publish('unknown');throw new Error('官方登录地址或响应需复核；未打开链接，已请求取消');}
   this.current=id;this.publish('waiting',{loginId:id});const early=this.early.find(event=>event.loginId===id);this.early=[];if(early)this.completed(early);return output;
  })();this.pending=task;try{return await task;}finally{if(this.pending===task)this.pending=null;}
 }
 completed(params){if(!object(params)||!validId(params.loginId)||typeof params.success!=='boolean')return;if(params.loginId!==this.current||this.state!=='waiting')return;try{this.loginState.complete({loginId:alias(params.loginId),success:params.success});}catch{this.current=null;this.publish('unknown');return;}this.current=null;this.publish(params.success?'completed':'failed',{loginId:params.loginId,...(!params.success?{error:'官方登录未完成，请重新检查账号状态'}:{})});}
 observe(event){if(event.method!=='account/login/completed')return;const p=event.params;if(this.state==='starting'&&object(p)&&validId(p.loginId)&&typeof p.success==='boolean'){if(this.early.length<32)this.early.push({loginId:p.loginId,success:p.success});return;}this.completed(p);}
 async cancel(input){exact(input,['loginId']);if(!validId(input.loginId)||input.loginId!==this.current||this.state!=='waiting')throw new Error('只能取消本界面当前未完成的登录');const id=this.current;this.current=null;++this.generation;this.publish('canceling');try{const result=await this.cancelOwned(id);if(!this.closed)this.publish('canceled');return result;}catch(error){if(!this.closed)this.publish('unknown');throw error;}}
 async logout(input){exact(input,['confirmed']);if(input.confirmed!==true)throw new Error('退出会影响共享 CODEX_HOME 的 CLI 与桌面端登录；必须明确确认');if(this.closed||this.state==='loggingOut')throw new Error('账号操作不可用');++this.generation;const id=this.current;this.current=null;this.early=[];this.publish('loggingOut');try{if(this.pending)await this.pending.catch(()=>{});if(id)await this.cancelOwned(id);await this.rpc.call('account/logout',{});this.loginState.reset();if(!this.closed)this.publish('loggedOut');return {loggedOut:true};}catch{if(!this.closed)this.publish('unknown');throw new Error('退出结果未知，请重新检查共享账号状态；不会自动重试');}}
 async close(){if(this.closed)return;this.closed=true;++this.generation;const id=this.current;this.current=null;this.early=[];if(id)await this.cancelOwned(id).catch(()=>{});if(this.pending)await this.pending.catch(()=>{});this.loginState.reset();this.publish('closed');}
}
