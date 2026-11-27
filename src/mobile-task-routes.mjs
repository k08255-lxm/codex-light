export const validTaskId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value);

// A turn event carries no lineage. Only a thread description or a typed spawn
// edge can identify its destination. A user fork is an independent conversation.
export class MobileTaskRoutes {
  #routes = new Map();
  #reads = new Map();
  #retryAfter = new Map();
  #inactive = new Set();

  constructor(readThread, changed) {
    this.readThread = readThread;
    this.changed = changed;
  }

  #set(id, root, parent = null) {
    if (!validTaskId(id)) return;
    const previous = this.#routes.get(id);
    // Spawn evidence remains valid even if an older engine omits its lineage on read.
    if (root && previous?.root === false) return;
    parent = validTaskId(parent) ? parent : previous?.parent || null;
    if (previous?.root === root && previous.parent === parent) return;
    this.#routes.set(id, {root, parent});
    if (this.#routes.size > 4096) this.#routes.delete(this.#routes.keys().next().value);
    this.#retryAfter.delete(id);
    this.changed();
  }

  remember(thread, listed = false) {
    if (!thread?.id) return;
    const subAgent = thread.source?.subAgent;
    const parent = thread.parentThreadId || thread.attachedToThreadId || subAgent?.thread_spawn?.parent_thread_id;
    if (thread.archived || /(?:^|[\\/])archived_sessions[\\/][^\\/]+$/i.test(thread.path || '')) this.#inactive.add(thread.id);
    const hidden = parent || subAgent || thread.ephemeral
      || ['subagent', 'guardian_review'].includes(thread.threadSource);
    if (!hidden && !listed && !thread.source && thread.threadSource !== 'user') return;
    this.#set(thread.id, !hidden, parent);
  }

  observe({method, params = {}}) {
    const id = params.threadId || params.thread?.id;
    if ((method === 'thread/archived' || method === 'thread/deleted') && validTaskId(id)) this.#inactive.add(id);
    if (method === 'thread/unarchived') this.#inactive.delete(id);
    if (method === 'thread/started' || method === 'thread/unarchived') this.remember(params.thread);
    if (method !== 'item/started' && method !== 'item/completed') return;
    const item = params.item;
    if (item?.type === 'subAgentActivity') this.#set(item.agentThreadId, false, params.threadId);
    if (item?.type === 'collabAgentToolCall' && item.tool === 'spawnAgent') {
      for (const id of item.receiverThreadIds || []) this.#set(id, false, params.threadId);
    }
  }

  #read(id) {
    if (this.#reads.has(id)) return this.#reads.get(id);
    const read = Promise.resolve().then(() => this.readThread(id)).then(thread => {
      if (this.#reads.get(id) !== read) throw new Error('连接已改变，请重新确认通知对应的对话');
      if (thread?.id !== id) throw new Error('未能确认通知对应的对话');
      this.remember(thread);
      if (!this.#routes.has(id)) throw new Error('引擎尚未提供通知对应对话的来源');
    }).catch(error => {
      if (this.#reads.get(id) === read) {
        // A fresh turn may arrive before the engine has materialized its rollout.
        this.#retryAfter.set(id, Date.now() + 5000);
        if (this.#retryAfter.size > 256) this.#retryAfter.delete(this.#retryAfter.keys().next().value);
      }
      throw error;
    }).finally(() => { if (this.#reads.get(id) === read) this.#reads.delete(id); });
    this.#reads.set(id, read);
    return read;
  }

  isRoot(id) {
    if (this.#inactive.has(id)) return false;
    const known = this.#routes.get(id);
    if (known) return known.root;
    if (!this.#reads.has(id) && !(this.#retryAfter.get(id) > Date.now())) {
      void this.#read(id).catch(() => {}); // Unconfirmed routes stay out of snapshots.
    }
    return false;
  }

  rootFor(id) {
    const visited = new Set();
    while (validTaskId(id) && !visited.has(id) && !this.#inactive.has(id)) {
      visited.add(id);
      if (this.isRoot(id)) return id;
      id = this.#routes.get(id)?.parent;
    }
    return null;
  }

  async target(id) {
    const visited = new Set();
    while (validTaskId(id) && !visited.has(id)) {
      visited.add(id);
      if (this.#inactive.has(id) && !this.#routes.get(id)?.parent) return null;
      // Recheck the destination on tap; another client may have archived or removed
      // a root since its notification was posted. A known child edge stays useful.
      if (!this.#routes.has(id) || this.#routes.get(id).root) {
        try { await this.#read(id); }
        catch (error) {
          const absent = error.code === -32600 && [`thread not loaded: ${id}`, `thread not found: ${id}`].includes(error.message);
          if (absent || error.message === '对话不存在') return null;
          throw error;
        }
      }
      const route = this.#routes.get(id);
      if (route?.root) return this.#inactive.has(id) ? null : id;
      id = route?.parent;
    }
    return null;
  }

  reset() { this.#routes.clear(); this.#reads.clear(); this.#retryAfter.clear(); this.#inactive.clear(); }
}
