import { projectDelegatedEdit } from './delegated-changes.js';

const milliseconds = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value * 1000 : null;
function parentWindow(turn, activeTurnId, now) {
  const meta = turn.meta || turn, id = turn.id || meta.id;
  const start = meta.startedAtMs;
  const end = id === activeTurnId || turn.status === 'running' ? now : meta.completedAtMs;
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? {id,start,end} : null;
}

/** No RPC here. The caller feeds scoped read-only child snapshots gathered in the background. */
export class NativeAgentChanges {
  constructor(threadId = null) { this.reset(threadId); }
  reset(threadId = null) {
    this.threadId = threadId;
    this.agents = new Map();
    this.bindings = new Map();
  }
  observe(items) {
    for (const item of Array.isArray(items) ? items : []) {
      const native = item.type === 'subAgentActivity';
      const ids = native ? [item.agentThreadId] : item.type === 'collabAgentToolCall' ? item.receiverThreadIds || [] : [];
      for (const id of ids) {
        if (typeof id !== 'string' || !id) continue;
        if (!this.agents.has(id)) this.agents.set(id, {id,owners:new Map(),turns:new Map(),firstTurnId:null,cwd:'',createdAtMs:null});
        const agent = this.agents.get(id);
        const spawn = native ? item.kind === 'started' : item.tool === 'spawnAgent';
        const followup = !native && ['sendInput','sendMessage','resumeAgent','followupTask'].includes(item.tool);
        if (!item._turnId || (!spawn && !followup)) continue;
        const previous = agent.owners.get(item.id);
        agent.owners.set(item.id, {parentTurnId:item._turnId,spawn,
          atMs:Number.isFinite(item._startedAtMs)?item._startedAtMs:previous?.atMs??null});
      }
    }
  }
  bind(agentId, childTurnId, parentTurnId) {
    if (this.agents.has(agentId) && childTurnId && parentTurnId) this.bindings.set(`${agentId}:${childTurnId}`,parentTurnId);
  }
  ingest(parentThreadId, thread, {complete = false} = {}) {
    if (parentThreadId !== this.threadId || !this.agents.has(thread?.id) || !Array.isArray(thread.turns)) return false;
    const agent = this.agents.get(thread.id);
    agent.cwd = typeof thread.cwd === 'string' ? thread.cwd : agent.cwd;
    agent.createdAtMs = milliseconds(thread.createdAt) ?? agent.createdAtMs;
    if (complete) { agent.turns.clear(); agent.firstTurnId = thread.turns[0]?.id || null; }
    for (const turn of thread.turns) {
      if (!turn?.id) continue;
      const changes = new Map();
      for (const item of turn.items || []) {
        if (item.type !== 'fileChange' || item.status !== 'completed') continue;
        const edit = projectDelegatedEdit({success:true,changes:item.changes});
        const atMs=[item._completedAtMs,item.completedAtMs,item._startedAtMs,item.startedAtMs].find(value=>typeof value==='number'&&Number.isFinite(value)&&value>=0)??null;
        if (edit?.changes.length) changes.set(item.id,{id:item.id,changes:edit.changes,atMs});
      }
      const retained=(!Array.isArray(turn.items)||turn.itemsView==='notLoaded')?agent.turns.get(turn.id)?.changes||[]:[...changes.values()];
      agent.turns.set(turn.id,{id:turn.id,start:milliseconds(turn.startedAt),end:milliseconds(turn.completedAt),status:turn.status,changes:retained});
    }
    return true;
  }
  changes({turns = [], activeTurnId = null, now = Date.now()} = {}) {
    const windows = turns.map(turn => parentWindow(turn,activeTurnId,now)).filter(Boolean);
    const uniqueWindow = at => {
      if (!Number.isFinite(at)) return null;
      const matches = windows.filter(window => at >= window.start && at <= window.end);
      return matches.length === 1 ? matches[0].id : null;
    };
    const records = [];
    for (const agent of this.agents.values()) {
      const owners = [...agent.owners.values()];
      for (const child of agent.turns.values()) {
        let parentId = this.bindings.get(`${agent.id}:${child.id}`) || null;
        const first = child.id === agent.firstTurnId;
        if (!parentId && first) {
          const spawnIds = new Set(owners.filter(owner => owner.spawn).map(owner => owner.parentTurnId));
          if (spawnIds.size === 1) {
            const spawnId = [...spawnIds][0];
            const end = child.end ?? (child.status === 'inProgress' ? now : null);
            const foreign = owners.filter(owner => owner.parentTurnId !== spawnId);
            // A steer inside the same child turn can own later edits. Without item timestamps,
            // never assign that whole turn to its original spawn when a later owner overlaps.
            const ambiguous = foreign.some(owner => owner.atMs === null || child.start === null || end === null || owner.atMs >= child.start && owner.atMs <= end);
            if (!ambiguous) parentId = spawnId;
          }
          if (!parentId && !owners.some(owner => !owner.spawn)) parentId = uniqueWindow(agent.createdAtMs);
        }
        if (!parentId && child.start !== null) {
          const candidate = uniqueWindow(child.start);
          if (candidate && owners.some(owner => !owner.spawn && owner.parentTurnId === candidate)) {
            const end = child.end ?? (child.status === 'inProgress' ? now : null);
            const conflicts = owners.some(owner => owner.parentTurnId !== candidate && (owner.atMs === null || end === null || owner.atMs >= child.start && owner.atMs <= end));
            if (!conflicts) parentId = candidate;
          }
        }
        for (const edit of child.changes) {
          const timed=uniqueWindow(edit.atMs);
          const owner=parentId||(timed&&owners.some(value=>value.parentTurnId===timed)?timed:null);
          if(owner)records.push({id:`native:${agent.id}:${child.id}:${edit.id}`,agentId:agent.id,turnId:owner,success:true,cwd:agent.cwd,changes:edit.changes});
        }
      }
    }
    return records;
  }
}
