import {readFileSync,lstatSync,mkdirSync,openSync,writeFileSync,fsyncSync,closeSync,linkSync,unlinkSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {createHmac,createHash,randomUUID,timingSafeEqual} from 'node:crypto';
const identity=value=>typeof value==='string'&&/^[A-Za-z0-9._:-]{1,256}$/.test(value);
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
function descriptorValid(value){return plain(value)&&value.version===1&&identity(value.bindingId)&&identity(value.targetIdentity)&&typeof value.key==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value.key)&&Buffer.from(value.key,'base64url').length===32;}
export function readQueueDescriptor(file){const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw Error('Invalid callback queue descriptor');const value=JSON.parse(readFileSync(file,'utf8'));if(!descriptorValid(value))throw Error('Invalid callback queue binding');return value;}
export function callbackEventId({bindingId,threadId,taskId,generationId,eventType}){return createHash('sha256').update(JSON.stringify([bindingId,threadId,taskId,generationId,eventType])).digest('hex');}
function signature(payload,descriptor){return createHmac('sha256',Buffer.from(descriptor.key,'base64url')).update(JSON.stringify(payload)).digest('hex');}
export function verifyQueueEnvelope(value,descriptor){
 if(!descriptorValid(descriptor)||!plain(value)||Object.keys(value).sort().join(',')!=='payload,signature'||!plain(value.payload)||typeof value.signature!=='string'||! /^[a-f0-9]{64}$/.test(value.signature))throw Error('Invalid callback event');
 const p=value.payload;
 if(p.version!==1||p.bindingId!==descriptor.bindingId||p.targetIdentity!==descriptor.targetIdentity||!['watch','completion','cancel'].includes(p.eventType)||![p.threadId,p.taskId,p.generationId].every(identity)||typeof p.createdAt!=='string'||!Number.isFinite(Date.parse(p.createdAt))||p.eventId!==callbackEventId(p)||Object.keys(p).some(k=>!['version','bindingId','targetIdentity','eventId','eventType','threadId','taskId','generationId','createdAt','output'].includes(k))||JSON.stringify(p).length>48000)throw Error('Invalid callback event binding');
 if(!timingSafeEqual(Buffer.from(value.signature,'hex'),Buffer.from(signature(p,descriptor),'hex')))throw Error('Invalid callback authentication');
 if(p.eventType==='completion'&&!plain(p.output))throw Error('Missing callback completion');
 return p;
}
function boundedOutput(value,taskId){
 if(!plain(value))throw Error('Invalid callback output');const output={agent_id:taskId};
 for(const key of ['name','status','finish_reason','wait_outcome','next_action','answer','last_completed_answer','error','result_path'])if(typeof value[key]==='string')output[key]=value[key].slice(0,key==='answer'||key==='last_completed_answer'?8000:4096);
 return output;
}
export function queueCallbackEvent(file,{eventType,threadId,taskId,generationId,output}={}){
 const descriptor=readQueueDescriptor(file);
 if(!['watch','completion','cancel'].includes(eventType)||![threadId,taskId,generationId].every(identity))throw Error('Invalid callback event identity');
 const payload={version:1,bindingId:descriptor.bindingId,targetIdentity:descriptor.targetIdentity,eventType,threadId,taskId,generationId,createdAt:new Date().toISOString()};payload.eventId=callbackEventId(payload);
 if(eventType==='completion')payload.output=boundedOutput(output,taskId);
 const envelope={payload,signature:signature(payload,descriptor)};
 const directory=join(dirname(file),'events');mkdirSync(directory,{recursive:true,mode:0o700});const stat=lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Invalid callback queue directory');
 const destination=join(directory,payload.eventId+'.json');
 try{const existing=verifyQueueEnvelope(JSON.parse(readFileSync(destination,'utf8')),descriptor);if(existing.eventId===payload.eventId)return {eventId:payload.eventId,status:'already_queued'};}catch(error){if(error.code!=='ENOENT')throw error;}
 const temporary=join(directory,'.'+randomUUID()+'.pending');let fd;
 try{
  fd=openSync(temporary,'wx',0o600);writeFileSync(fd,JSON.stringify(envelope)+'\n');fsyncSync(fd);closeSync(fd);fd=undefined;
  // Exclusive publication: no reader can see a partially written event and a
  // duplicate watcher cannot overwrite the original delivery identity.
  try{linkSync(temporary,destination);}catch(error){if(error.code!=='EEXIST')throw error;verifyQueueEnvelope(JSON.parse(readFileSync(destination,'utf8')),descriptor);return {eventId:payload.eventId,status:'already_queued'};}
  return {eventId:payload.eventId,status:'queued'};
 }finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(temporary);}catch{}}
}
