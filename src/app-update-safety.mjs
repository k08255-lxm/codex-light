// An application update is not permission to interrupt model, terminal or DSH work.
const blocked=()=>Object.assign(new Error('仍有运行任务、待审批或结果未确认，更新未执行。请先完成这些任务。'),{code:'APP_UPDATE_WORK_ACTIVE',outcome:'notExecuted',status:409});
export function assertUpdateIdle({rpc,sessions,terminal,dsh,operations,runtime,requestId}={}){
 if(!rpc||!sessions||!terminal||!dsh||!operations||!runtime)throw blocked();
 if(rpc.connected!==true||runtime.busy({requestId})||rpc.requests?.size||sessions.queues?.size||dsh.pending?.size||dsh.releaseError)throw blocked();
 if(sessions.snapshot().threads.some(t=>t.state!=='idle'||t.releaseError))throw blocked();
 for(const s of terminal.sessions.values())if(!['exited','error','disconnected'].includes(s.state))throw blocked();
 for(const store of dsh.threads.values())for(const task of store.tasks.values())if(!['completed','failed','cancelled','canceled','interrupted','context_exhausted'].includes(String(task.status).toLowerCase()))throw blocked();
 for(const [id,e] of operations.entries)if(id!==requestId&&['pending','unknown','inspection'].includes(e.state))throw blocked();
}
export class UpdateReservation {
 constructor(){this.reserved=false;}
 assertOpen(){if(this.reserved)throw Object.assign(new Error('应用更新已准备，暂不接受新任务；请等待更新结果。'),{code:'APP_UPDATE_RESERVED',outcome:'notExecuted',status:409});}
 async run(verify,apply){this.assertOpen();verify();this.reserved=true;try{return await apply();}catch(e){if(e?.outcome==='notExecuted')this.reserved=false;throw e;}}
}
