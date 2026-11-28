import { requestKey, requestThread } from '../approval-schemas.js';
import { icon } from '../icons.js';
import { asyncInputDefinition, asyncAnswerHistory } from './async-input.js';
import { waitingPhase } from './task-phase.js';

const QUESTIONS = new Set(['item/tool/requestUserInput', 'tool/requestUserInput', 'mcpServer/elicitation/request']);
const APPROVALS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'execCommandApproval', 'applyPatchApproval']);
const validThread = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value);
function questionRequestKind(request) {
  const method = request?.method;
  const meta = request?.params?._meta;
  if (method === 'mcpServer/elicitation/request' && meta?.codex_approval_kind === 'mcp_tool_call') return 'approval';
  return QUESTIONS.has(method) ? 'question' : APPROVALS.has(method) ? 'approval' : null;
}
const requestNoticeId = token => /^[a-f0-9]{48}$/.test(token) ? `request-${token.slice(0,16)}` : null;
const asyncNoticeId = (threadId, itemId) => `async-${threadId}|${itemId}`;

// A server request instance is distinct from its reusable RPC id. Replayed snapshots are silent.
export function createQuestionNoticeState({ maxAsyncItems = Infinity } = {}) {
  const seen = new Set(), asyncItems = new Map(), answeredItems = new Set(), answeredEchoes = new Set(), inactiveThreads = new Set();
  let current = new Map(), sequence = 0;
  const asyncKey = (threadId, itemId) => `async\0${threadId}\0${itemId}`;
  const result = (fresh = [], removed = []) => ({ items: [...current.values(), ...asyncItems.values()], fresh, removed });
  function remember(key) {
    seen.add(key);
    for (const old of seen) { if (seen.size <= 2048) break; if (!current.has(old) && !asyncItems.has(old)) seen.delete(old); }
  }
  function recordAnswers(threadId, itemIds) {
    const removed = [];
    for (const itemId of itemIds) {
      if (!validThread(itemId)) continue;
      const key = asyncKey(threadId, itemId), item = asyncItems.get(key);
      if (answeredItems.has(key)) continue;
      if (item) { asyncItems.delete(key); removed.push(item); }
      answeredItems.add(key);
      remember(key);
      if (answeredItems.size > 2048) answeredItems.delete(answeredItems.values().next().value);
    }
    return result([], removed);
  }
  function recordHistory(threadId, { answered, echoes }) {
    for (const id of echoes) {
      answeredEchoes.add(asyncKey(threadId, id));
      if (answeredEchoes.size > 2048) answeredEchoes.delete(answeredEchoes.values().next().value);
    }
    return recordAnswers(threadId, answered.keys());
  }
  function sync(requests, { notify = true } = {}) {
    const next = new Map(), fresh = [];
    for (const request of requests?.values?.() || []) {
      const kind = questionRequestKind(request);
      if (!kind || typeof request.bridgeRequestToken !== 'string' || !request.bridgeRequestToken
          || request.bridgeRequestToken.length > 200 || !['string', 'number'].includes(typeof request.id)) continue;
      const key = requestKey(request.id) + '\0' + request.bridgeRequestToken;
      const threadId = requestThread(request);
      if (inactiveThreads.has(threadId)) continue;
      const item = { id: current.get(key)?.id || requestNoticeId(request.bridgeRequestToken) || `question-${++sequence}`, key, kind,
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
    snapshot: () => result().items,
    observe(message) {
      if (!['item/started', 'item/completed'].includes(message?.method)) return result();
      const { threadId, turnId, item } = message.params || {};
      if (!validThread(threadId) || !validThread(item?.id)) return result();
      const key = asyncKey(threadId, item.id);
      if (inactiveThreads.has(threadId)) {
        if (asyncInputDefinition(item)?.supported) remember(key);
        return result();
      }
      if (message.method === 'item/completed' && item.type === 'userMessage') {
        if (answeredEchoes.has(key)) return result();
        const turns = new Map();
        for (const entry of asyncItems.values()) {
          if (entry.threadId !== threadId) continue;
          if (!turns.has(entry.turnId)) turns.set(entry.turnId, []);
          turns.get(entry.turnId).push(entry.request.item);
        }
        if (!turns.size) return result();
        if (!turns.has(turnId)) turns.set(turnId, []);
        turns.get(turnId).push(item);
        const history = [...turns].map(([id, items]) => ({ id, items }));
        // The full transcript is needed to match an older, untagged answer safely.
        return recordHistory(threadId, asyncAnswerHistory(history, threadId, { confirmedOnly: true, allowLegacy: false, fullTranscript: false }));
      }
      if (!asyncInputDefinition(item)?.supported) return result();
      if (answeredItems.has(key)) return result();
      if (seen.has(key) && !asyncItems.has(key)) return result();
      const value = { id: asyncNoticeId(threadId,item.id), key, kind: 'question', threadId, turnId,
        request: { method: 'agentMessage/async', params: { threadId, itemId: item.id }, item } };
      const fresh = !seen.has(key); asyncItems.set(key, value); remember(key);
      if (asyncItems.size > maxAsyncItems) { const oldest = asyncItems.values().next().value; asyncItems.delete(oldest.key); return result(fresh ? [value] : [], [oldest]); }
      return result(fresh ? [value] : []);
    },
    answered(threadId, itemId) {
      if (!validThread(threadId) || !validThread(itemId)) return result();
      return recordAnswers(threadId, [itemId]);
    },
    hydrateQuiet(turns, threadId) {
      if (!validThread(threadId) || inactiveThreads.has(threadId)) return result();
      for (const turn of turns) for (const item of turn.items || []) {
        if (validThread(item?.id) && asyncInputDefinition(item)?.supported) remember(asyncKey(threadId, item.id));
      }
      if (![...asyncItems.values()].some(entry => entry.threadId === threadId)) return result();
      return recordHistory(threadId, asyncAnswerHistory(turns, threadId, { confirmedOnly: true }));
    },
    forgetThread(threadId) {
      if (!validThread(threadId)) return result();
      inactiveThreads.add(threadId);
      const removed = [];
      for (const pending of [current, asyncItems]) for (const [key, item] of pending) {
        if (item.threadId !== threadId) continue;
        pending.delete(key); removed.push(item);
      }
      return result([], removed);
    },
    restoreThread(threadId) { inactiveThreads.delete(threadId); },
    reset() {
      const removed = [...current.values(), ...asyncItems.values()];
      current.clear(); asyncItems.clear(); seen.clear(); answeredItems.clear(); answeredEchoes.clear(); inactiveThreads.clear();
      return result([], removed);
    },
  };
}

function notificationTarget(window, open, failed) {
  const desktop = window.codexLightQuestionNotifications;
  if (desktop) return desktop;
  const android = window.CodexLightNative;
  if (android) {
    if (typeof android.updateQuestionNotification !== 'function') return { status: () => 'unsupported' };
    const update = (operation, data = {}) => android.updateQuestionNotification(JSON.stringify({ operation, ...data }));
    return {
      restoreOnPermissionGrant: true,
      status: () => android.getQuestionNotificationStatus(),
      requestPermission: () => android.requestQuestionNotificationPermission(),
      openSettings: typeof android.openTaskNotificationSettings === 'function' ? () => android.openTaskNotificationSettings() : undefined,
      setEnabled: enabled => android.setBackgroundQuestionAlerts?.(enabled),
      show: data => update('show', data),
      clear: id => update('clear', { id }),
      clearAll: () => update('clearAll'),
    };
  }
  const Notification = window.Notification;
  if (!window.isSecureContext || typeof Notification !== 'function' || /Android|iPhone|iPad|iPod/i.test(window.navigator?.userAgent || '')) {
    return { status: () => 'unsupported' };
  }
  const active = new Map();
  function clear(id) {
    const notification = active.get(id);
    active.delete(id);
    notification?.close();
  }
  return {
    status: () => ({ granted: 'ready', default: 'permission_required', denied: 'blocked' })[Notification.permission] || 'unsupported',
    requestPermission: () => Notification.requestPermission(),
    show({ id, threadId, kind }) {
      if (Notification.permission !== 'granted' || active.has(id)) return;
      const notification = new Notification('码舱 CodeCang', {
        body: kind === 'question' ? 'Codex 等待你的回答。打开通知继续对话。' : 'Codex 等待你的审批。打开通知查看请求。',
        icon: '/icon.svg',
      });
      active.set(id, notification);
      notification.onclick = event => {
        event.preventDefault();
        if (open(id, threadId)) window.focus();
        clear(id);
      };
      notification.onclose = () => active.delete(id);
      notification.onerror = () => { active.delete(id); failed(); };
    },
    clear,
    clearAll() { for (const id of active.keys()) clear(id); },
  };
}

const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };

export function createQuestionNotifications({ document, window, host, permissionStatus, permissionButton,
  enabled = () => true, canOpen = () => true, openThread, notice = () => {}, onPendingQuestions = () => {}, onPendingCounts = () => {} }) {
  const state = createQuestionNoticeState();
  let items = [], dismissed = '', disposed = false, bridgeWarning = false, notificationEnabled = enabled();
  let queuedOpen = null, opening = false, lastCount = -1, lastEnabled, synced = false;
  function failed() {
    if (!disposed && !bridgeWarning) { bridgeWarning = true; notice('系统通知暂时不可用。请在应用内查看待处理请求。', true); }
  }
  const bridge = notificationTarget(window, queueOpen, failed);
  const open = document.createElement('button'), title = document.createElement('strong'), detail = document.createElement('span');
  const symbol = document.createElement('span'); symbol.className = 'question-alert-symbol';
  const copy = document.createElement('span'); copy.className = 'question-alert-copy'; copy.setAttribute('aria-live', 'polite'); copy.setAttribute('aria-atomic', 'true');
  copy.append(title, detail);
  open.type = 'button'; open.className = 'question-alert-open'; open.append(symbol, copy, icon(document, 'right', { size: 16 }));
  const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.className = 'question-alert-dismiss';
  dismiss.append(icon(document, 'close', { size: 16 })); dismiss.setAttribute('aria-label', '暂时收起待处理提醒');
  host.classList.add('question-alert');
  host.replaceChildren(open, dismiss); host.hidden = true;
  const signature = () => items.map(item => item.key).join('\n');
  let androidPermission = bridge.restoreOnPermissionGrant ? bridge.status() : null;
  function bridgeCall(method, value) {
    if (typeof bridge?.[method] !== 'function') return;
    Promise.resolve().then(() => {
      if (method === 'show' && (disposed || !enabled() || !items.some(item => item.id === value.id))) return;
      return bridge[method](value);
    }).catch(failed);
  }
  function renderPermission() {
    if (!permissionStatus || !permissionButton) return;
    const status = bridge.status?.() || 'desktop';
    const labels = {
      desktop: '发送 Windows 通知，点击回到对应请求。',
      checking: '正在读取 Windows 通知设置…',
      unavailable: '暂时无法读取 Windows 通知设置。',
      ready: '系统通知已授权，点击可回到对应请求。',
      permission_required: '授权后可在收到新请求时发送系统通知。',
      blocked: '系统通知已关闭，请在设备或浏览器的通知设置中开启。',
      unsupported: '当前环境仅支持应用内提醒。',
    };
    setText(permissionStatus, enabled() ? labels[status] || labels.unsupported : '提问与审批提醒已关闭。');
    const canRequest = status === 'permission_required' && typeof bridge.requestPermission === 'function';
    const canOpenSettings = status === 'blocked' && typeof bridge.openSettings === 'function';
    permissionButton.hidden = !enabled() || (!canRequest && !canOpenSettings);
    setText(permissionButton, canOpenSettings ? '系统通知设置' : '允许系统通知');
  }
  async function requestPermission() {
    if (permissionButton.hidden || permissionButton.disabled) return;
    permissionButton.disabled = true;
    try {
      if (bridge.status?.() === 'blocked') await bridge.openSettings();
      else if (await bridge.requestPermission() === 'default') notice('尚未授权系统通知，可再次点击申请。');
    } catch { failed(); }
    finally { permissionButton.disabled = false; renderPermission(); }
  }
  function permissionChanged() {
    if (disposed) return;
    if (bridge.restoreOnPermissionGrant) {
      const current = bridge.status();
      if (current === 'ready' && androidPermission !== 'ready' && enabled()) {
        for (const item of items) postReminder(item);
      }
      androidPermission = current;
    }
    renderPermission();
  }
  let checkingPermission = false;
  async function refreshPermission() {
    if (!bridge.refreshStatus) { permissionChanged(); return; }
    if (checkingPermission) return;
    checkingPermission = true;
    try { await bridge.refreshStatus(); } catch { failed(); }
    finally { checkingPermission = false; permissionChanged(); }
  }
  permissionButton?.addEventListener('click', requestPermission);
  window.addEventListener('focus', refreshPermission);
  if (bridge.refreshStatus) void refreshPermission();
  window.addEventListener('codexlight-question-notification-status', permissionChanged);
  function publishPendingQuestions(count, active) {
    if (lastCount === count && lastEnabled === active) return;
    lastCount = count;
    lastEnabled = active;
    onPendingQuestions(count, active);
  }
  function render() {
    renderPermission();
    const questions = items.filter(item => item.kind === 'question').length;
    onPendingCounts(questions, items.length - questions);
    publishPendingQuestions(questions, enabled());
    host.hidden = !enabled() || !items.length || dismissed === signature();
    if (host.hidden) return;
    const kind = questions === items.length ? 'question' : questions ? 'mixed' : 'approval';
    if (host.dataset.kind !== kind) {
      host.dataset.kind = kind;
      symbol.replaceChildren(icon(document, kind === 'approval' ? 'shield' : kind === 'question' ? 'home' : 'bell', { size: 19 }));
    }
    setText(title, kind === 'question' ? 'Codex 等待你的回答' : kind === 'approval' ? 'Codex 等待你的审批' : '有提问和审批等待处理');
    setText(detail, items.length > 1 ? `${items.length} 项待处理 · 查看第一项` : '打开对应请求');
  }
  function queueOpen(id, threadId) {
    if (disposed || !enabled()) return false;
    const item = items.find(value => value.id === id && (value.threadId || '') === threadId);
    if (!item) return false;
    queuedOpen = item;
    void flushOpen();
    return true;
  }
  function queueNativeOpen(id, threadId) {
    if (disposed || !enabled() || typeof id !== 'string' || (threadId !== '' && !validThread(threadId))) return false;
    const asyncItemId = validThread(threadId) && id.startsWith(`async-${threadId}|`) ? id.slice(7 + threadId.length) : '';
    if (!validThread(asyncItemId) && !/^(request-[a-f0-9]{16}|question-\d{1,10})$/.test(id)) return false;
    queuedOpen = {id,threadId,native:true,asyncItemId};
    void flushOpen();
    return true;
  }
  async function flushOpen() {
    if (opening || !queuedOpen || !enabled() || !canOpen()) return;
    if (queuedOpen.native && !synced) return;
    const {id,threadId,native,asyncItemId} = queuedOpen;
    queuedOpen = null;
    const item = items.find(value => value.id === id && (value.threadId || '') === (threadId || ''));
    if (!item && !native) return;
    if (!item && !threadId) { notice('该请求已结束。'); return; }
    opening = true;
    try { await openThread(threadId,item?.request || (asyncItemId ? {method:'agentMessage/async',params:{threadId,itemId:asyncItemId}} : {nativeOnly:true})); }
    catch (error) { notice('无法打开待处理请求：' + (error?.message || '对话暂时不可用'), true); }
    finally { opening = false; void flushOpen(); }
  }
  open.addEventListener('click', () => { if (items[0]) queueOpen(items[0].id, items[0].threadId || ''); });
  dismiss.addEventListener('click', () => { dismissed = signature(); render(); });
  const onNativeOpen = event => queueOpen(event.detail?.id, event.detail?.threadId);
  if (window.CodexLightNative) window.CodexLightQuestionNotifications = {open:queueNativeOpen};
  window.addEventListener('codex-light-question-open', onNativeOpen);
  window.addEventListener('pagehide', clearSystem);
  function clearSystem() { bridgeCall('clearAll'); }
  bridgeCall('clearAll');
  bridgeCall('setEnabled',notificationEnabled);
  render();
  function postReminder(item) {
    bridgeCall('show', { id: item.id, threadId: item.threadId || '', kind: item.kind });
  }
  function apply(result) {
    if (disposed) return;
    items = result.items;
    for (const item of result.removed) bridgeCall('clear', item.id);
    const nextEnabled = enabled();
    if(nextEnabled!==notificationEnabled)bridgeCall('setEnabled',nextEnabled);
    if (!nextEnabled && notificationEnabled) { queuedOpen = null; clearSystem(); }
    else if (nextEnabled) {
      const reminders = bridge.restoreOnPermissionGrant && !notificationEnabled ? items : result.fresh;
      for (const item of reminders) postReminder(item);
    }
    notificationEnabled = nextEnabled;
    render();
    void flushOpen();
  }
  return {
    async openPending(kind) {
      const item = items.find(entry => entry.kind === kind);
      if (!item || !canOpen()) { notice(item ? '当前操作结束后可查看请求。' : '这项请求已处理。'); return; }
      try { await openThread(item.threadId, item.request); }
      catch (error) { notice('无法打开待处理请求：' + error.message, true); }
    },
    waitingPhase: (threadId,turnId) => waitingPhase(items,threadId,turnId),
    sync(requests, options) { if (!disposed) { synced=true; apply(state.sync(requests, options)); } },
    observe(message) { if (!disposed && ['item/started', 'item/completed'].includes(message?.method)) apply(state.observe(message)); },
    answered(threadId, itemId) { if (!disposed) apply(state.answered(threadId, itemId)); },
    hydrateQuiet(turns, threadId) {
      if (disposed) return;
      const result = state.hydrateQuiet(turns, threadId);
      if (result.removed.length) apply(result);
    },
    forgetThread(threadId) { if (!disposed) apply(state.forgetThread(threadId)); },
    restoreThread(threadId) { if (!disposed) state.restoreThread(threadId); },
    flushOpen,
    reset() { if (!disposed) { dismissed = ''; queuedOpen = null; synced=false; apply(state.reset()); clearSystem(); } },
    dispose() {
      disposed = true; queuedOpen = null; clearSystem(); host.hidden = true;
      publishPendingQuestions(0, enabled());
      onPendingCounts(0, 0);
      permissionButton?.removeEventListener('click', requestPermission);
      window.removeEventListener('focus', refreshPermission);
      window.removeEventListener('codexlight-question-notification-status', permissionChanged);
      window.removeEventListener('codex-light-question-open', onNativeOpen);
      window.removeEventListener('pagehide', clearSystem);
    },
  };
}
