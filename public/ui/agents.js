// Subagents: native Codex agents (collabAgentToolCall / subAgentActivity) and DSH tasks.
// Lifecycle comes only from typed status fields. A finished tool call is not a finished agent.
// Requested model/effort are labelled as requested; nothing is inherited or inferred.
import { el } from './format.js';
import { icon } from '../icons.js';

export const AGENT_STATE = {
  pendingInit: { label: '初始化中', tone: 'run' }, running: { label: '运行中', tone: 'run' }, interrupted: { label: '已中断', tone: 'stop' },
  completed: { label: '已完成', tone: 'ok' }, errored: { label: '出错', tone: 'fail' }, shutdown: { label: '已关闭', tone: 'idle' }, notFound: { label: '未找到', tone: 'fail' },
};
const ACTIVITY = { started: { label: '已启动', tone: 'run' }, interacted: { label: '有交互', tone: 'run' }, interrupted: { label: '已中断', tone: 'stop' }, completed: { label: '已完成', tone: 'ok' } };
const TOOL = { spawnAgent: '启动子代理', sendInput: '发送输入', resumeAgent: '恢复子代理', wait: '等待子代理', closeAgent: '关闭子代理', sendMessage: '发送消息', followupTask: '追加任务', interruptAgent: '中断子代理', listAgents: '列出子代理' };
const CALL = { inProgress: '调用中', completed: '调用已返回', failed: '调用失败', interrupted: '调用中断' };

/**
 * Folds native items (chronological) into one entry per agent thread id.
 * Each entry: {id, path, prompt, requestedModel, requestedEffort, state, message, lastKind, calls:[...], firstSeenMs, lastSeenMs}.
 */
export function nativeAgents(items) {
  const agents = new Map();
  const get = id => { let row = agents.get(id); if (!row) { row = { id, path: '', prompt: '', requestedModel: null, requestedEffort: null, state: null, message: '', lastKind: null, life: null, calls: [], firstSeenMs: null, lastSeenMs: null }; agents.set(id, row); } return row; };
  const seen = (row, item) => { const t = item._completedAtMs ?? item._startedAtMs ?? null; if (typeof t === 'number') { row.firstSeenMs ??= t; row.lastSeenMs = Math.max(row.lastSeenMs ?? t, t); } };
  for (const item of items) {
    if (item?.type === 'collabAgentToolCall') {
      const targets = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.filter(id => typeof id === 'string' && id) : [];
      for (const id of targets) {
        const row = get(id); seen(row, item);
        row.calls.push({ itemId: item.id, tool: item.tool, status: item.status });
        if (item.tool === 'spawnAgent') {
          if (typeof item.prompt === 'string' && item.prompt) row.prompt = item.prompt.slice(0, 2000);
          if (typeof item.model === 'string' && item.model) row.requestedModel = item.model;
          if (typeof item.reasoningEffort === 'string' && item.reasoningEffort) row.requestedEffort = item.reasoningEffort;
        }
        const reported = item.agentsStates?.[id];
        if (reported && typeof reported.status === 'string' && AGENT_STATE[reported.status]) { row.life = { ...AGENT_STATE[reported.status], source: 'state', key: reported.status }; row.state = reported.status; }
        if (typeof reported?.message === 'string' && reported.message) row.message = reported.message.slice(0, 4000);
      }
    } else if (item?.type === 'subAgentActivity' && typeof item.agentThreadId === 'string' && item.agentThreadId) {
      const row = get(item.agentThreadId); seen(row, item);
      if (typeof item.agentPath === 'string' && item.agentPath) row.path = item.agentPath;
      if (ACTIVITY[item.kind]) {
        row.lastKind = item.kind;
        // `interacted` is activity, not a state change: it never overrides a known terminal or running state.
        if (item.kind !== 'interacted' || !row.life) row.life = { ...ACTIVITY[item.kind], source: 'activity', key: item.kind };
      }
    }
  }
  return [...agents.values()];
}

/**
 * The displayed lifecycle is the newest typed evidence in item order (agentsStates snapshot or
 * subAgentActivity kind). An older `running` snapshot never hides a later `completed` activity.
 */
export function agentLifecycle(agent) {
  if (agent.life) return { label: agent.life.label, tone: agent.life.tone, source: agent.life.source };
  return { label: '状态未知', tone: 'idle', source: 'none' };
}

function chip(document, tone, text) { const node = el(document, 'span', 'agent-state', text); node.dataset.tone = tone; return node; }

export function renderNativeAgent(document, agent, { now = Date.now() } = {}) {
  const life = agentLifecycle(agent);
  const card = el(document, 'article', 'agent-card'); card.dataset.tone = life.tone; card.dataset.agentId = agent.id;
  const head = el(document, 'header', 'agent-head');
  const glyph = el(document, 'span', 'agent-glyph'); glyph.append(icon(document, 'branch', { size: 16 }));
  const title = el(document, 'div', 'agent-title');
  title.append(el(document, 'strong', '', agent.path || '子代理'), el(document, 'span', 'agent-id mono', agent.id.slice(0, 12)));
  head.append(glyph, title, chip(document, life.tone, life.label));
  card.append(head);
  const facts = el(document, 'div', 'agent-facts');
  const fact = (label, value) => { if (!value) return; const f = el(document, 'span', 'agent-fact'); f.append(el(document, 'span', '', label), el(document, 'b', '', value)); facts.append(f); };
  fact('请求模型', agent.requestedModel); fact('请求推理', agent.requestedEffort);
  if (typeof agent.lastSeenMs === 'number') fact('最近活动', relative(now - agent.lastSeenMs));
  const lastCall = agent.calls.at(-1);
  if (lastCall) fact('最近调用', `${TOOL[lastCall.tool] || lastCall.tool} · ${CALL[lastCall.status] || lastCall.status || '状态未知'}`);
  if (facts.children.length) card.append(facts);
  if (agent.prompt) { const d = el(document, 'details', 'agent-more'); d.append(el(document, 'summary', '', '任务说明'), el(document, 'pre', '', agent.prompt)); card.append(d); }
  if (agent.message) { const d = el(document, 'details', 'agent-more'); d.open = life.tone !== 'run'; d.append(el(document, 'summary', '', life.tone === 'ok' ? '结果消息' : '状态消息'), el(document, 'pre', '', agent.message)); card.append(d); }
  return card;
}
function relative(ms) {
  if (!(ms >= 0)) return '';
  const s = Math.round(ms / 1000); if (s < 60) return `${s} 秒前`;
  const m = Math.round(s / 60); if (m < 60) return `${m} 分钟前`;
  return `${Math.round(m / 60)} 小时前`;
}
