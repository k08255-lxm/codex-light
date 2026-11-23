import {dshLifecycleEvent,dshStatusSnapshot,dshToolResultParentThreadId,isDshTerminalStatus} from '../public/dsh.js';

// Only a live dispatch identifies an owned child. History can describe a run
// that finished months ago. A detached child is rechecked through the same
// read-only MCP path as the task inspector while it is the reason to stay awake.
export class DesktopSleep {
 constructor({apply,readDsh,sessions,streams,intervalMs=15000}){
  Object.assign(this,{apply,readDsh,sessions,streams,intervalMs});
  this.children=new Map();
  this.requested=false;
 }
 configure(preferences){this.preferences=preferences;this.update();}
 observeChild(threadId,item){
  const event=dshLifecycleEvent(item);
  if(!event)return;
  const parent=dshToolResultParentThreadId(item.result);
  if(parent&&parent!==threadId)return;
  if(event.kind==='started'){
   if(!this.sessions.entries.has(threadId))return;
   this.children.delete(event.id);
   this.children.set(event.id,{threadId,id:event.id,active:true,checkedAt:Date.now(),misses:0});
   // Keep the same bound as the DSH provenance store while monitoring is off.
   if(this.children.size>500)this.children.delete(this.children.keys().next().value);
  }else if(this.children.get(event.id)?.threadId===threadId)this.children.delete(event.id);
  this.update();
 }
 clearChildren(){this.children.clear();this.update();}
 update(){
  if(!this.apply||this.closed)return;
  const task=this.preferences?.keepAwakeDuringTask===true;
  const activeTurn=task&&this.sessions.snapshot().threads.some(t=>t.activeTurnId);
  const remote=this.preferences?.keepAwakeDuringRemote&&[...this.streams.values()].includes('lan');
  const monitor=task&&!activeTurn&&this.children.size>0;
  if(monitor&&!this.timer){
   this.timer=setInterval(()=>{this.update();void this.poll();},this.intervalMs);
   this.timer.unref();
   queueMicrotask(()=>this.poll());
  }else if(!monitor&&this.timer){clearInterval(this.timer);this.timer=null;}
  const recent=Date.now()-this.intervalMs*2;
  const child=monitor&&[...this.children.values()].some(c=>c.active&&c.checkedAt>=recent);
  const requested=Boolean(activeTurn||remote||child);
  if(this.requested!==requested){this.requested=requested;this.apply(requested);}
 }
 async poll(){
  if(!this.timer||this.polling)return;
  this.polling=true;
  try{
   for(const child of [...this.children.values()]){
    if(!this.timer)break;
    if(this.children.get(child.id)!==child)continue;
    let status;
    try{status=dshStatusSnapshot((await this.readDsh(child.threadId,child.id)).result).status;}
    catch{status='unavailable';}
    if(this.children.get(child.id)!==child)continue;
    child.active=['starting','running','interrupting'].includes(status);
    child.misses=child.active?0:child.misses+1;
    if(isDshTerminalStatus(status)||child.misses>=3){this.children.delete(child.id);continue;}
    child.checkedAt=Date.now();
   }
  }finally{this.polling=false;this.update();}
 }
 close(){
  this.closed=true;clearInterval(this.timer);this.timer=null;this.children.clear();
  if(this.requested){this.requested=false;this.apply(false);}
 }
}
