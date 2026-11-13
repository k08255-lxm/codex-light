// Subagents: native Codex agents (collabAgentToolCall / subAgentActivity) and DSH tasks.
// Lifecycle comes only from typed status fields. A finished tool call is not a finished agent.
// Requested model/effort are labelled as requested; nothing is inherited or inferred.
import { el } from './format.js';
import { icon } from '../icons.js';
import { renderMarkdown } from '../markdown.js';
import { boundedText } from '../store.js';

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
  const seen = (row, item, started=false) => { const t = item._completedAtMs ?? item._startedAtMs ?? null; if (typeof t === 'number') { if(started)row.firstSeenMs ??= item._startedAtMs ?? t; row.lastSeenMs = Math.max(row.lastSeenMs ?? t, t); } };
  for (const item of items) {
    if (item?.type === 'collabAgentToolCall') {
      const targets = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.filter(id => typeof id === 'string' && id) : [];
      for (const id of targets) {
        const row = get(id); seen(row, item,item.tool==='spawnAgent');
        row.calls.push({ itemId: item.id, tool: item.tool, status: item.status });
        if (item.tool === 'spawnAgent') {
          if (typeof item.prompt === 'string' && item.prompt) row.prompt = boundedText(item.prompt, 65536);
          if (typeof item.model === 'string' && item.model) row.requestedModel = item.model;
          if (typeof item.reasoningEffort === 'string' && item.reasoningEffort) row.requestedEffort = item.reasoningEffort;
        }
        const reported = item.agentsStates?.[id];
        if (reported && typeof reported.status === 'string' && AGENT_STATE[reported.status]) { row.life = { ...AGENT_STATE[reported.status], source: 'state', key: reported.status }; row.state = reported.status; }
        if (typeof reported?.message === 'string' && reported.message) row.message = boundedText(reported.message, 65536);
      }
    } else if (item?.type === 'subAgentActivity' && typeof item.agentThreadId === 'string' && item.agentThreadId) {
      const row = get(item.agentThreadId); seen(row, item,item.kind==='started');
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

/** Compact labels preserve the evidence source; requested settings are never called actual. */
export function agentDisplayMetadata(agent) {
  const safe=value=>typeof value==='string'&&value.trim()&&value.length<=256&&!/[\x00-\x1f]/.test(value)?value.trim():'';
  const actualModel=safe(agent.native?agent.actualModel:agent.model);
  const requestedModel=safe(agent.requestedModel);
  const actualEffort=safe(agent.native?agent.actualEffort:agent.effort);
  const requestedEffort=safe(agent.requestedEffort);
  const provider=safe(agent.native?agent.actualProvider:agent.provider);
  const model=actualModel||requestedModel,effort=actualEffort||requestedEffort;
  const shortModel=model.split('/').at(-1).replace(/^gpt-/i,'GPT-').replace(/^deepseek-/i,'DeepSeek-');
  const effortLabel=({none:'无',minimal:'最低',low:'低',medium:'中',high:'高',xhigh:'极高',max:'最高',ultra:'极致'})[effort]||effort;
  const source=agent.native?'GPT':provider?`DSH · ${provider}`:'DSH';
  const title=[agent.native?'Codex 原生子代理':'DSH 子代理',
    actualModel?`${agent.native?'实际报告':'任务报告'}模型：${actualModel}`:requestedModel?`请求模型：${requestedModel}；尚无实际模型确认`:'',
    actualEffort?`报告思考强度：${actualEffort}`:requestedEffort?`请求思考强度：${requestedEffort}；尚无实际强度确认`:'',
    provider?`报告提供商：${provider}`:''].filter(Boolean).join('\n');
  return {parts:[source,shortModel,effortLabel].filter(Boolean),title};
}

function chip(document, tone, text) { const node = el(document, 'span', 'agent-state', text); node.dataset.tone = tone; return node; }

export function renderNativeAgent(document, agent, { now = Date.now(), expanded = new Map(), onLocalLink, cwd = '', loadThread, detailsState = new Map(), onOpenAgent } = {}) {
  if(onOpenAgent){
    const button=el(document,'button','agent-conversation-link');button.type='button';button.append(agentAvatar(document,agent.id));
    const name=agent.path?.split('/').filter(Boolean).at(-1)||agent.id.slice(0,12),life=agentLifecycle(agent);
    const title=el(document,'span','',name);title.title=agent.path||agent.id;
    button.append(title,chip(document,life.tone,life.label),icon(document,'right',{size:14}));button.addEventListener('click',()=>onOpenAgent(agent.id,'native'));return button;
  }
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
  const detail = (key, title, text, defaultOpen = false) => {
    const d = el(document, 'details', 'agent-more');
    const identity = `${agent.id}:${key}`;
    d.open = expanded.has(identity) ? expanded.get(identity) : defaultOpen;
    d.addEventListener('toggle', () => { if (d.isConnected) expanded.set(identity, d.open); });
    const content = el(document, 'div', 'agent-markdown');
    content.append(renderMarkdown(document, text, { onLocalLink, cwd, complete: true }));
    d.append(el(document, 'summary', '', title), content); card.append(d);
  };
  if (agent.prompt) detail('prompt', '任务说明', agent.prompt);
  if (agent.message) detail('message', life.tone === 'ok' ? '结果消息' : '状态消息', agent.message, life.tone !== 'run');
  if (loadThread) {
    let saved = detailsState.get(agent.id);
    if (!saved) { saved = { open: false, loading: false, thread: null, error: '' }; detailsState.set(agent.id, saved); }
    const controls = el(document, 'div', 'agent-detail-actions');
    const toggle = el(document, 'button', 'btn small'); toggle.type = 'button';
    const refresh = el(document, 'button', 'btn small', '刷新'); refresh.type = 'button';
    const body = el(document, 'div', 'agent-thread-detail');
    body.id = `agent-detail-${agent.id}`; toggle.setAttribute('aria-controls', body.id);
    controls.append(toggle, refresh); card.append(controls, body);
    const paint = () => {
      toggle.textContent = saved.open ? '收起详情' : '查看详情'; toggle.setAttribute('aria-expanded', String(saved.open));
      refresh.hidden = !saved.open; refresh.disabled = saved.loading;
      body.hidden = !saved.open; body.replaceChildren();
      if (!saved.open) return;
      if (saved.loading) body.append(el(document, 'p', 'muted', '正在读取子代理内容…'));
      if (saved.error) { const error = el(document, 'p', 'inline-error', saved.error); error.setAttribute('role', 'status'); body.append(error); }
      if (!saved.thread) return;
      const rows = (saved.thread.turns || []).flatMap(turn => turn.items || []);
      if (!rows.length && !saved.loading) body.append(el(document, 'p', 'muted', '尚无可读取的内容。'));
      if (rows.length > 100) body.append(el(document, 'p', 'muted', '显示最近 100 条记录。'));
      for (const item of rows.slice(-100)) {
        if (item.type === 'agentMessage' || item.type === 'userMessage') {
          const text = item.type === 'agentMessage' ? item.text : (item.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
          if (!text) continue;
          const row = el(document, 'section', 'agent-thread-message');
          row.append(el(document, 'span', 'agent-thread-role', item.type === 'userMessage' ? '任务输入' : '子代理'));
          const content = el(document, 'div', 'agent-markdown'); content.append(renderMarkdown(document, boundedText(text, 65536), { onLocalLink, cwd: saved.thread.cwd || cwd, complete: true }));
          row.append(content); body.append(row);
        } else if (item.type === 'commandExecution' || item.type === 'fileChange') {
          const row = el(document, 'details', 'agent-thread-tool');
          row.append(el(document, 'summary', '', item.type === 'commandExecution' ? `命令 · ${item.command || ''}` : '文件改动'));
          const text = item.type === 'commandExecution' ? item.aggregatedOutput || item.status : (item.changes || []).map(change => `${change.path || ''}\n${change.diff || ''}`).join('\n');
          row.append(el(document, 'pre', '', boundedText(text, 32768))); body.append(row);
        }
      }
    };
    saved.paint = paint;
    const read = async () => {
      if (saved.loading) return;
      saved.loading = true; saved.error = ''; saved.paint();
      try {
        const thread = await loadThread(agent.id);
        if (!thread || thread.id !== agent.id || !Array.isArray(thread.turns)) throw new Error('服务未返回此子代理的会话内容。');
        saved.thread = thread;
      } catch (error) { saved.error = '读取失败：' + String(error.message || error); }
      finally { saved.loading = false; saved.paint(); }
    };
    toggle.addEventListener('click', () => { saved.open = !saved.open; paint(); if (saved.open && !saved.thread && !saved.loading) read(); });
    refresh.addEventListener('click', read); paint();
  }
  return card;
}
function relative(ms) {
  if (!(ms >= 0)) return '';
  const s = Math.round(ms / 1000); if (s < 60) return `${s} 秒前`;
  const m = Math.round(s / 60); if (m < 60) return `${m} 分钟前`;
  return `${Math.round(m / 60)} 小时前`;
}
// Local deterministic avatar: same identity keeps its colors and geometry across renders.
export function agentAvatar(document,id){
 let hash=2166136261;for(const char of String(id))hash=Math.imul(hash^char.charCodeAt(0),16777619)>>>0;
 const hue=hash%360,svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 32 32');svg.setAttribute('aria-hidden','true');svg.classList.add('agent-avatar');
 const shape=(tag,attrs)=>{const node=document.createElementNS(svg.namespaceURI,tag);for(const [key,value]of Object.entries(attrs))node.setAttribute(key,String(value));svg.append(node);};
 shape('rect',{width:32,height:32,rx:10,fill:`hsl(${hue} 22% 26%)`});
 for(let y=0;y<3;y++)for(let x=0;x<2;x++)if((hash>>>(y*2+x+4))&1){for(const px of new Set([x,3-x]))shape('rect',{x:7+px*5,y:9+y*5,width:4,height:4,rx:1,fill:`hsl(${hue} 45% 75%)`});}
 shape('circle',{cx:11,cy:14,r:1.5,fill:`hsl(${hue} 50% 88%)`});shape('circle',{cx:21,cy:14,r:1.5,fill:`hsl(${hue} 50% 88%)`});return svg;
}
