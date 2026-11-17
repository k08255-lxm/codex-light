import { requestKey, requestThread } from '../approval-schemas.js';
import { asyncInputDefinition } from './async-input.js';

const QUESTIONS = new Set(['item/tool/requestUserInput', 'tool/requestUserInput', 'mcpServer/elicitation/request']);
const APPROVALS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'execCommandApproval', 'applyPatchApproval']);
const validThread = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value);

// A server request instance is distinct from its reusable RPC id. Replayed snapshots are silent.
export function createQuestionNoticeState() {
  const seen = new Set(), asyncItems = new Map(), answeredItems = new Set();
  let current = new Map(), sequence = 0;
  const asyncKey = (threadId, itemId) => `async\0${threadId}\0${itemId}`;
  const result = (fresh = [], removed = []) => ({ items: [...current.values(), ...asyncItems.values()], fresh, removed });
  function remember(key) {
    seen.add(key);
    for (const old of seen) { if (seen.size <= 2048) break; if (!current.has(old) && !asyncItems.has(old)) seen.delete(old); }
  }
  function sync(requests, { notify = true } = {}) {
    const next = new Map(), fresh = [];
    for (const request of requests?.values?.() || []) {
      const kind = QUESTIONS.has(request?.method) ? 'question' : APPROVALS.has(request?.method) ? 'approval' : null;
      if (!kind || typeof request.bridgeRequestToken !== 'string' || !request.bridgeRequestToken
          || request.bridgeRequestToken.length > 200 || !['string', 'number'].includes(typeof request.id)) continue;
      const key = requestKey(request.id) + '\0' + request.bridgeRequestToken;
      const threadId = requestThread(request);
      const item = { id: current.get(key)?.id || `question-${++sequence}`, key, kind,
        threadId: validThread(threadId) ? threadId : null, request };
      next.set(key, item);
      if (!seen.has(key)) { seen.add(key); if (notify) fresh.push(item); }
    }
    const removed = [...current.values()].filter(item => !next.has(item.key));
    current = next;
    // Keep live instances remembered even when a session has many previous requests.
    for (const key of next.keys()) remember(key);
    return result(fresh, removed);
  }
  return {
    sync,
    observe(message) {
      if (!['item/started', 'item/completed'].includes(message?.method)) return result();
      const { threadId, item } = message.params || {};
      if (!validThread(threadId) || !validThread(item?.id) || !asyncInputDefinition(item)?.supported) return result();
      const key = asyncKey(threadId, item.id);
      if (answeredItems.has(key)) return result();
      if (seen.has(key) && !asyncItems.has(key)) return result();
      const value = { id: asyncItems.get(key)?.id || `question-${++sequence}`, key, kind: 'question', threadId,
        request: { method: 'agentMessage/async', params: { threadId, itemId: item.id }, item } };
      const fresh = !seen.has(key); asyncItems.set(key, value); remember(key);
      return result(fresh ? [value] : []);
    },
    answered(threadId, itemId) {
      if (!validThread(threadId) || !validThread(itemId)) return result();
      const key = asyncKey(threadId, itemId), removed = asyncItems.get(key);
      asyncItems.delete(key); answeredItems.add(key); remember(key);
      if (answeredItems.size > 2048) answeredItems.delete(answeredItems.values().next().value);
      return result([], removed ? [removed] : []);
    },
    hydrateQuiet(items, threadId) {
      if (validThread(threadId)) for (const item of items || []) {
        if (validThread(item?.id) && asyncInputDefinition(item)?.supported) remember(asyncKey(threadId, item.id));
      }
      return result();
    },
    reset() {
      const removed = [...current.values(), ...asyncItems.values()];
      current.clear(); asyncItems.clear(); seen.clear(); answeredItems.clear();
      return result([], removed);
    },
  };
}

export function createQuestionNotifications({ document, window, host, enabled = () => true, openThread, notice = () => {} }) {
  const state = createQuestionNoticeState(), bridge = window.codexLightQuestionNotifications;
  let items = [], dismissed = '', disposed = false, bridgeWarning = false, notificationEnabled = enabled();
  const open = document.createElement('button'), title = document.createElement('strong'), detail = document.createElement('span');
  open.type = 'button'; open.className = 'question-alert-open'; open.append(title, detail);
  const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.className = 'question-alert-dismiss';
  dismiss.textContent = '稍后'; dismiss.setAttribute('aria-label', '暂时收起待处理提醒');
  host.classList.add('question-alert'); host.setAttribute('role', 'status'); host.setAttribute('aria-live', 'polite');
  host.replaceChildren(open, dismiss); host.hidden = true;
  const signature = () => items.map(item => item.key).join('\n');
  const foreground = () => document.visibilityState !== 'hidden' && document.hasFocus();
  function bridgeCall(method, value) {
    if (typeof bridge?.[method] !== 'function') return;
    Promise.resolve().then(() => bridge[method](value)).catch(() => {
      if (!disposed && !bridgeWarning) { bridgeWarning = true; notice('系统提醒暂时不可用；待处理提示仍保留在应用内。', true); }
    });
  }
  function render() {
    host.hidden = !enabled() || !items.length || dismissed === signature();
    if (host.hidden) return;
    const questions = items.filter(item => item.kind === 'question').length;
    title.textContent = questions === items.length ? 'Codex 等待你的回答' : !questions ? 'Codex 等待你的审批' : 'Codex 有问题和审批等待处理';
    detail.textContent = items.length > 1 ? `${items.length} 项待处理 · 点击查看` : '点击返回对应对话处理';
  }
  async function activate(item) {
    if (!item || disposed) return;
    try { await openThread(item.threadId, item.request); }
    catch (error) { notice('无法打开待处理请求：' + (error?.message || '对话暂时不可用'), true); }
  }
  open.addEventListener('click', () => void activate(items[0]));
  dismiss.addEventListener('click', () => { dismissed = signature(); render(); });
  const onNativeOpen = event => {
    const item = items.find(value => value.id === event.detail?.id);
    if (item && (!item.threadId || item.threadId === event.detail?.threadId)) void activate(item);
  };
  window.addEventListener('codex-light-question-open', onNativeOpen);
  bridgeCall('clearAll');
  function apply(result) {
    if (disposed) return;
    items = result.items;
    for (const item of result.removed) bridgeCall('clear', item.id);
    const nextEnabled = enabled();
    if (!nextEnabled && notificationEnabled) bridgeCall('clearAll');
    else if (nextEnabled && !foreground()) for (const item of result.fresh) bridgeCall('show', { id: item.id, threadId: item.threadId || '', kind: item.kind });
    notificationEnabled = nextEnabled;
    render();
  }
  return {
    sync(requests, options) { if (!disposed) apply(state.sync(requests, options)); },
    observe(message) { if (!disposed && ['item/started', 'item/completed'].includes(message?.method)) apply(state.observe(message)); },
    answered(threadId, itemId) { if (!disposed) apply(state.answered(threadId, itemId)); },
    hydrateQuiet(items, threadId) { if (!disposed) state.hydrateQuiet(items, threadId); },
    reset() { if (!disposed) { dismissed = ''; apply(state.reset()); bridgeCall('clearAll'); } },
    dispose() { disposed = true; bridgeCall('clearAll'); window.removeEventListener('codex-light-question-open', onNativeOpen); host.hidden = true; },
  };
}
