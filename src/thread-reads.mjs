import {randomUUID} from 'node:crypto';
import {MAX_READ_RECEIPTS, MAX_READ_TURNS, validCompletionId} from '../public/ui/thread-completion.js';

export class ThreadReads {
  #scope = randomUUID();
  #turns = new Map();

  observe({method, params}) {
    const threadId = params?.threadId, turnId = params?.turn?.id;
    if (method !== 'turn/completed' || params?.turn?.status !== 'completed' || !validCompletionId(threadId) || !validCompletionId(turnId)) return;
    const key = JSON.stringify([threadId, turnId]);
    if (this.#turns.has(key)) return;
    this.#turns.set(key, {threadId, turnId, read: false});
    if (this.#turns.size > MAX_READ_RECEIPTS) this.#turns.delete(this.#turns.keys().next().value);
  }

  read(input) {
    const {scope, threadId, turnIds} = input ?? {};
    if (!validCompletionId(threadId) || !Array.isArray(turnIds) || !turnIds.length || turnIds.length > MAX_READ_TURNS || !turnIds.every(validCompletionId)) {
      throw Object.assign(new Error('对话已读参数无效'), {code: 'INVALID_THREAD_READ'});
    }
    if (scope !== this.#scope) {
      throw Object.assign(new Error('对话已读作用域已变化'), {code: 'THREAD_READ_SCOPE_CHANGED', status: 409});
    }
    const changed = [];
    for (const turnId of turnIds) {
      const key = JSON.stringify([threadId, turnId]);
      const turn = this.#turns.get(key);
      if (!turn || turn.read) continue;
      turn.read = true;
      changed.push(turnId);
    }
    return changed.length ? {scope, reads: [{threadId, turnIds: changed}]} : null;
  }

  snapshot() {
    const threads = new Map();
    for (const {threadId, turnId, read} of this.#turns.values()) {
      if (!read) continue;
      if (!threads.has(threadId)) threads.set(threadId, []);
      threads.get(threadId).push(turnId);
    }
    return {scope: this.#scope, reads: Array.from(threads, ([threadId, turnIds]) => ({threadId, turnIds}))};
  }

  reset() {
    this.#turns.clear();
    this.#scope = randomUUID();
  }
}
