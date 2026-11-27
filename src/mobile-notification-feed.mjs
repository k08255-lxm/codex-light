import {createQuestionNoticeState} from '../public/ui/question-notifications.js';
import {createTurnActivity, signalsLiveTurn, taskPreview} from '../public/ui/task-phase.js';
import {MobileTaskRoutes, validTaskId as validId} from './mobile-task-routes.mjs';

const completedStates = new Set(['completed','failed','interrupted']);
const retentionMs = 15 * 60_000;

function noticeDetails(notice) {
  const params = notice.request?.params, question = params?.questions?.[0];
  const text = notice.kind === 'question' && !question?.isSecret
    && (notice.request?.item?.questions?.[0]?.title || question?.question || question?.header);
  const preview = taskPreview(text);
  return {noticeId:notice.id,noticeThread:notice.threadId,...(preview && {preview})};
}

export class MobileNotificationFeed {
  #finished = new Map();
  #running = new Map();
  #notices = createQuestionNoticeState({maxAsyncItems:1024});
  #superseded = new Set();

  constructor({readThread, changed = () => {},isQuestionIgnored=()=>false}) {
    this.changed = changed;
    this.isQuestionIgnored = isQuestionIgnored;
    this.routes = new MobileTaskRoutes(readThread, changed);
  }

  reset(){
    this.#finished.clear();this.#running.clear();this.#superseded.clear();
    this.routes.reset();this.#notices.reset();this.changed();
  }

  rememberThread(thread, listed=false) {
    this.routes.remember(thread,listed);
    if (!validId(thread?.id) || this.#running.has(thread.id) || !Array.isArray(thread.turns)) return;
    const latest=thread.turns.at(-1);
    if (latest?.status==='inProgress' && validId(latest.id) && this.#track(thread.id,latest.id)) this.changed();
  }

  ignoreQuestion(threadId,itemId) {
    this.#notices.answered(threadId,itemId);
    this.changed();
  }

  #track(threadId,turnId) {
    const key = threadId + '\n' + turnId;
    if (this.#finished.has(key) || this.#superseded.has(key)) return null;
    let activity = this.#running.get(threadId);
    if (activity?.turnId === turnId) return activity;
    if (activity) {
      this.#superseded.add(threadId + '\n' + activity.turnId);
      if (this.#superseded.size > 256) this.#superseded.delete(this.#superseded.values().next().value);
    }
    activity = createTurnActivity(turnId);
    this.#running.delete(threadId);
    this.#running.set(threadId,activity);
    if (this.#running.size > 128) this.#running.delete(this.#running.keys().next().value);
    return activity;
  }

  observe(message, now = Date.now()) {
    const {method, params = {}} = message;
    const {thread, turn, threadId = thread?.id} = params;
    if (method === 'bridge/status' && params.connected === false) {
      this.#finished.clear(); this.#running.clear(); this.#superseded.clear(); this.routes.reset();
    }
    this.routes.observe(message);
    if (method === 'bridge/status' || method === 'serverRequest/resolved' || message.id !== undefined) this.changed();
    if (!validId(threadId)) return;
    const previous = this.#running.get(threadId), revision = previous?.revision;
    const turnId = turn?.id || params.turnId;
    if (validId(turnId) && (method === 'turn/started' || method === 'turn/completed')) this.routes.isRoot(threadId);
    if (validId(turnId) && (method === 'turn/started' || (!previous && signalsLiveTurn(method)))) {
      this.#track(threadId,turnId);
    }
    const activity = this.#running.get(threadId);
    if (activity && activity.turnId === turnId) activity.observe(message);
    if (method === 'thread/closed' || (method === 'turn/completed' && activity?.turnId === turnId)) this.#running.delete(threadId);
    if (method === 'thread/archived' || method === 'thread/deleted') {
      this.#running.delete(threadId);
      for (const [key, task] of this.#finished) if (task.threadId === threadId) this.#finished.delete(key);
      this.#notices.forgetThread(threadId);
    }
    if (method === 'thread/unarchived') this.#notices.restoreThread(threadId);
    if (method === 'turn/completed' && validId(turnId) && completedStates.has(turn?.status) && !this.#superseded.has(threadId + '\n' + turnId)) {
      const key = `${threadId}\n${turnId}`;
      if (!this.#finished.has(key)) this.#finished.set(key,{threadId,turnId,state:turn.status,at:now});
      if (this.#finished.size > 128) this.#finished.delete(this.#finished.keys().next().value);
      this.changed();
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item=params.item;
      const ignored=item?.type==='agentMessage' && item.delivery==='async' && validId(item.id) && this.isQuestionIgnored(threadId,item.id);
      const {fresh, removed} = ignored ? this.#notices.answered(threadId,item.id) : this.#notices.observe(message);
      if (fresh.length || removed.length) this.changed();
    }
    if (previous !== this.#running.get(threadId) || revision !== previous?.revision || ['thread/archived','thread/deleted','thread/unarchived'].includes(method)) this.changed();
  }

  snapshot({connected, serverInstance, threads, requests, details = false, now = Date.now()}) {
    this.#notices.sync(requests,{notify:false});
    for (const [key, task] of this.#finished) if (now-task.at >= retentionMs) this.#finished.delete(key);
    const pending = connected ? this.#notices.snapshot() : [];
    const active = connected ? new Map(this.#running) : new Map();
    if (connected) for (const row of threads) {
      if (validId(row.threadId) && validId(row.activeTurnId) && row.state === 'active') {
        const activity = this.#track(row.threadId,row.activeTurnId);
        if (activity) active.set(row.threadId,activity);
      }
    }
    const tasks = new Map();
    for (const [threadId,activity] of active) {
      if (!this.routes.isRoot(threadId)) continue;
      tasks.set(threadId,{threadId,turnId:activity.turnId,state:'running',phase:activity.phase,...(details && {details:activity.details()})});
    }
    for (const notice of pending) {
      const threadId = this.routes.rootFor(notice.threadId);
      if (!threadId) continue;
      const task = tasks.get(threadId), requestedTurn = notice.turnId || notice.request?.params?.turnId;
      const own = threadId === notice.threadId;
      if (task?.state === 'waiting' || (!own && !task) || (own && task && requestedTurn && task.turnId !== requestedTurn)) continue;
      const turnId = task?.turnId || requestedTurn;
      if (!validId(turnId)) continue;
      tasks.set(threadId,{threadId,turnId,state:'waiting',phase:notice.kind,...(details && {details:{...task?.details,...noticeDetails(notice)}})});
    }
    const running = [...tasks.values()].slice(-32);
    return {
      connected, serverInstance, running,
      finished:connected ? [...this.#finished.values()].filter(task => tasks.get(task.threadId)?.turnId!==task.turnId && this.routes.isRoot(task.threadId)).map(({threadId,turnId,state}) => ({threadId,turnId,state})) : [],
      pending:pending.slice(-128).map(({id,threadId,kind})=>({id,threadId:threadId||'',kind})),
    };
  }
}
