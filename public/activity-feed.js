// Conversation view: one keyed DOM tree per turn built from state.buildTurns().
// Messages and compaction stay visible; consecutive operations form collapsible groups.
import { boundedText, itemText } from './store.js';
import { icon } from './icons.js';
import { renderMarkdown } from './markdown.js';
import { formatDuration } from './state.js';
import { reasoningTimeLabel } from './reasoning-timing.js';
import { dshToolResultAgentId } from './dsh.js';
import { artifactCandidates, markdownImageRefs } from './ui/artifacts.js';
import { asyncInputDefinition, asyncInputBodyText, createAsyncInputCard } from './ui/async-input.js';

const DETAIL_LIMIT = 16000;
const DIFF_LINE_LIMIT = 1500;
const FILE_PREVIEW = 3;

function el(document, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}
function setText(node, value) { const text = String(value ?? ''); if (node.textContent !== text) node.textContent = text; }
function reconcile(parent, nodes) {
  const keep = new Set(nodes);
  for (const child of [...parent.children]) if (!keep.has(child)) child.remove();
  nodes.forEach((node, index) => { if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] || null); });
}
const firstLine = value => typeof value === 'string' ? value.slice(0, 400).split(/\r?\n/).find(line => line.trim())?.trim() || '' : '';
function listText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(part => typeof part === 'string' ? part : part?.text || '').filter(Boolean).join('\n');
  return '';
}

// ---------- Item descriptions ----------

export function itemState(item) {
  const raw = typeof item.status === 'string' ? item.status : '';
  if (['failed', 'error'].includes(raw) || item.error || item.success === false || item.result?.isError === true || (typeof item.exitCode === 'number' && item.exitCode !== 0)) return 'failed';
  if (['declined'].includes(raw)) return 'declined';
  if (['interrupted', 'cancelled', 'canceled'].includes(raw)) return 'stopped';
  if (raw === 'completed') return 'done';
  if (['inProgress', 'in_progress', 'running', 'pending'].includes(raw) || item._complete === false) return 'running';
  return 'done';
}
const STATE_TEXT = { failed: '失败', declined: '已拒绝', stopped: '已停止', running: '进行中', done: '' };

export function describeItem(item,now=Date.now()) {
  const done = itemState(item) !== 'running';
  const images = artifactCandidates(item);
  if (images.length && ['imageView','dynamicToolCall','functionCallOutput'].includes(item.type)) return { icon: 'image', verb: done ? '已查看' : '查看', target: `${images.length} 张图像` };
  const read = Array.isArray(item.commandActions) ? item.commandActions.find(action => action?.type === 'read' && action.path) : null;
  const search=Array.isArray(item.commandActions)?item.commandActions.find(action=>action?.type==='search'):null;
  const listing=Array.isArray(item.commandActions)?item.commandActions.find(action=>action?.type==='listFiles'):null;
  switch (item.type) {
    case 'commandExecution':
      if (read) return { icon: 'file', verb: done ? '已读取' : '读取', target: firstLine(read.name || read.path) };
      if(search)return {icon:'search',verb:done?'已搜索':'搜索',target:firstLine(search.query||search.path)};
      if(listing)return {icon:'folder',verb:done?'已查看':'查看',target:firstLine(listing.path||'文件列表')};
      return { icon: 'terminal', verb: done ? '已运行' : '运行', target: firstLine(item.command), code: true };
    case 'fileChange': {
      const paths = (item.changes || []).map(change => change?.path).filter(Boolean);
      const name = paths.length === 1 ? paths[0].split(/[\\/]/).at(-1) : paths.length ? `${paths.length} 个文件` : '';
      return { icon: 'file', verb: done ? '已编辑' : '编辑', target: name };
    }
    case 'mcpToolCall': return { icon: 'plug', verb: done ? '已调用' : '调用', target: [firstLine(item.server), firstLine(item.tool)].filter(Boolean).join(' / ') };
    case 'dynamicToolCall': return { icon: 'plug', verb: done ? '已调用' : '调用', target: firstLine(item.tool) || '工具' };
    case 'webSearch': return { icon: 'globe', verb: done ? '已搜索' : '搜索', target: firstLine(item.query) };
    case 'reasoning': {
      return {icon:'spark',verb:done?'已思考':'思考中',target:reasoningTimeLabel(item,{done,now})};
    }
    case 'plan': return { icon: 'review', verb: '更新计划', target: firstLine(item.text) };
    case 'subAgentActivity': return {icon:'branch',verb:({started:'已启动子代理',interacted:'子代理有新交互',interrupted:'子代理已中断',completed:'子代理已完成'})[item.kind]||'子代理活动',target:firstLine(item.agentPath?.split('/').filter(Boolean).at(-1)||item.agentThreadId?.slice(0,12))};
    case 'collabAgentToolCall': return {icon:'branch',verb:({spawnAgent:'启动子代理',sendInput:done?'已向子代理发送消息':'向子代理发送消息',sendMessage:done?'已向子代理发送消息':'向子代理发送消息',resumeAgent:'恢复子代理',wait:'等待子代理',closeAgent:'关闭子代理',followupTask:'追加子代理任务',interruptAgent:'中断子代理',listAgents:'查看子代理'})[item.tool]||'子代理操作',target:''};
    case 'contextCompaction': return { icon: 'archive', verb: done ? '已压缩上下文' : '正在压缩上下文', target: '' };
    case 'imageView': case 'imageGeneration': return { icon: 'image', verb: '图片', target: firstLine(item.path || item.prompt) };
    case 'enteredReviewMode': return { icon: 'review', verb: '进入审查', target: '' };
    case 'exitedReviewMode': return { icon: 'review', verb: '审查结束', target: '' };
    default: return { icon: 'info', verb: typeof item.type === 'string' ? item.type : '活动', target: '' };
  }
}

function detailText(item) {
  const parts = []; let remaining = DETAIL_LIMIT;
  const add = (label, value) => {
    if (value == null || value === '' || remaining <= 0) return;
    const body = boundedText(typeof value === 'string' ? value : JSON.stringify(value, null, 2), Math.max(0, remaining - 80));
    const chunk = label ? `${label}\n${body}` : body; parts.push(chunk); remaining -= chunk.length + 2;
  };
  if (item.type === 'commandExecution') {
    add('', item.command ? '$ ' + item.command : '');
    if (typeof item.exitCode === 'number') add('', `退出码 ${item.exitCode}${typeof item.durationMs === 'number' ? ' · ' + formatDuration(item.durationMs) : ''}`);
    add('', item.aggregatedOutput);
  } else if (item.type === 'reasoning') {
    add('', listText(item.summary) || listText(item.content));
  } else if (item.type === 'fileChange') {
    for (const change of item.changes || []) add(change?.path || '', change?.diff);
  } else if (item.type === 'plan') {
    add('', item.text);
    if (Array.isArray(item.content)) add('', item.content.map(step => `${step.status === 'completed' ? '✓' : step.status === 'inProgress' ? '›' : '·'} ${step.step || ''}`).join('\n'));
  } else {
    add('参数', item.arguments ?? item.input);
    add('错误', item.error);
    add('', itemText(item));
  }
  return parts.join('\n\n') || '此步骤没有可显示的详细内容。';
}

// Shared compact tool presentation for the conversation and subagent inspector.
// Description, status and bounded detail formatting use the same canonical helpers.
function updateCompactionRecord(node, item) {
 const state=itemState(item);
 node.dataset.state=state;
 const label=({running:'正在压缩上下文',done:'上下文已压缩',failed:'上下文压缩失败',stopped:'上下文压缩已停止',declined:'上下文压缩已拒绝'})[state];
 setText(node.querySelector('.compaction-label'),label);
}
export function renderCompactionRecord(document,item){
 const node=el(document,'section','compaction-record');node.dataset.itemId=item.id;
 node.setAttribute('role','status');node.append(icon(document,'archive',{size:14}),el(document,'span','compaction-label'));
 updateCompactionRecord(node,item);return node;
}
export function renderActivityRecord(document,item,{artifacts=null}={}){
 const info=describeItem(item),state=itemState(item),node=el(document,'details','step agent-tool-record');
 node.dataset.state=state;
 node.dataset.running=String(state==='running');
 const summary=el(document,'summary','step-summary');summary.title=item.command||info.target||info.verb;
 const symbol=el(document,'span','step-icon');symbol.append(icon(document,info.icon,{size:14}));
 const target=el(document,'span','step-target'+(info.code?' code':''),info.target);
 const status=el(document,'span','step-state',[STATE_TEXT[state],Number.isFinite(item.durationMs)?formatDuration(item.durationMs):''].filter(Boolean).join(' · '));
 summary.append(symbol,el(document,'span','step-verb',info.verb),target,status);node.append(summary);
 node.addEventListener('toggle',()=>{
  if(!node.open||node.childElementCount>1)return;
  const body=el(document,'div','step-detail');
  const candidates=artifacts?artifactCandidates(item):[];
  if(candidates.length)body.append(artifacts.strip(candidates));
  if(item.type==='fileChange')for(const change of item.changes||[]){body.append(el(document,'div','diff-file-name',change.path||''),renderDiff(document,change.diff));}
  else if(item.type!=='imageView')body.append(el(document,'pre','',detailText(item)));
  node.append(body);
 });
 return node;
}

// ---------- Diff rendering ----------

export function renderDiff(document, source) {
  const pre = el(document, 'pre', 'diff-view');
  const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
  const shown = lines.slice(0, DIFF_LINE_LIMIT);
  for (const line of shown) {
    const kind = line.startsWith('@@') ? 'hunk' : line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') ? 'meta' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
    const row = el(document, 'span', `diff-line diff-${kind}`, line + '\n'); pre.append(row);
  }
  if (lines.length > shown.length) pre.append(el(document, 'span', 'diff-line diff-meta', `… 另有 ${lines.length - shown.length} 行未显示`));
  return pre;
}

export function statsNode(document, added, removed, evidence = {}) {
  const span = el(document, 'span', 'diff-stats');
  const partial=evidence.complete===false||evidence.known===false;
  if((added===null||removed===null)&&evidence.knownEdits>0){added=evidence.knownAdded;removed=evidence.knownRemoved;}
  if (added !== null && removed !== null) {
    if(partial)span.append(el(document,'span','diff-unknown','已知 '));
    span.append(el(document, 'span', 'diff-added', `+${added}`), el(document, 'span', 'diff-removed', `-${removed}`));
  }
  const reasons=evidence.statsReasons||[];
  if(evidence.unknownCount>0)span.append(el(document,'span','diff-unknown',` · ${evidence.unknownCount} 个文件行数未知${evidence.binaryCount?`（${evidence.binaryCount} 个二进制）`:''}`));
  else if(added===null||removed===null||partial)span.append(el(document,'span','diff-unknown',(added!==null?' · ':'')+(reasons.includes('binary')?'二进制':reasons.includes('truncated')?'差异不完整，行数未知':reasons.includes('limited')?'差异计算超限，行数未知':reasons.includes('malformed')?'差异格式不可统计，行数未知':'缺少差异数据，行数未知')));
  span.title=evidence.statsBasis==='edits'?'累计已应用编辑的增删行数；同一行多次修改会累计，不代表最终净差异。':'本轮最终净差异。';
  return span;
}

// ---------- Long bodies ----------
// A long body is split into ordered segments at paragraph boundaries. Only a small window of segments
// is in the DOM at once; the rest stays in the store and is reachable through the segment navigator.

export const LONG_TEXT = Object.freeze({ segment: 12000, window: 3 });
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[^\n]*/;
const lowSurrogate = (text, index) => { const code = text.charCodeAt(index); return code >= 0xdc00 && code <= 0xdfff; };
/**
 * Splits `text` into segments `{start, end, fence}` (`fence`: the code-fence line open at `start`, so a
 * segment cut inside a fenced block can be shown with its fence reopened). Cuts at a blank line outside a
 * fence once a segment reaches `size`, at any line end outside a fence at 2×size, at any line end at 3×size,
 * and inside a single over-long line at 3×size. `previous` (an earlier result for a prefix of `text`)
 * lets streaming re-split only the last, still-open segment. Segments cover the text exactly, in order.
 */
export function splitSegments(text, { size = LONG_TEXT.segment, previous = null } = {}) {
  const source = typeof text === 'string' ? text : '';
  const reuse = previous?.segments?.length > 0 && source.length >= previous.length && source.startsWith(previous.text);
  const segments = reuse ? previous.segments.slice(0, -1) : [];
  const last = reuse ? previous.segments.at(-1) : null;
  let segStart = last ? last.start : 0; let fence = last ? last.fence : null; let midLine = last ? last.mid : false;
  let startFence = fence; let startMid = midLine; let pos = segStart;
  const cut = at => { segments.push({ start: segStart, end: at, fence: startFence, mid: startMid }); segStart = at; startFence = fence; startMid = midLine; };
  while (pos < source.length) {
    const newline = source.indexOf('\n', pos); const lineEnd = newline < 0 ? source.length : newline + 1;
    if (lineEnd - segStart > 3 * size) {
      let at = segStart + 3 * size; if (lowSurrogate(source, at)) at--;
      if (at <= pos) at = Math.min(lineEnd, pos + size);
      if (at < lineEnd) { pos = at; midLine = true; cut(at); continue; }
    }
    const line = source.slice(pos, lineEnd);
    if (!midLine) {
      if (!fence) { const open = FENCE_OPEN.exec(line); if (open) fence = { line: open[0].replace(/\s+$/, ''), char: open[1][0], length: open[1].length }; }
      else if (new RegExp(`^ {0,3}${fence.char === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(line)) fence = null;
    }
    midLine = newline < 0; pos = lineEnd;
    if (newline < 0) break;
    const length = pos - segStart;
    if ((length >= size && !fence && !line.trim()) || (length >= 2 * size && !fence) || length >= 3 * size) cut(pos);
  }
  if (segStart < source.length || !segments.length) segments.push({ start: segStart, end: source.length, fence: startFence, mid: startMid });
  // `appended`: `text` extends `previous.text` unchanged, so segments before the last are identical.
  return { text: source, length: source.length, segments, appended: reuse };
}
/** Display text of one segment (a fence opened in an earlier segment is reopened). */
export function segmentSource(split, index) {
  const row = split.segments[index]; if (!row) return '';
  const body = split.text.slice(row.start, row.end);
  return row.fence ? row.fence.line + '\n' + body : body;
}
const fenceKey = fence => fence ? fence.line : '';
/** Length of the common prefix of two strings (compared in chunks, then refined). */
export function commonPrefix(a, b) {
  const limit = Math.min(a.length, b.length); let at = 0; const step = 4096;
  while (at + step <= limit && a.slice(at, at + step) === b.slice(at, at + step)) at += step;
  while (at < limit && a.charCodeAt(at) === b.charCodeAt(at)) at++;
  return at;
}

/**
 * Body view with a bounded DOM. `render(source, index)` → node for one segment.
 * Completed bodies open at the beginning; a streaming body follows its latest tail until the user
 * navigates away. Segment nodes outside the window are released.
 * Rendered segments are reused only while the body grows by appending; any replacement, edit,
 * deletion or rolling trim discards them so the new content is rendered.
 * `retention` (from the store) says whether this is the complete original body; the copy action and
 * the status line state exactly what is copied.
 */
export function retentionOf(item, keys) {
  let omitted = 0; let released = 0;
  for (const key of keys) { omitted += item?._omitted?.[key] || 0; released += item?._released?.[key] || 0; }
  return { complete: !omitted && !released, omitted, released };
}
function longTextView(document, { render, label = '正文', onCopy }) {
  const node = el(document, 'div', 'long-text');
  const bar = el(document, 'div', 'long-text-bar'); bar.setAttribute('role', 'group'); bar.setAttribute('aria-label', label + '分段浏览');
  const position = el(document, 'span', 'long-text-position'); position.setAttribute('aria-live', 'polite');
  const status = el(document, 'span', 'long-text-status');
  const button = (text, title, action) => { const b = el(document, 'button', 'btn ghost small long-text-nav', text); b.type = 'button'; b.title = title; b.addEventListener('click', action); return b; };
  const first = button('开头', '跳到第一段', () => go(0, false));
  const prev = button('上一段', '显示前一段', () => go(start - 1, false));
  const next = button('下一段', '显示后一段', () => go(start + 1, false));
  const last = button('最新', '跳到最后一段，运行中时继续跟随最新内容', () => go(Infinity, true));
  const copy = button('复制全文', '', async () => {
    const text = split.text;
    try { if (onCopy) await onCopy(text); else await document.defaultView.navigator.clipboard.writeText(text); copy.textContent = retention.complete ? '已复制全文' : '已复制保留部分'; }
    catch { copy.textContent = '复制失败'; }
  });
  copy.classList.add('long-text-copy');
  bar.append(position, status, first, prev, next, last, copy);
  const body = el(document, 'div', 'long-text-body');
  const more = button('继续阅读下一段', '显示后一段', () => go(start + 1, false)); more.classList.add('long-text-more');
  node.append(body);
  let split = splitSegments(''); let start = 0; let follow = true; let streaming = false; let seen = false;
  let retention = { complete: true, omitted: 0, released: 0 };
  const cache = new Map(); // index -> {start, end, open, fence, windowed, node}
  const copyLabel = () => retention.complete ? '复制全文' : '复制保留部分';
  function go(target, tail) {
    const max = Math.max(0, split.segments.length - LONG_TEXT.window);
    start = Math.max(0, Math.min(max, target === Infinity ? max : target));
    follow = !!tail;
    paint(); copy.textContent = copyLabel();
    node.scrollIntoView?.({ block: 'start' });
  }
  function paintRetention() {
    const chars = split.length.toLocaleString('zh-CN');
    if (retention.complete) {
      status.textContent = ''; status.hidden = true; delete node.dataset.retention;
      copy.title = `复制此条完整正文（${chars} 字符）`;
    } else {
      const parts = [];
      if (retention.omitted) parts.push(`中间 ${retention.omitted.toLocaleString('zh-CN')} 字符超过单条保留上限，未保留`);
      if (retention.released) parts.push(`原 ${retention.released.toLocaleString('zh-CN')} 字符的正文已从当前窗口释放，只保留开头`);
      status.textContent = '未完整保留：' + parts.join('；'); status.hidden = false; node.dataset.retention = 'partial';
      copy.title = `界面没有此条的完整原文：将复制当前保留的 ${chars} 字符（含省略提示），不是原始全文。完整内容由 Codex 保存${retention.released ? '，重新打开对话可再次读取' : ''}。`;
    }
    copy.setAttribute('aria-label', copy.title);
    if (!/^已复制|^复制失败/.test(copy.textContent)) copy.textContent = copyLabel();
  }
  function paint() {
    const count = split.segments.length; const windowed = count > LONG_TEXT.window;
    const end = Math.min(count, start + LONG_TEXT.window); const nodes = [];
    for (let index = start; index < end; index++) {
      const row = split.segments[index]; const open = index === count - 1 && streaming;
      let entry = cache.get(index);
      if (!entry || entry.start !== row.start || entry.end !== row.end || entry.open || fenceKey(entry.fence) !== fenceKey(row.fence) || entry.windowed !== windowed) {
        const segment = render(segmentSource(split, index), index);
        if (windowed) { const wrap = el(document, 'section', 'long-text-segment'); wrap.dataset.segment = String(index + 1); wrap.append(segment); entry = { node: wrap }; }
        else entry = { node: segment };
        Object.assign(entry, { start: row.start, end: row.end, open, fence: row.fence, windowed }); cache.set(index, entry);
      }
      nodes.push(entry.node);
    }
    for (const index of [...cache.keys()]) if (index < start || index >= end) cache.delete(index);
    paintRetention();
    // Short complete bodies keep the plain structure: just the rendered content, no navigator.
    // An incomplete body always shows its status and the accurately labelled copy action.
    if (!windowed && retention.complete) { body.replaceChildren(...nodes); bar.remove(); more.remove(); node.dataset.long = 'false'; return; }
    node.dataset.long = String(windowed);
    if (bar.parentElement !== node) node.insertBefore(bar, body);
    for (const control of [first, prev, next, last]) control.hidden = !windowed;
    position.hidden = !windowed;
    if (windowed) reconcile(body, nodes); else body.replaceChildren(...nodes);
    position.textContent = `第 ${start + 1}${end - start > 1 ? '–' + end : ''} 段 / 共 ${count} 段 · ${split.length.toLocaleString('zh-CN')} 字符${streaming && follow ? ' · 跟随最新' : ''}`;
    first.disabled = start === 0; prev.disabled = start === 0;
    next.disabled = end >= count; last.disabled = end >= count && (!streaming || follow);
    last.textContent = streaming && !follow ? '跟随最新' : '最新';
    if (end < count) { if (more.parentElement !== node) node.append(more); } else more.remove();
  }
  function update(text, { streaming: live = false, retention: kept = null } = {}) {
    const source = typeof text === 'string' ? text : '';
    const before = split.text;
    split = splitSegments(source, { previous: split });
    // Not an append (replacement, edit, deletion, rolling trim): a segment's rendered node is reused only
    // if its whole range lies inside the unchanged common prefix, so new content is always rendered.
    if (!split.appended) {
      const same = commonPrefix(before, source);
      for (const [index, entry] of cache) if (entry.end >= same) cache.delete(index);
    }
    const nextRetention = kept && !kept.complete ? kept : { complete: true, omitted: 0, released: 0 };
    if (nextRetention.complete !== retention.complete) copy.textContent = nextRetention.complete ? '复制全文' : '复制保留部分';
    retention = nextRetention;
    const wasStreaming = streaming; streaming = live;
    const max = Math.max(0, split.segments.length - LONG_TEXT.window);
    if (!seen) { start = live ? max : 0; follow = live; seen = true; }
    else if (live && follow) start = max;
    else if (!live && wasStreaming && follow) start = max; // finished while watching the tail: stay there
    start = Math.min(start, max);
    // The open (last) segment is re-rendered each update; a finished body re-renders it once.
    if (wasStreaming !== live) for (const entry of cache.values()) entry.open = true;
    paint();
  }
  return { node, update, get window() { return { start, end: Math.min(split.segments.length, start + LONG_TEXT.window), count: split.segments.length, follow, rendered: cache.size }; }, release() { cache.clear(); body.replaceChildren(); } };
}

// ---------- View ----------

export function mountConversation(host, { onLocalLink, getCwd = () => '', getThreadId = () => '', onAnswerAsync, onCopy, artifacts = null, loadAgentThread, onOpenAgent } = {}) {
  const document = host.ownerDocument;
  const turns = new Map(); // turn id -> view
  const userOpen = new Map(); // process key -> boolean chosen by the user
  const agentExpanded = new Map();
  const agentDetails = new Map();
  const fileState = new Map(); // turn id -> {expanded, openPaths:Set, all:boolean}
  const imageRefs = new Map(); // answer id -> {text, refs}
  const asyncInputs = new Map(); // thread/item identity keeps unsubmitted drafts across history refreshes.
  let runningClocks = [];

  const markdownSegment = source => {
    const box = el(document, 'div', 'markdown-segment');
    box.append(renderMarkdown(document, source, { onLocalLink, onCopy, cwd: getCwd(), complete: true }));
    return box;
  };
  const answerRefs = answer => {
    const cached = imageRefs.get(answer.id);
    if (cached && cached.text === answer.text) return cached.refs;
    const refs = markdownImageRefs(answer.text); imageRefs.set(answer.id, { text: answer.text, refs }); return refs;
  };

  function messageView(item) {
    const isUser = item.type === 'userMessage';
    const node = el(document, 'article', `message ${isUser ? 'userMessage' : 'agentMessage'}`);
    node.dataset.itemId = item.id;
    const body = el(document, 'div', 'message-text');
    node.append(body);
    return { node, body, item: null, steer: null, text: null, complete: null, content: null, kept: null, long: null };
  }
  function updateMessage(view, item, { steer = false } = {}) {
    if (item.type === 'userMessage') {
      const content = JSON.stringify((item.content || []).map(part => part?.type === 'text' ? { type: 'text', size: part.text?.length } : part));
      const text = (item.content || []).filter(part => part?.type === 'text').map(part => part.text).join('\n');
      const retention = retentionOf(item, (item.content || []).map((part, index) => part?.type === 'text' ? 'content.' + index : null).filter(Boolean));
      const kept = JSON.stringify(retention);
      if (view.item && view.steer === steer && view.content === content && view.text === text && view.kept === kept) return;
      view.item = item; view.steer = steer; view.content = content; view.text = text; view.kept = kept;
      view.node.classList.toggle('steer', steer);
      const parts = [];
      if (steer) parts.push(el(document, 'span', 'message-tag', '运行中补充'));
      const media = (item.content || []).filter(part => ['image', 'localImage'].includes(part?.type));
      const bubble = el(document, 'div', 'message-bubble');
      if (text) {
        view.long ||= longTextView(document, { render: source => document.createTextNode(source), label: '消息', onCopy });
        view.long.update(text, { retention }); bubble.append(view.long.node);
      }
      parts.push(bubble);
      view.media?.release?.();view.media=null;
      if (media.length) {
        const row = el(document, 'div', 'message-media');
        view.media=artifacts?.strip(artifactCandidates(item));
        if(view.media)row.append(view.media);
        else for (const part of media) { const chip = el(document, 'span', 'media-chip','图片'); row.append(chip); }
        parts.push(row);
      }
      view.body.replaceChildren(...parts);
      return;
    }
    const definition = asyncInputDefinition(item);
    if (definition) {
      const threadId = getThreadId(), key = JSON.stringify([threadId, item.id]);
      let input = asyncInputs.get(key);
      if (!input) { input = createAsyncInputCard(document, item, { threadId, onAnswerAsync }); asyncInputs.set(key, input); }
      else input.update(item, { threadId, onAnswerAsync });
      if (view.asyncInput !== input) { view.asyncInput?.node.remove(); view.asyncInput = input; view.node.append(input.node); }
    } else { view.asyncInput?.node.remove(); view.asyncInput = null; }
    // Full body: equal-length corrections repaint because the strings differ.
    const text = asyncInputBodyText(item, String(itemText(item) ?? ''));
    view.body.hidden = !text.trim();
    const retention = retentionOf(item, ['text']); const kept = JSON.stringify(retention);
    if (view.item && view.text === text && view.complete === item._complete && view.kept === kept) return;
    view.item = item; view.text = text; view.complete = item._complete; view.kept = kept;
    view.body.classList.add('markdown-body');
    view.node.classList.toggle('streaming', item._complete === false);
    if (!view.long) { view.long = longTextView(document, { render: markdownSegment, label: '答复', onCopy }); view.body.replaceChildren(view.long.node); }
    view.long.update(text, { streaming: item._complete === false, retention });
  }

  function rowView(item) {
    const node = el(document, 'details', 'step');
    node.dataset.itemId = item.id;
    const summary = el(document, 'summary', 'step-summary');
    const symbol = el(document, 'span', 'step-icon');
    const verb = el(document, 'span', 'step-verb');
    const target = el(document, 'span', 'step-target');
    const state = el(document, 'span', 'step-state');
    summary.append(symbol, verb, target, state);
    node.append(summary);
    const view = { node, symbol, verb, target, state, iconName: '', item, pre: null, output: null };
    summary.addEventListener('click',event=>{
      const item=view.item;
      const native=item.type==='subAgentActivity'?item.agentThreadId:item.type==='collabAgentToolCall'?item.receiverThreadIds?.[0]:null;
      const dsh=item.type==='mcpToolCall'&&/dsh/i.test(item.server||'')?(item.arguments?.agent_id||dshToolResultAgentId(item.result)):null;
      if(onOpenAgent&&(native||dsh)){event.preventDefault();onOpenAgent(native||dsh,native?'native':'dsh');}
    });
    node.addEventListener('toggle', () => renderRowDetail(view));
    return view;
  }
  function renderRowDetail(view) {
    if (!view.node.open) return;
    const candidates=artifacts?artifactCandidates(view.item):[];
    if(candidates.length){
      const signature=JSON.stringify(candidates);
      if(view.imageSignature!==signature){view.images?.release?.();view.images?.remove();view.images=artifacts.strip(candidates);view.imageSignature=signature;view.node.append(view.images);}
      if(view.item.type==='imageView')return;
    }else if(view.images){
      view.images.release?.();view.images.remove();view.images=null;view.imageSignature=null;
    }
    if (view.item.type === 'fileChange') {
      const box = el(document, 'div', 'step-detail');
      for (const change of view.item.changes || []) { box.append(el(document, 'div', 'diff-file-name', change?.path || '')); box.append(renderDiff(document, change?.diff)); }
      if (view.pre) view.pre.remove(); view.pre = box; view.node.append(box); return;
    }
    if (view.item.type === 'commandExecution') {
      // Full output (head, tail and everything retained) in bounded segments; the latest tail while running.
      if (!view.output) {
        view.pre?.remove();
        const box = el(document, 'div', 'step-detail step-command');
        const head = el(document, 'pre', 'step-output-head');
        view.output = { box, head, long: longTextView(document, { render: source => el(document, 'pre', 'step-output', source), label: '输出', onCopy }) };
        box.append(head, view.output.long.node); view.pre = box; view.node.append(box);
      }
      const item = view.item; const meta = [item.command ? '$ ' + item.command : '', typeof item.exitCode === 'number' ? `退出码 ${item.exitCode}${typeof item.durationMs === 'number' ? ' · ' + formatDuration(item.durationMs) : ''}` : ''].filter(Boolean).join('\n');
      setText(view.output.head, meta); view.output.head.hidden = !meta;
      const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '';
      view.output.long.update(output || (meta ? '' : '此步骤没有可显示的详细内容。'), { streaming: itemState(item) === 'running', retention: retentionOf(item, ['aggregatedOutput']) });
      return;
    }
    if (!view.pre) { view.pre = el(document, 'pre', 'step-detail'); view.node.append(view.pre); }
    setText(view.pre, detailText(view.item));
  }
  function updateRow(view, item, now=Date.now(), live=view.live??false) {
    view.item = item;
    view.live = live;
    const info = describeItem(item,now); const state = itemState(item);
    if (view.iconName !== info.icon) { view.symbol.replaceChildren(icon(document, info.icon, { size: 14 })); view.iconName = info.icon; }
    setText(view.verb, info.verb);
    setText(view.target, info.target);
    view.target.classList.toggle('code', !!info.code);
    setText(view.state, STATE_TEXT[state]);
    view.state.hidden = !STATE_TEXT[state];
    view.node.dataset.state = state;
    view.node.dataset.running = String(live && state === 'running');
    if (view.node.open) renderRowDetail(view);
  }

  function processView(key) {
    const node = el(document, 'details', 'turn-process');
    const summary = el(document, 'summary', 'turn-process-summary');
    const label = el(document, 'span', 'turn-process-label');
    const latest=el(document,'span','turn-process-latest');
    const chevron = icon(document, 'down', { size: 14 });
    summary.append(label, latest, chevron);
    const list = el(document, 'div', 'turn-process-items');
    node.append(summary, list);
    // `toggle` is queued and coalesced by browsers, so a flag around `.open =` cannot identify our own changes.
    // Only a state that differs from the last automatic state is a user choice.
    const view = { key, node, summary, label, latest, list, rows: new Map(), notes: new Map(), autoOpen: null };
    node.addEventListener('toggle', () => {
      if (node.open === view.autoOpen) return;
      view.autoOpen = node.open;
      userOpen.set(key, node.open);
      if (node.open) for (const row of view.rows.values()) renderRowDetail(row);
    });
    return view;
  }
  function updateProcess(view, items, { running, label, first }) {
    const nodes = [];
    for (const item of items) {
      if (item.type === 'agentMessage') {
        let note = view.notes.get(item.id);
        if (!note) { note = messageView(item); note.node.classList.add('process-note'); view.notes.set(item.id, note); }
        updateMessage(note, item); nodes.push(note.node);
      } else {
        let row = view.rows.get(item.id);
        if (!row) { row = rowView(item); view.rows.set(item.id, row); }
        updateRow(row, item, Date.now(), running); nodes.push(row.node);
      }
    }
    const ids = new Set(items.map(item => item.id));
    for (const id of view.rows.keys()) if (!ids.has(id)) {view.rows.get(id).images?.release?.();view.rows.delete(id);}
    for (const id of view.notes.keys()) if (!ids.has(id)) view.notes.delete(id);
    reconcile(view.list, nodes);
    setText(view.label, `${items.length} 项操作${running?' · 运行中':''}`);
    const info=items.length?describeItem(items.at(-1)):null;
    setText(view.latest,running&&info?`${info.verb}${!info.code&&info.target?' · '+info.target.slice(0,90):''}`:'');
    view.latest.hidden=!running;
    view.node.dataset.running = String(running);
    view.node.classList.toggle('first', first);
    view.node.classList.toggle('empty', !items.length);
    // Every operation group starts collapsed, including while running. Preserve explicit user choices.
    const wanted = userOpen.has(view.key) ? userOpen.get(view.key) : false;
    view.autoOpen = wanted;
    if (view.node.open !== wanted) view.node.open = wanted;
  }

  function filesView(turnId) {
    const node = el(document, 'section', 'files-card');
    const head = el(document, 'div', 'files-head');
    const symbol = el(document, 'span', 'files-icon'); symbol.append(icon(document, 'file', { size: 16 }));
    const titles = el(document, 'div', 'files-titles');
    const title = el(document, 'strong', 'files-title');
    const stats = el(document, 'span', 'files-stats');
    titles.append(title, stats);
    const toggleAll = el(document, 'button', 'files-view', '查看变更'); toggleAll.type = 'button';
    head.append(symbol, titles, toggleAll);
    const list = el(document, 'ul', 'files-list');
    const more = el(document, 'button', 'files-more'); more.type = 'button';
    node.append(head, list, more);
    const view = { node, title, stats, toggleAll, list, more, rows: new Map(), summary: null };
    const ui = () => { if (!fileState.has(turnId)) fileState.set(turnId, { expanded: false, all: false, open: new Set() }); return fileState.get(turnId); };
    toggleAll.addEventListener('click', () => { const s = ui(); s.all = !s.all; s.open = new Set(s.all ? view.summary.rows.map(row => row.path) : []); if (s.all) s.expanded = true; updateFiles(view, view.summary, turnId); });
    more.addEventListener('click', () => { const s = ui(); s.expanded = !s.expanded; updateFiles(view, view.summary, turnId); });
    view.ui = ui;
    return view;
  }
  function fileRow(path) {
    const node = el(document, 'li', 'file-row');
    const button = el(document, 'button', 'file-row-head'); button.type = 'button';
    const name = el(document, 'span', 'file-name');
    const stats = el(document, 'span', 'file-stats');
    button.append(name, stats); node.append(button);
    return { node, button, name, stats, path, diffNode: null, signature: null };
  }
  function updateFiles(view, summary, turnId) {
    view.summary = summary;
    const s = view.ui();
    setText(view.title, summary.running ? `正在编辑 ${summary.count} 个文件` : `已编辑 ${summary.count} 个文件`);
    view.stats.replaceChildren(statsNode(document, summary.added, summary.removed, summary));
    setText(view.toggleAll, s.all ? '收起变更' : '查看变更');
    view.toggleAll.setAttribute('aria-expanded', String(s.all));
    const visible = s.expanded ? summary.rows : summary.rows.slice(0, FILE_PREVIEW);
    const nodes = [];
    for (const file of visible) {
      let row = view.rows.get(file.path);
      if (!row) {
        row = fileRow(file.path); view.rows.set(file.path, row);
        row.button.addEventListener('click', () => { const st = view.ui(); if (st.open.has(row.path)) st.open.delete(row.path); else st.open.add(row.path); updateFiles(view, view.summary, turnId); });
      }
      const slash = file.path.lastIndexOf('/');
      row.name.replaceChildren(el(document, 'span', 'file-dir', slash >= 0 ? file.path.slice(0, slash + 1) : ''), el(document, 'span', 'file-base', slash >= 0 ? file.path.slice(slash + 1) : file.path));
      row.button.title = file.fullPath;
      row.stats.replaceChildren(statsNode(document, file.added, file.removed, file));
      const open = s.open.has(file.path);
      row.button.setAttribute('aria-expanded', String(open));
      row.node.classList.toggle('open', open);
      const signature = open ? file.diffs.join('\n\u0000') : null;
      if (row.signature !== signature) {
        row.diffNode?.remove(); row.diffNode = null;
        if (open) { row.diffNode = file.diffs.length ? renderDiff(document, file.diffs.join('\n')) : el(document, 'p', 'diff-empty', '没有可显示的差异内容。'); row.node.append(row.diffNode); }
        row.signature = signature;
      }
      nodes.push(row.node);
    }
    const shownPaths = new Set(visible.map(file => file.path));
    for (const path of view.rows.keys()) if (!shownPaths.has(path)) view.rows.delete(path);
    reconcile(view.list, nodes);
    const hidden = summary.rows.length - FILE_PREVIEW;
    view.more.hidden = hidden <= 0;
    view.more.replaceChildren(el(document, 'span', '', s.expanded ? '收起' : `再显示 ${hidden} 个文件`), icon(document, s.expanded ? 'up' : 'down', { size: 14 }));
    view.more.setAttribute('aria-expanded', String(s.expanded));
  }

  function turnView(id) {
    const node = el(document, 'section', 'turn');
    node.dataset.turnId = id;
    const footer = el(document, 'p', 'turn-footer');
    const work = el(document, 'details', 'turn-work');
    const summary = el(document, 'summary', 'turn-work-summary');
    const workLabel = el(document, 'span', 'turn-work-label');
    summary.append(workLabel, icon(document, 'right', { size: 14 }));
    const workBody = el(document, 'div', 'turn-work-body'); work.append(summary, workBody);
    return { node, footer, work, workLabel, workBody, segments: new Map(), messages: new Map(), compactions: new Map(), files: null, agents: null, agentsSig: null, art: null, artSig: null };
  }
  function releaseSegment(view){for(const row of view.rows.values())row.images?.release?.();}
  function releaseTurn(view){view.art?.release?.();for(const segment of view.segments.values())releaseSegment(segment);for(const message of view.messages.values())message.media?.release?.();}

  function timingLabel(turn, now) {
    const t = turn.timing;
    if (t.kind === 'running') return t.startMs !== null ? `正在工作 · ${formatDuration(Math.max(0, now - t.startMs))}` : '正在工作';
    if (t.durationMs !== null) return `用时${t.approximate ? '约' : ''} ${formatDuration(t.durationMs)}`;
    return turn.processCount ? `已处理 ${turn.processCount} 步` : '';
  }

  function render(list, { now = Date.now() } = {}) {
    const keep = new Set(); const nodes = []; runningClocks = [];
    for (const turn of list) {
      keep.add(turn.id);
      let view = turns.get(turn.id);
      if (!view) { view = turnView(turn.id); turns.set(turn.id, view); }
      view.node.dataset.state = turn.status;
      const children = []; const segmentKeys = new Set(); const messageIds = new Set();
      const chronological=turn.items||turn.segments.flatMap(segment=>[segment.user,...segment.process,...segment.answers].filter(Boolean));
      const steerIds=new Set(turn.segments.filter(segment=>segment.steer&&segment.user).map(segment=>segment.user.id));
      let operations=[];
      const flushOperations=tail=>{
        if(!operations.length)return;
        const items=operations;operations=[];
        const key=`${turn.id}:operations:${items[0].id}`;segmentKeys.add(key);
        let process=view.segments.get(key);
        if(!process){process=processView(key);view.segments.set(key,process);}
        const running=tail&&!turn.finished&&items.some(item=>itemState(item)==='running');
        updateProcess(process,items,{running,first:false});children.push(process.node);
        if(running&&items.some(item=>item.type==='reasoning'&&itemState(item)==='running'&&Number.isFinite(item._startedAtMs)))runningClocks.push({process,items});
      };
      for(const item of chronological){
        if(item.type==='contextCompaction'){
          flushOperations(false);
          let compaction=view.compactions.get(item.id);
          if(!compaction){compaction=renderCompactionRecord(document,item);view.compactions.set(item.id,compaction);}
          updateCompactionRecord(compaction,item);children.push(compaction);continue;
        }
        if(item.type!=='userMessage'&&item.type!=='agentMessage'){operations.push(item);continue;}
        flushOperations(false);
        let message=view.messages.get(item.id);
        if(!message){message=messageView(item);view.messages.set(item.id,message);}
        messageIds.add(item.id);updateMessage(message,item,{steer:steerIds.has(item.id)});children.push(message.node);
      }
      flushOperations(true);
      for (const key of view.segments.keys()) if (!segmentKeys.has(key)) {releaseSegment(view.segments.get(key));view.segments.delete(key);}
      for (const id of view.messages.keys()) if (!messageIds.has(id)) {view.messages.get(id).media?.release?.();view.messages.delete(id);}
      const turnItems=chronological.filter(item=>item.type!=='userMessage');
      // Generated / referenced images: only explicit native paths and markdown image refs in answers.
      if (artifacts) {
        const candidates = turnItems.filter(item=>item.type==='imageGeneration').flatMap(artifactCandidates);
        for (const answer of turn.segments.flatMap(segment => segment.answers)) for (const ref of answerRefs(answer)) candidates.push({ key: answer.id + ':' + ref.path, kind: 'referenced', path: ref.path, status: answer._complete === false ? 'running' : 'done', caption: ref.alt, reason: '' });
        const unique = [...new Map(candidates.map(row => [row.key, row])).values()].slice(0, 12);
        if (unique.length) {
          const sig = JSON.stringify(unique);
          if (view.artSig !== sig) { view.art?.release?.(); view.art = artifacts.strip(unique); view.artSig = sig; }
          children.push(view.art);
        }
      }
      if (turn.files.count && ['completed','interrupted','failed','error'].includes(turn.status)) {
        if (!view.files) view.files = filesView(turn.id);
        updateFiles(view.files, turn.files, turn.id); children.push(view.files.node);
      }
      const footer = turn.status === 'interrupted' ? '已停止' : turn.status === 'failed' ? `任务失败${turn.error ? '：' + turn.error : ''}` : turn.finished&&turn.timing.durationMs!==null?timingLabel(turn,now):'';
      setText(view.footer, footer);
      view.footer.dataset.kind = turn.status;
      if (turn.finished) {
        // Keep the prompt and final answer outside; completed intermediate work is one disclosure
        // above the answer. Its DOM survives re-renders, preserving an explicit expansion.
        const answerIds = new Set(turn.segments.flatMap(segment => segment.answers.map(answer => answer.id)));
        const firstUser = children.find(child => child.classList.contains('userMessage'));
        const intermediates = children.filter(child => child !== firstUser && !answerIds.has(child.dataset.itemId) && child !== view.files?.node && child !== view.art);
        const rest = children.filter(child => !intermediates.includes(child));
        const insertion = firstUser ? rest.indexOf(firstUser) + 1 : 0;
        if (intermediates.length) {
          setText(view.workLabel, footer || ('已处理 ' + turn.processCount + ' 步'));
          view.work.dataset.kind = turn.status;
          reconcile(view.workBody, intermediates);
          rest.splice(insertion, 0, view.work);
        } else if (footer) { rest.splice(insertion, 0, view.footer); }
        reconcile(view.node, rest);
      } else {
        view.work.open = false; // every running → completed transition starts collapsed
        if (footer) children.push(view.footer);
        reconcile(view.node, children);
      }
      nodes.push(view.node);
    }
    for (const [id, view] of turns) if (!keep.has(id)) { releaseTurn(view); turns.delete(id); }
    const liveAnswers = new Set(list.flatMap(turn => turn.segments.flatMap(segment => segment.answers.map(answer => answer.id))));
    for (const id of imageRefs.keys()) if (!liveAnswers.has(id)) imageRefs.delete(id);
    const focused = document.activeElement; const keepFocus = focused && host.contains(focused);
    reconcile(host, nodes);
    if (keepFocus && host.contains(focused) && document.activeElement !== focused) focused.focus?.({ preventScroll: true });
  }

  /** Updates live elapsed labels without rebuilding the tree. */
  function tick(now = Date.now()) { for (const {process,items} of runningClocks) {
    for(const item of items)if(item.type==='reasoning'&&itemState(item)==='running'){const row=process.rows.get(item.id);if(row)updateRow(row,item,now);}
    const info=describeItem(items.at(-1),now);setText(process.latest,`${info.verb}${!info.code&&info.target?' · '+info.target.slice(0,90):''}`);
  } }
  function clear() { for(const view of turns.values())releaseTurn(view);turns.clear(); userOpen.clear(); agentExpanded.clear(); agentDetails.clear(); fileState.clear(); imageRefs.clear(); runningClocks = []; host.replaceChildren(); artifacts?.clear(); }
  return { render, tick, clear, hasRunningClock: () => runningClocks.length > 0 };
}
