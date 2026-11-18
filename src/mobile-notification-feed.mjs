import {createQuestionNoticeState} from '../public/ui/question-notifications.js';

const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value);
const completedStates = new Set(['completed','failed','interrupted']);
const retentionMs = 15 * 60_000;

// The paired Android service receives routing identifiers and status only.
export class MobileNotificationFeed {
  #finished = new Map();
  #running = new Map();
  #notices = createQuestionNoticeState({maxAsyncItems:1024});

  observe(message, now = Date.now()) {
    const {method, params = {}} = message;
    const {thread, turn, threadId = thread?.id} = params;
    if (method === 'bridge/status' && params.connected === false) {
      this.#finished.clear(); this.#running.clear();
    }
    if (!validId(threadId)) return;
    const turnId = turn?.id || params.turnId;
    if (method === 'turn/started' && validId(turnId)) {
      this.#running.delete(threadId);
      this.#running.set(threadId,turnId);
      if (this.#running.size > 128) this.#running.delete(this.#running.keys().next().value);
    }
    if (method === 'thread/closed' || (method === 'turn/completed' && this.#running.get(threadId) === turnId)) this.#running.delete(threadId);
    if (method === 'thread/archived' || method === 'thread/deleted') {
      this.#running.delete(threadId);
      for (const [key, task] of this.#finished) if (task.threadId === threadId) this.#finished.delete(key);
      this.#notices.forgetThread(threadId);
    }
    if (method === 'thread/unarchived') this.#notices.restoreThread(threadId);
    if (method === 'turn/completed' && validId(turnId) && completedStates.has(turn?.status)) {
      const key = `${threadId}\n${turnId}`;
      if (!this.#finished.has(key)) this.#finished.set(key,{threadId,turnId,state:turn.status,at:now});
      if (this.#finished.size > 128) this.#finished.delete(this.#finished.keys().next().value);
    }
    if (method === 'item/started' || method === 'item/completed') {
      this.#notices.observe(message);
    }
  }

  snapshot({connected, serverInstance, threads, requests, now = Date.now()}) {
    this.#notices.sync(requests,{notify:false});
    for (const [key, task] of this.#finished) if (now-task.at >= retentionMs) this.#finished.delete(key);
    const pending = connected ? this.#notices.snapshot() : [];
    const waiting = (threadId,turnId) => pending.some(notice => {
      const requestTurnId = notice.turnId || notice.request?.params?.turnId;
      return notice.threadId === threadId && (!requestTurnId || requestTurnId === turnId);
    });
    const active = connected ? new Map(this.#running) : new Map();
    if (connected) for (const row of threads) {
      if (validId(row.threadId) && validId(row.activeTurnId) && row.state === 'active') active.set(row.threadId,row.activeTurnId);
      else active.delete(row.threadId);
    }
    const running = [...active].slice(-32).map(([threadId,turnId]) => ({threadId,turnId,state:waiting(threadId,turnId) ? 'waiting' : 'running'}));
    return {
      connected, serverInstance, running,
      finished:connected ? [...this.#finished.values()].map(({threadId,turnId,state}) => ({threadId,turnId,state})) : [],
      pending:pending.slice(-128).map(({id,threadId,kind}) => ({id,threadId:threadId||'',kind})),
    };
  }
}
