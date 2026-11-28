import {dshLifecycleEvent} from '../dsh.js';

const tools = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'webSearch', 'imageGeneration', 'imageView']);
const deltaActions = new Map([['item/commandExecution/outputDelta','commandExecution'],['item/mcpToolCall/progress','mcpToolCall'],['item/fileChange/patchUpdated','fileChange']]);
const deltaPhases = new Map([
  ['item/agentMessage/delta', 'responding'],
  ['item/reasoning/textDelta', 'thinking'], ['item/reasoning/summaryTextDelta', 'thinking'],
  ['item/commandExecution/outputDelta', 'tool'], ['item/mcpToolCall/progress', 'tool'], ['item/fileChange/patchUpdated', 'tool'],
]);

export function taskPreview(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').trim().slice(0,120).replace(/[\ud800-\udbff]$/,'');
}

// Only the active plan step and typed tool category are needed for the private card.
export function createTurnActivity(turnId) {
  const active = new Map(), finished = new Set();
  const collaborators = new Set();
  let done = 0, total = 0, completedTools = 0, revision = 0, step = '';
  function setAgent(id, running) {
    if (collaborators.has(id)===running) return;
    if (running) collaborators.add(id); else collaborators.delete(id);
    revision++;
  }
  return {
    turnId,
    collaborators,
    finishChild(id) { setAgent('native:'+id,false); },
    get phase() {return [...active.values()].at(-1)?.phase || 'working';},
    get revision() {return revision;},
    details() {
      const action = [...active.values()].at(-1)?.action;
      return {...(action && {action}), ...(total && {done,total}), ...(step && {step}), ...(completedTools && {completedTools})};
    },
    observe({method, params}) {
      if (method === 'turn/plan/updated' && Array.isArray(params?.plan)) {
        const plan = params.plan;
        if (plan.length > 1024 || !plan.every(step=>['pending','inProgress','completed'].includes(step?.status))) return;
        const next = plan.filter(step=>step.status==='completed').length;
        const current=taskPreview(plan.find(entry=>entry.status==='inProgress')?.step);
        if (next !== done || total !== plan.length || step!==current) {done=next; total=plan.length; step=current; revision++;}
        return;
      }
      const item = params?.item, id = item?.id || params?.itemId;
      if (typeof id !== 'string' || !id || id.length > 256 || finished.has(id)) return;
      if (item && (method==='item/started'||method==='item/completed')) {
        if (item.type==='subAgentActivity' && typeof item.agentThreadId==='string' && ['started','completed','interrupted'].includes(item.kind))
          setAgent('native:'+item.agentThreadId,item.kind==='started');
        if (item.type==='collabAgentToolCall') for (const child of item.receiverThreadIds || []) {
          const status=item.agentsStates?.[child]?.status;
          if (['running','pendingInit'].includes(status)) setAgent('native:'+child,true);
          else if (['completed','interrupted','errored','shutdown','notFound'].includes(status)) setAgent('native:'+child,false);
        }
        const event=item.type==='mcpToolCall' && dshLifecycleEvent(item);
        if (event) setAgent('dsh:'+event.id,event.kind==='started');
      }
      if (method === 'item/completed') {
        if (active.delete(id)) revision++;
        if (tools.has(item?.type)) {completedTools++; revision++;}
        finished.add(id);
        if (finished.size > 256) finished.delete(finished.values().next().value);
        return;
      }
      const phase = method === 'item/started'
        ? item?.type === 'reasoning' ? 'thinking' : tools.has(item?.type) ? 'tool'
          : item?.type === 'agentMessage' && item.delivery !== 'async' ? 'responding' : null
        : deltaPhases.get(method);
      if (phase && !active.has(id)) {
        active.set(id,{phase,action:tools.has(item?.type) ? item.type : deltaActions.get(method)});
        revision++;
        if (active.size > 128) active.delete(active.keys().next().value);
      }
    },
  };
}

export function signalsLiveTurn(method) {
  return method === 'item/started' || method === 'turn/plan/updated' || deltaPhases.has(method);
}

export function waitingPhase(notices, threadId, turnId) {
  return notices.find(notice => {
    const requestedTurn = notice.turnId || notice.request?.params?.turnId;
    return notice.threadId === threadId && (!requestedTurn || requestedTurn === turnId);
  })?.kind;
}
