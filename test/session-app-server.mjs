// Synthetic peer: its locks exist only under the test-owned temporary root.
import readline from 'node:readline';
import {openSync,closeSync,unlinkSync} from 'node:fs';
import path from 'node:path';
const root=process.argv[2],owned=new Map(),calls=[];
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
function release(id){const lock=owned.get(id);if(!lock)return false;closeSync(lock.fd);unlinkSync(lock.path);owned.delete(id);return true;}
const lines=readline.createInterface({input:process.stdin});
lines.on('line',line=>{
 const m=JSON.parse(line),p=m.params||{};if(m.id===undefined)return;
 const reply=result=>send({id:m.id,result});const error=(code,message)=>send({id:m.id,error:{code,message}});
 calls.push({method:m.method,params:p});
 if(m.method==='initialize'){reply({userAgent:'synthetic-session-peer'});return;}
 if(m.method==='test/stats'){reply({calls,owned:[...owned.keys()]});return;}
 if(m.method==='thread/read'){reply({thread:{id:p.threadId,turns:[],status:{type:'idle'}}});return;}
 if(m.method==='thread/items/list'){reply({data:[],nextCursor:null});return;}
 if(m.method==='thread/resume'){
  if(!owned.has(p.threadId)){
   const target=path.join(root,encodeURIComponent(p.threadId)+'.synthetic-lock');
   try{owned.set(p.threadId,{path:target,fd:openSync(target,'wx'),active:null});}catch(e){error(-32001,'Synthetic thread is owned by another client');return;}
  }
  reply({thread:{id:p.threadId,turns:[]}});return;
 }
 if(m.method==='thread/unsubscribe'){reply({status:release(p.threadId)?'unsubscribed':'notSubscribed'});return;}
 if(m.method==='thread/loaded/list'){reply({data:[...owned.keys()],nextCursor:null});return;}
 if(m.method==='turn/start'){
  const e=owned.get(p.threadId);if(!e){error(-32600,'Not resumed');return;}
  if(e.active){error(-32600,'Already active');return;}
  e.active='turn-'+calls.filter(c=>c.method==='turn/start').length;
  const turn={id:e.active,status:'inProgress'};
  send({method:'turn/started',params:{threadId:p.threadId,turn}});reply({turn});return;
 }
 if(m.method==='turn/steer'){
  const e=owned.get(p.threadId);if(e?.active!==p.expectedTurnId){error(-32602,'Wrong expected turn');return;}
  if(p.input.some(i=>i.type==='text'&&i.text==='synthetic-timeout'))return;
  reply({turnId:e.active});return;
 }
 if(m.method==='test/complete'){
  const e=owned.get(p.threadId);const turn={id:e?.active,status:'completed'};if(e)e.active=null;
  send({method:'turn/completed',params:{threadId:p.threadId,turn}});reply({});return;
 }
 error(-32601,'Unsupported synthetic method');
});
lines.on('close',()=>{for(const id of [...owned.keys()])release(id);});
