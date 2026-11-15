import {randomUUID} from 'node:crypto';
const uncertain=()=>Object.assign(new Error('Native storage result unavailable; operation outcome unknown'),{code:'STORAGE_NATIVE_FAILED',status:409,outcome:'unknown'});
const actions=new Set(['snapshot','apply','restore','inspectInstallSources']);
const fail=()=>Object.assign(new Error('Native storage host unavailable'),{code:'STORAGE_SAFE_DELETE_UNAVAILABLE',status:409,outcome:'notExecuted'});
// Only connected private child stdio can provide capability/replies. Never an HTTP endpoint.
export function createDesktopStorageBridge({send}={}){
 let enabled=false,closed=false;const pending=new Map();
 return {
  enable(value){enabled=value===true;},
  get available(){return enabled&&!closed;},
  execute(action,input){
   if(!enabled||closed||!actions.has(action))return Promise.reject(fail());
   if(pending.size)return Promise.reject(Object.assign(new Error('Native storage request pending'),{code:'STORAGE_BUSY',status:409,outcome:'notExecuted'}));
   return new Promise((resolve,reject)=>{const requestId=randomUUID();pending.set(requestId,{resolve,reject});try{send({type:'storage',requestId,action,input});}catch(e){pending.delete(requestId);reject(e);}});
  },
  receive(message){
   if(message?.action!=='storageResult')return false;
   if(Object.keys(message).sort().join(',')!=='action,error,requestId,result'||typeof message.requestId!=='string'||!pending.has(message.requestId)||!(message.error===null||typeof message.error==='string'))throw new Error('Invalid native storage reply');
   const p=pending.get(message.requestId);pending.delete(message.requestId);
   if(message.error!==null)p.reject(Object.assign(new Error(message.error),{code:'STORAGE_NATIVE_FAILED',status:409,outcome:'unknown'}));else if(!message.result||typeof message.result!=='object'||Array.isArray(message.result))p.reject(uncertain());else p.resolve(message.result);
   return true;
  },
  close(){closed=true;for(const p of pending.values())p.reject(uncertain());pending.clear();}
 };
}
