import {randomUUID} from 'node:crypto';
import {isAbsolute} from 'node:path';

const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const fail=(message,outcome='unknown')=>Object.assign(new Error(message),{code:'APP_UPDATE_NATIVE_LAUNCH',outcome});

/** One private native launch acknowledgement. Timeout never grants permission to launch again. */
export function createDesktopInstallerBridge({send,timeoutMs=30000}={}){
 let pending=null,closed=false,uncertain=false;
 return {
  launch(file,{sha256}){
   if(closed||pending||uncertain)throw fail('已有安装启动操作待确认，不能重复启动',uncertain?'unknown':'notExecuted');
   if(typeof file!=='string'||file.length<1||file.length>4096||file.includes('\0')||!isAbsolute(file)||!/^[a-f0-9]{64}$/.test(sha256||''))throw fail('安装程序路径或校验信息无效','notExecuted');
   return new Promise((resolve,reject)=>{
    const requestId=randomUUID();const timeout=setTimeout(()=>{if(pending){pending.expired=true;uncertain=true;reject(fail('安装程序启动结果确认超时，请人工核对；不会重试'));}},timeoutMs);
    pending={requestId,resolve,reject,timeout,expired:false};
    try{send({type:'launchInstaller',requestId,path:file,sha256});}catch{clearTimeout(timeout);pending=null;uncertain=true;reject(fail('安装请求未能写入桌面通信通道'));}
   });
  },
  receive(message){
   if(message?.action!=='installerLaunched')return false;
   if(!message||typeof message!=='object'||Array.isArray(message)||Object.keys(message).sort().join(',')!=='action,error,requestId'||!uuid(message.requestId)||!pending||message.requestId!==pending.requestId||![null,'APP_UPDATE_NOT_EXECUTED','APP_UPDATE_LAUNCH_UNKNOWN'].includes(message.error))throw new Error('Invalid native installer acknowledgement');
   const current=pending;pending=null;clearTimeout(current.timeout);
   if(message.error==='APP_UPDATE_LAUNCH_UNKNOWN')uncertain=true;
   if(!current.expired){if(message.error===null)current.resolve();else current.reject(fail(message.error==='APP_UPDATE_NOT_EXECUTED'?'桌面宿主未能启动安装程序，请检查文件及权限。':'安装程序启动结果待核对；不会重复启动。',message.error==='APP_UPDATE_NOT_EXECUTED'?'notExecuted':'unknown'));}
   return true;
  },
  close(){closed=true;if(pending){const current=pending;pending=null;clearTimeout(current.timeout);current.reject(fail('桌面通信已关闭，安装程序启动结果待核对'));}},
 };
}
