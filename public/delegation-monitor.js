import { nativeAgents, agentLifecycle } from './ui/agents.js';
import { NativeAgentChanges } from './agent-changes.js';
import { historyCapabilities } from './state.js';
import { readAgentThread } from './agent-history.js';
import { dshEventsSnapshot } from './dsh.js';

const terminal = status => ['completed','interrupted','failed','error','errored','shutdown','closed','cancelled','idle','context_exhausted','notFound'].includes(status);

/** Scoped read-only collection. At most two jobs run; each job owns its sequential page reads. */
export function createDelegationMonitor({ rpc, api, onChange = () => {}, onError = () => {} }) {
  const collector = new NativeAgentChanges(), records = new Map(), queue = [];
  const capabilities = historyCapabilities();
  let context = {}, generation = 0, active = 0, timer = null, disposed = false;
  const enabled = () => !disposed && context.threadId && context.connected && context.visible;
  const current = job => !disposed && generation === job.generation && context.threadId === job.threadId;
  function schedule(delay = 1000) {
    clearTimeout(timer); timer = null;
    if (enabled()) timer = setTimeout(() => { timer = null; reconcile(); }, delay);
  }
  function definitions() {
    const items = context.items || [];
    const native = nativeAgents(items).map(row => {
      const related = items.filter(item => item.agentThreadId === row.id || item.receiverThreadIds?.includes(row.id));
      const version = JSON.stringify(related.map(item => [item.id,item.status,item.kind,item._completedAtMs,item._startedAtMs]));
      const tone=agentLifecycle(row).tone;
      return { key:`native:${row.id}`, id:row.id, source:'native', version, active:!['ok','stop','fail'].includes(tone)&&!['shutdown','notFound'].includes(row.state) };
    });
    const dsh = (context.dshTasks?.values() || []).filter(row => row.threadId === context.threadId && row.agentId).map(row => ({
      key:`dsh:${row.agentId}`, id:row.agentId, source:'dsh', version:String(row.updated_at || row.status || ''), active:!terminal(String(row.status || '')),
    }));
    return [...native,...dsh];
  }
  function reconcile() {
    if (!enabled()) return;
    collector.observe(context.items || []);
    const now = Date.now();
    for (const definition of definitions()) {
      let record = records.get(definition.key);
      if (!record) { record = { nextAt:0, queued:false, loading:false, version:null, terminal:false, signature:null, failures:0 }; records.set(definition.key,record); }
      if (record.queued || record.loading || now < record.nextAt) continue;
      const changed = record.version !== definition.version;
      if (!changed && record.terminal && !record.hasMore && !record.failures) continue;
      record.queued = true;
      queue.push({ ...definition, record, generation, threadId:context.threadId, dshTasks:context.dshTasks });
    }
    pump(); schedule();
  }
  function pump() {
    while (active < 2 && queue.length) {
      const job = queue.shift(); job.record.queued = false;
      if (!enabled() || !current(job)) continue;
      active++; job.record.loading = true;
      run(job).finally(() => { active--; job.record.loading = false; pump(); });
    }
  }
  async function readNative(job) {
    return readAgentThread(rpc,job.id,{capabilities,isCurrent:()=>current(job)});
  }
  async function run(job) {
    const record = job.record;
    try {
      let changed = false;
      if (job.source === 'native') {
        const snapshot = await readNative(job);
        if (!current(job)) return;
        collector.ingest(job.threadId,snapshot.thread,{complete:snapshot.complete});
        const signature = JSON.stringify(snapshot.thread);
        changed = signature !== record.signature; record.signature = signature;
        const status = snapshot.thread.turns.at(-1)?.status;
        record.terminal = status ? terminal(status) : !job.active;
      } else {
        const response = await api('/api/dsh/read',{threadId:job.threadId,agentId:job.id,kind:'changes'});
        if (!current(job)) return;
        if (response.threadId && response.threadId !== job.threadId || response.agentId && response.agentId !== job.id) throw new Error('修改记录返回了其他会话或子代理');
        const projection = dshEventsSnapshot(response.result);
        if (!projection.available) throw new Error('子代理修改记录格式无法识别');
        changed = job.dshTasks.ingestChanges(job.threadId,job.id,projection.events,{hasMore:projection.has_more});
        record.hasMore = projection.has_more;
        record.terminal = !job.active;
      }
      record.version = job.version; record.failures = 0;
      record.nextAt = Date.now() + (record.hasMore ? 250 : 5000);
      if (changed) onChange();
      if (record.hasMore) schedule(250);
    } catch (error) {
      if (!current(job) || error.stale) return;
      record.failures++;
      record.nextAt = Date.now() + Math.min(30000,5000 * 2 ** Math.min(record.failures,3));
      onError(error,{threadId:job.threadId,agentId:job.id,source:job.source});
    }
  }
  function update(next) {
    if (disposed) return;
    if (next.threadId !== context.threadId) {
      generation++; queue.length = 0; records.clear(); collector.reset(next.threadId || null);
    }
    context = next;
    if (!enabled()) { clearTimeout(timer); timer = null; return; }
    reconcile();
  }
  return {
    update,
    changes:() => collector.changes({turns:context.turns || [],activeTurnId:context.activeTurnId || null}),
    dispose(){disposed=true;generation++;queue.length=0;records.clear();clearTimeout(timer);collector.reset();},
  };
}
