// An application update is not permission to interrupt model, terminal or DSH work.
import {isDshTerminalStatus} from '../public/dsh.js';
import {serverRequestThread} from './server-requests.mjs';

const dispatchTools=new Set(['dsh_start','dsh_followup','dsh_send']);
function* unresolvedDshTasks(dsh){
 for(const [threadId,store] of dsh.threads)for(const task of store.tasks.values()){
  // Opening history and querying DSH metadata also create inspector cards. Neither starts work.
  if(task.tool&&!dispatchTools.has(task.tool)&&(!task.agentId||!task.status))continue;
  if(!isDshTerminalStatus(task.status))yield {threadId,task};
 }
}

async function terminalTurnIds(rpc,threadId,wanted){
 const ended=new Set(),cursors=new Set();
 let cursor;
 while(wanted.size){
  const page=await rpc.call('thread/turns/list',{threadId,limit:100,sortDirection:'desc',itemsView:'notLoaded',...(cursor?{cursor}:{})});
  if(!Array.isArray(page?.data))break;
  for(const turn of page.data)if(wanted.delete(turn.id)&&['completed','interrupted','failed'].includes(turn.status))ended.add(turn.id);
  cursor=page.nextCursor;
  if(typeof cursor!=='string'||!cursor||cursors.has(cursor))break;
  cursors.add(cursor);
 }
 return ended;
}

// Check suspected stale claims against the same engine before the synchronous install gate.
// A live idle snapshot does not establish whether an earlier mutation succeeded.
export async function reconcileUpdateWork({rpc,sessions,runtime,dsh,operations,requestId}){
 if(!rpc.connected)return;
 if(sessions.queues.size){
  if([...operations.entries].some(([id,op])=>id!==requestId&&op.state==='pending'))return;
  // The last completion queues an unsubscribe. Let that cleanup finish on the same install click.
  await Promise.allSettled([...sessions.queues.values()]);
  if(!rpc.connected||sessions.queues.size)return;
 }
 const threads=new Set();
 for(const [id,entry] of sessions.entries)if(entry.activeTurnId||entry.unknown||entry.releaseError)threads.add(id);
 for(const turn of runtime.activeTurns?.values()||[])if(turn.threadId)threads.add(turn.threadId);
 for(const entry of operations.entries.values())if(entry.state==='unknown'&&entry.workThreadId&&entry.workTurnId&&!entry.workSettled)threads.add(entry.workThreadId);
 for(const request of rpc.requests.values())if(request.params?.turnId&&serverRequestThread(request))threads.add(serverRequestThread(request));
 for(const threadId of threads){
  const session=sessions.entries.get(threadId),activeId=session?.activeTurnId,unknown=session?.unknown;
  const turns=[...(runtime.activeTurns||[])].filter(([,turn])=>turn.threadId===threadId);
  const receipts=[...operations.entries.values()].filter(e=>e.state==='unknown'&&e.workThreadId===threadId&&e.workTurnId&&!e.workSettled);
  const approvals=[...rpc.requests.values()].filter(r=>r.params?.turnId&&serverRequestThread(r)===threadId);
  let thread;
  let ended=new Set();
  try{({thread}=await rpc.call('thread/read',{threadId,includeTurns:false}));}
  catch{continue;} // Unavailable or older engines retain the original blocker.
  if(thread?.id!==threadId||!['idle','notLoaded'].includes(thread.status?.type))continue;
  const wanted=new Set([...receipts.map(e=>e.workTurnId),...approvals.map(r=>r.params.turnId)]);
  if(unknown&&activeId)wanted.add(activeId);
  try{ended=await terminalTurnIds(rpc,threadId,wanted);}catch{/* Unverified approvals and uncertain operations keep blocking. */}
  if(!rpc.connected||sessions.queues.has(threadId))continue;
  if(session!==sessions.entries.get(threadId)||activeId!==session?.activeTurnId||unknown!==session?.unknown)continue;
  // A new start notification, even for the same turn ID, supersedes this snapshot.
  if(turns.some(([id,turn])=>runtime.activeTurns.get(id)!==turn))continue;
  for(const [id] of turns)runtime.activeTurns.delete(id);
  // A settled turn stops occupying the updater. Its operation receipt remains unknown for replay.
  for(const receipt of receipts)if(ended.has(receipt.workTurnId))receipt.workSettled=true;
  for(const request of approvals)if(ended.has(request.params.turnId))rpc.settleTurnRequests?.(threadId,request.params.turnId);
  if(session&&(!unknown||session.resumeUnconfirmed||ended.has(activeId))&&(activeId||session.releaseError||session.resumeUnconfirmed)){
   await sessions.releaseVerifiedIdle(threadId,session,thread.status.type);
  }
 }
 if(rpc.requests.size||runtime.activeTurns?.size||sessions.snapshot().threads.some(t=>t.state!=='idle'))return;
 // The reservation prevents a fresh inspector poll starting while existing read-only calls drain.
 if(dsh.pending.size)await Promise.allSettled([...dsh.pending.values()]);
 if(dsh.releaseError){
  try{await dsh.reader?.retryRelease();}catch{return;} // The release error is reported by the final gate.
 }
 for(const {threadId,task} of [...unresolvedDshTasks(dsh)]){
  if(!task.agentId)continue;
  try{await dsh.read({threadId,agentId:task.agentId,kind:'status'},{verifyCurrentTask:true});}
  catch{return;} // An unreachable child remains unresolved and blocks the handoff.
  if(!isDshTerminalStatus(dsh.threads.get(threadId)?.tasks.get(task.agentId)?.status))return;
 }
}

export function updateBlockReason({rpc,sessions,terminal,dsh,operations,runtime,requestId}={}){
 if(!rpc||!sessions||!terminal||!dsh||!operations||!runtime)return '暂时无法核对运行任务。';
 if(rpc.connected!==true)return 'Codex 尚未连接，等待重新连接后才能核对任务。';
 if(rpc.requests?.size)return `还有 ${rpc.requests.size} 项引擎请求等待处理，请查看对话中的审批或提问。`;
 const threads=sessions.snapshot().threads;
 const active=threads.filter(thread=>thread.state==='active');
 if(active.length)return `还有 ${active.length} 个对话正在运行，请等本轮结束或在对话中停止。`;
 if(threads.some(thread=>thread.state!=='idle'))return '有对话仍在等待引擎确认结束。';
 if(threads.some(thread=>thread.releaseError))return '对话订阅尚未释放，请检查引擎连接。';
 if(sessions.queues?.size)return '正在处理对话操作，请稍候。';
 for(const s of terminal.sessions.values())if(!['exited','error','disconnected'].includes(s.state))return '内置终端还有进程在运行，请在终端中结束会话。';
 if(dsh.releaseError)return 'DSH 读取会话尚未释放，请检查 DSH 连接。';
 if(dsh.pending?.size)return '正在读取 DSH 任务状态，请稍候。';
 if(!unresolvedDshTasks(dsh).next().done)return '有 DSH 子代理尚未确认结束，请查看子代理状态。';
 for(const [id,e] of operations.entries)if(id!==requestId){
  if(e.state==='pending')return '还有操作正在执行，请等待操作完成。';
  if(['unknown','inspection'].includes(e.state)&&!e.workSettled)return '有操作的执行结果尚未确认，请核对待处理操作。';
 }
 if(runtime.busy({requestId}))return 'Codex 引擎仍有运行中的回合，请等待结束或在对应对话中停止。';
 return null;
}
export function assertUpdateIdle(state){
 const reason=updateBlockReason(state);
 if(reason)throw Object.assign(new Error(reason),{code:'APP_UPDATE_WORK_ACTIVE',outcome:'notExecuted',status:409});
}
export class UpdateReservation {
 constructor(){this.reserved=false;}
 assertOpen(){if(this.reserved)throw Object.assign(new Error('应用更新已准备，暂不接受新任务；请等待更新结果。'),{code:'APP_UPDATE_RESERVED',outcome:'notExecuted',status:409});}
 async run(verify,apply,prepare){
  this.assertOpen();this.reserved=true;
  try{if(prepare)await prepare();verify();}
  catch(error){this.reserved=false;error.outcome='notExecuted';throw error;}
  try{return await apply();}catch(error){if(error?.outcome==='notExecuted')this.reserved=false;throw error;}
 }
}
