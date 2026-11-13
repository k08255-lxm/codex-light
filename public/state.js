// Pure conversation state: turn/phase grouping, timing, per-turn file changes,
// context snapshots, the per-thread follow-up queue and the slash catalog.
// No DOM, no network. Every unknown value stays unknown instead of becoming 0.
import {delegatedItemsForTurn,mergeDelegatedFileSummary} from './delegated-changes.js';

const PROCESS_TYPES = new Set(['reasoning', 'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch',
  'collabAgentToolCall', 'subAgentActivity', 'imageView', 'imageGeneration', 'plan', 'contextCompaction', 'hookPrompt',
  'functionCallOutput', 'sleep', 'enteredReviewMode', 'exitedReviewMode']);
const ANSWER_PHASES = new Set(['final_answer', 'partial_answer']);
const TURN_STATUS = { inProgress: 'running', completed: 'completed', interrupted: 'interrupted', failed: 'failed' };

const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const text = value => typeof value === 'string' ? value : '';

/** Normalizes a native Turn (from turns/list, read, started/completed events). */
export function turnMeta(turn, previous = {}) {
  if (!turn || typeof turn.id !== 'string' || !turn.id) return null;
  const meta = { ...previous, id: turn.id };
  if (typeof turn.status === 'string') meta.status = turn.status;
  if (finite(turn.startedAt)) meta.startedAtMs = turn.startedAt * 1000;
  if (finite(turn.completedAt)) meta.completedAtMs = turn.completedAt * 1000;
  if (finite(turn.durationMs)) meta.durationMs = turn.durationMs;
  if (turn.error && typeof turn.error === 'object') meta.error = text(turn.error.message).slice(0, 2000) || '任务失败';
  return meta;
}

/** Keeps turn metadata per thread. Observed times are a fallback only when the server omits them. */
export class TurnLedger {
  constructor() { this.turns = new Map(); }
  clear() { this.turns.clear(); }
  get(id) { return this.turns.get(id) || null; }
  merge(turn, { observedStartMs, observedEndMs } = {}) {
    const meta = turnMeta(turn, this.turns.get(turn?.id));
    if (!meta) return null;
    if (finite(observedStartMs) && meta.observedStartMs === undefined) meta.observedStartMs = observedStartMs;
    if (finite(observedEndMs) && meta.status && meta.status !== 'inProgress') meta.observedEndMs = observedEndMs;
    this.turns.set(meta.id, meta);
    return meta;
  }
  setDiff(turnId, diff) {
    if (typeof turnId !== 'string' || !turnId) return;
    const meta = this.turns.get(turnId) || { id: turnId };
    meta.diff = text(diff).slice(0, 262144);
    this.turns.set(turnId, meta);
  }
  /** Marks a turn active from a send acknowledgement (turn/start or steer). */
  activate(turnId, now) {
    const meta = this.turns.get(turnId) || { id: turnId };
    if (!meta.status) meta.status = 'inProgress';
    if (meta.observedStartMs === undefined && finite(now)) meta.observedStartMs = now;
    this.turns.set(turnId, meta);
    return meta;
  }
}

export function formatDuration(ms) {
  if (!finite(ms)) return '';
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60), rest = seconds % 60;
  if (minutes < 60) return `${minutes}m ${String(rest).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * Timing for one turn. Running turns return a start instant for a live clock.
 * Completed turns prefer the server duration; item timestamps are labelled approximate.
 */
export function turnTiming(meta, items = [], { running = false } = {}) {
  const starts = items.map(item => item._startedAtMs).filter(finite);
  const ends = items.map(item => item._completedAtMs).filter(finite);
  const start = finite(meta?.startedAtMs) ? meta.startedAtMs : finite(meta?.observedStartMs) ? meta.observedStartMs : null;
  if (running) {
    if (start !== null) return { kind: 'running', startMs: start, approximate: false };
    if (starts.length) return { kind: 'running', startMs: Math.min(...starts), approximate: true };
    return { kind: 'running', startMs: null, approximate: false };
  }
  if (finite(meta?.durationMs)) return { kind: 'done', durationMs: meta.durationMs, approximate: false };
  if (finite(meta?.startedAtMs) && finite(meta?.completedAtMs) && meta.completedAtMs >= meta.startedAtMs) return { kind: 'done', durationMs: meta.completedAtMs - meta.startedAtMs, approximate: false };
  if (finite(meta?.observedStartMs) && finite(meta?.observedEndMs) && meta.observedEndMs >= meta.observedStartMs) return { kind: 'done', durationMs: meta.observedEndMs - meta.observedStartMs, approximate: false };
  if (starts.length && ends.length) {
    const span = Math.max(...ends) - Math.min(...starts);
    if (span >= 0) return { kind: 'done', durationMs: span, approximate: true };
  }
  return { kind: 'done', durationMs: null, approximate: false };
}

/** Classifies an agent message. `null` phase falls back to "last message of a finished turn is the answer". */
function isAnswer(item, finished, lastLegacyId, hasPhasedAnswer) {
  if (ANSWER_PHASES.has(item.phase)) return true;
  if (item.phase === 'commentary') return false;
  return finished && !hasPhasedAnswer && item.id === lastLegacyId;
}

function turnStatus(meta, items, activeTurnId, id) {
  if (id && id === activeTurnId) return 'running';
  const mapped = TURN_STATUS[meta?.status];
  if (mapped) return mapped;
  if (items.some(item => item._complete === false)) return 'running';
  return 'unknown';
}

/**
 * Groups chronological items into turns and segments.
 * - A turn is keyed by its native `turnId`; items without one start a local turn at each user message.
 * - Each user message starts a segment; later user messages in a running turn are steers.
 * - Answers (final/partial, or the last legacy message of a finished turn) stay outside the process list.
 */
export function buildTurns(items, ledger, { activeTurnId = null, cwd = '', delegatedChanges = [] } = {}) {
  const order = []; const byId = new Map(); let current = null;
  for (const item of items) {
    let id = typeof item._turnId === 'string' && item._turnId ? item._turnId : null;
    if (!id) {
      if (item.type === 'userMessage' || !current) id = `local:${item.id}`;
      else id = current.id;
    }
    let turn = byId.get(id);
    if (!turn) { turn = { id, local: id.startsWith('local:'), items: [] }; byId.set(id, turn); order.push(turn); }
    turn.items.push(item); current = turn;
  }
  return order.map(turn => {
    const meta = turn.local ? null : ledger?.get?.(turn.id) || null;
    const status = turnStatus(meta, turn.items, activeTurnId, turn.local ? null : turn.id);
    const finished = status !== 'running';
    const agents = turn.items.filter(item => item.type === 'agentMessage');
    // A partial answer is not evidence that the final text was separated; only final_answer is.
    const hasPhasedAnswer = agents.some(item => item.phase === 'final_answer');
    const lastLegacyId = [...agents].reverse().find(item => !item.phase)?.id || null;
    const segments = [];
    let segment = null;
    for (const item of turn.items) {
      if (item.type === 'userMessage') {
        segment = { key: `${turn.id}:${item.id}`, user: item, steer: segments.length > 0, process: [], answers: [] };
        segments.push(segment); continue;
      }
      if (!segment) { segment = { key: `${turn.id}:lead`, user: null, steer: false, process: [], answers: [] }; segments.push(segment); }
      if (item.type === 'agentMessage') {
        (isAnswer(item, finished, lastLegacyId, hasPhasedAnswer) ? segment.answers : segment.process).push(item);
      } else if (PROCESS_TYPES.has(item.type) || item.type !== 'userMessage') segment.process.push(item);
    }
    const processCount = segments.reduce((sum, row) => sum + row.process.length, 0);
    return {
      id: turn.id, local: turn.local, status, finished, meta, segments, processCount, items:turn.items,
      timing: turnTiming(meta, turn.items, { running: !finished }),
      delegatedChanges:delegatedChanges.filter(record=>record.turnId===turn.id),
      files:mergeDelegatedFileSummary(fileSummary(turn.items,meta?.diff,{cwd,running:!finished}),fileSummary(delegatedItemsForTurn(delegatedChanges,turn.id,cwd),null,{cwd,running:!finished}),{cwd}),
      error: meta?.error || null,
    };
  });
}

// ---------- File changes ----------

const stripPrefix = path => path.replace(/^[ab]\//, '');
export function normalizePath(path) { return text(path).replace(/\\/g, '/').replace(/\/+/g, '/'); }
// Windows paths are case-insensitive; POSIX paths are not.
const isWindowsPath = path => /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\') || path.includes('\\');
const pathKey = path => isWindowsPath(text(path)) ? normalizePath(path).toLowerCase() : normalizePath(path);

/** Decodes a Git C-style quoted path ("a/\346\226\207.md"), including octal UTF-8 bytes. */
export function unquoteGitPath(value) {
  const source = text(value).trim();
  if (!source.startsWith('"') || !source.endsWith('"') || source.length < 2) return source;
  const bytes = []; const body = source.slice(1, -1); const encoder = new TextEncoder();
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char !== '\\') { bytes.push(...encoder.encode(char)); continue; }
    const next = body[++i];
    if (/[0-7]/.test(next)) { const octal = body.slice(i, i + 3).match(/^[0-7]{1,3}/)[0]; bytes.push(parseInt(octal, 8)); i += octal.length - 1; }
    else bytes.push(...encoder.encode({ n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', a: '\x07', b: '\b', f: '\f', v: '\v' }[next] ?? next));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
function gitHeaderPaths(rest) {
  const tokens = []; let i = 0;
  while (i < rest.length && tokens.length < 2) {
    if (rest[i] === ' ') { i++; continue; }
    if (rest[i] === '"') { let j = i + 1; while (j < rest.length && rest[j] !== '"') j += rest[j] === '\\' ? 2 : 1; tokens.push(unquoteGitPath(rest.slice(i, j + 1))); i = j + 1; }
    else { const b = rest.indexOf(' b/', i); if (tokens.length === 0 && b > i) { tokens.push(rest.slice(i, b)); i = b + 1; } else { tokens.push(rest.slice(i)); i = rest.length; } }
  }
  return tokens;
}

/** Splits a unified diff into files with added/removed line counts. Binary files have unknown stats. */
export function parseUnifiedDiff(source) {
  const files = []; let file = null; let oldPath = '';
  let oldLeft = 0, newLeft = 0; // remaining hunk lines, from the @@ header counts
  const lines = text(source).replace(/\r\n?/g, '\n').split('\n');
  const start = path => { file = { path, added: 0, removed: 0, known: true, lines: [] }; files.push(file); oldLeft = newLeft = 0; oldPath = ''; };
  const headerPath = line => { const raw = line.slice(4).trim(); return raw.startsWith('"') ? unquoteGitPath(raw) : raw.split('\t')[0]; };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const inHunk = oldLeft > 0 || newLeft > 0;
    if (inHunk && file) {
      if (line.startsWith('+')) { file.added++; newLeft--; }
      else if (line.startsWith('-')) { file.removed++; oldLeft--; }
      else if (line.startsWith('\\')) { /* "No newline at end of file" */ }
      else { oldLeft--; newLeft--; }
      file.lines.push(line); continue;
    }
    if (line.startsWith('diff --git ')) { const paths = gitHeaderPaths(line.slice(11)); start(stripPrefix(paths[1] || paths[0] || '')); file.lines.push(line); continue; }
    if (line.startsWith('--- ') && lines[index + 1]?.startsWith('+++ ')) {
      if (!file || file.lines.some(row => row.startsWith('--- '))) start('');
      oldPath = headerPath(line); file.lines.push(line); continue;
    }
    if (line.startsWith('+++ ') && file) {
      const target = headerPath(line);
      const chosen = target !== '/dev/null' ? target : oldPath;
      if (chosen && chosen !== '/dev/null') file.path = stripPrefix(chosen);
      file.lines.push(line); continue;
    }
    if (!file) continue;
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) { oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]); newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]); file.lines.push(line); continue; }
    if (/^Binary files .* differ$/.test(line) || line.startsWith('GIT binary patch')) file.known = false;
    file.lines.push(line);
  }
  return files.filter(row => row.path).map(row => ({ path: row.path, added: row.known ? row.added : null, removed: row.known ? row.removed : null, diff: row.lines.join('\n') }));
}

/** Line stats for one native FileUpdateChange. Add/delete carry full content; update carries a unified diff. */
export function changeStats(change) {
  const diff = text(change?.diff); const kind = change?.kind?.type || change?.kind;
  if (!diff) return { added: null, removed: null };
  const lines = () => diff.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').length;
  // Add/delete carry full file contents, which may legitimately contain "@@" lines.
  if (kind === 'add') return { added: lines(), removed: 0 };
  if (kind === 'delete') return { added: 0, removed: lines() };
  if (/^@@ /m.test(diff)) {
    const [parsed] = parseUnifiedDiff(`--- a/x\n+++ b/x\n${diff.replace(/^(?:---|\+\+\+) .*\n/gm, (header, offset) => offset < diff.indexOf('@@') ? '' : header)}`);
    return parsed ? { added: parsed.added, removed: parsed.removed } : { added: null, removed: null };
  }
  return { added: null, removed: null };
}

function displayPath(path, cwd) {
  const normal = normalizePath(path); const base = normalizePath(cwd).replace(/\/$/, '');
  if (base && normal.toLowerCase().startsWith(base.toLowerCase() + '/')) return normal.slice(base.length + 1);
  return normal;
}

/**
 * Per-turn file summary. fileChange items are deduplicated by path; when a turn diff exists
 * it is authoritative for stats (net change) and absolute item paths are matched by suffix.
 */
export function fileSummary(items, turnDiff, { cwd = '', running = false } = {}) {
  const files = new Map();
  for (const item of items) {
    if (item.type !== 'fileChange' || ['declined', 'failed'].includes(item.status)) continue;
    for (const change of Array.isArray(item.changes) ? item.changes : []) {
      if (typeof change?.path !== 'string' || !change.path) continue;
      const key = pathKey(change.path); const stats = changeStats(change);
      const row = files.get(key) || { path: displayPath(change.path, cwd), fullPath: change.path, kind: change.kind?.type || null, added: 0, removed: 0, known: true, diffs: [], live: false };
      if (stats.added === null || stats.removed === null) row.known = false;
      else { row.added += stats.added; row.removed += stats.removed; }
      if (change.diff) row.diffs.push(text(change.diff).slice(0, 65536));
      if (item.status === 'inProgress' || item._complete === false) row.live = true;
      files.set(key, row);
    }
  }
  // `undefined`/`null` = no authoritative turn diff yet; a string (even empty) is the current net change.
  const authoritative = typeof turnDiff === 'string';
  const parsed = authoritative ? parseUnifiedDiff(turnDiff) : [];
  if (authoritative && (parsed.length || !text(turnDiff).trim())) {
    const merged = new Map();
    for (const entry of parsed) {
      const rel = pathKey(entry.path);
      let match = null;
      for (const [key, row] of files) if (key === rel || key.endsWith('/' + rel)) { match = [key, row]; break; }
      if (match) files.delete(match[0]);
      merged.set(rel, { path: entry.path, fullPath: match?.[1].fullPath || entry.path, kind: match?.[1].kind || null, added: entry.added, removed: entry.removed,
        known: entry.added !== null, diffs: [entry.diff], live: match?.[1].live || false });
    }
    // Edited files absent from the net diff currently have no net change (e.g. reverted).
    for (const [key, row] of files) merged.set(key, { ...row, known: true, added: 0, removed: 0, diffs: [], net: 'unchanged' });
    return summarize([...merged.values()], running);
  }
  return summarize([...files.values()].map(row => row.known ? row : { ...row, added: null, removed: null }), running);
}

function summarize(rows, running) {
  const known = rows.length > 0 && rows.every(row => row.known);
  return {
    count: rows.length, running, rows,
    added: known ? rows.reduce((sum, row) => sum + row.added, 0) : null,
    removed: known ? rows.reduce((sum, row) => sum + row.removed, 0) : null,
    complete: known,
  };
}

// ---------- Context window ----------

/** Uses the latest request snapshot (`last`) and the real model window; never the cumulative total. */
export function contextSnapshot(params) {
  if (typeof params?.threadId !== 'string' || !params.threadId) return null;
  const usage = params.tokenUsage || {};
  const used = usage.last?.totalTokens;
  const window = usage.modelContextWindow;
  return { threadId: params.threadId, turnId: typeof params.turnId === 'string' ? params.turnId : null,
    used: Number.isSafeInteger(used) && used >= 0 ? used : null,
    window: Number.isSafeInteger(window) && window > 0 ? window : null };
}

export function contextView(snapshot) {
  if (!snapshot || snapshot.used === null || snapshot.window === null) {
    return { known: false, label: '上下文未知', detail: snapshot?.used != null ? `最近一次请求 ${snapshot.used.toLocaleString('zh-CN')} tokens；模型未提供上下文窗口` : '本对话尚未收到上下文用量' };
  }
  const ratio = Math.min(1, snapshot.used / snapshot.window);
  const used = Math.round(ratio * 100);
  return { known: true, percentUsed: used, percentLeft: 100 - used, ratio, label: `${used}%`,
    detail: `上下文已使用约 ${used}% · ${snapshot.used.toLocaleString('zh-CN')} / ${snapshot.window.toLocaleString('zh-CN')} tokens` };
}

// ---------- Running input ----------

/** Steer carries exactly threadId/expectedTurnId/input. Model, effort and cwd are intentionally impossible. */
export function steerParams(threadId, expectedTurnId, message) {
  if (typeof threadId !== 'string' || !threadId || typeof expectedTurnId !== 'string' || !expectedTurnId) throw new Error('当前没有可补充的运行任务。');
  return { threadId, expectedTurnId, input: [{ type: 'text', text: text(message), text_elements: [] }] };
}

let queueSequence = 0;
/**
 * Ordered per-thread follow-ups. Only the head may drain, and only while it is `queued`;
 * a `sending`, `failed` or `unknown` head blocks the thread until the user decides.
 */
export class FollowUpQueue {
  constructor() { this.threads = new Map(); this.paused = new Map(); }
  list(threadId) { return [...(this.threads.get(threadId) || [])].map(item => ({ ...item })); }
  size(threadId) { return this.threads.get(threadId)?.length || 0; }
  add(threadId, entry) {
    if (typeof threadId !== 'string' || !threadId) throw new Error('排队需要已有对话。');
    const rows = this.threads.get(threadId) || [];
    if (rows.length >= 20) throw new Error('每个对话最多排队 20 条消息。');
    const item = { id: `q${Date.now().toString(36)}${(++queueSequence).toString(36)}`, status: 'queued', error: '', text: text(entry.text),
      images: [...(entry.images || [])], files: [...(entry.files || [])], confirmedFileAttachmentIds: [...(entry.confirmedFileAttachmentIds || [])],
      cwd: text(entry.cwd), model: text(entry.model), effort: entry.effort || null, controls:entry.controls?structuredClone(entry.controls):null, createdAt: Date.now() };
    rows.push(item); this.threads.set(threadId, rows); return { ...item };
  }
  update(threadId, id, patch) {
    const row = this.threads.get(threadId)?.find(item => item.id === id); if (!row) return null;
    for (const key of ['text', 'status', 'error']) if (key in patch) row[key] = patch[key];
    return { ...row };
  }
  remove(threadId, id) {
    const rows = this.threads.get(threadId); if (!rows) return null;
    const index = rows.findIndex(item => item.id === id); if (index < 0 || rows[index].status === 'sending') return null;
    const [removed] = rows.splice(index, 1); if (!rows.length) this.threads.delete(threadId); return removed;
  }
  pause(threadId, reason) { if (this.size(threadId)) this.paused.set(threadId, reason || '已暂停'); }
  pauseAll(reason) { for (const id of this.threads.keys()) this.pause(id, reason); }
  resume(threadId) { this.paused.delete(threadId); }
  pausedReason(threadId) { return this.paused.get(threadId) || ''; }
  /** The single item allowed to send next, or null. */
  next(threadId) {
    if (this.paused.has(threadId)) return null;
    const head = this.threads.get(threadId)?.[0];
    return head?.status === 'queued' ? { ...head } : null;
  }
  threadIds() { return [...this.threads.keys()]; }
}

// ---------- Slash menu ----------

export const SLASH_COMMANDS = Object.freeze([
  { id: 'new', name: 'new', icon: 'compose', title: '新聊天', detail: '开始新的草稿对话' },
  { id: 'compact', name: 'compact', icon: 'archive', title: '压缩上下文', detail: '让 Codex 总结并压缩当前对话上下文' },
  { id: 'review', name: 'review', icon: 'review', title: '审查本地改动', detail: '用当前对话审查未提交改动（消耗额度）' },
  { id: 'fork', name: 'fork', icon: 'branch', title: '创建对话分支', detail: '复制当前对话，不调用模型' },
  { id: 'rename', name: 'rename', icon: 'compose', title: '重命名对话', detail: '修改当前对话名称' },
  { id: 'model', name: 'model', icon: 'bolt', title: '模型与思考强度', detail: '打开模型选择' },
  { id: 'usage', name: 'usage', icon: 'chart', title: '用量与性能', detail: '打开统计页' },
  { id: 'account', name: 'account', icon: 'user', title: '账户与额度', detail: '查看登录、额度和重置时间' },
  { id: 'terminal', name: 'terminal', icon: 'terminal', title: '终端', detail: '打开工作目录终端页（不会自动启动 shell）' },
].map(Object.freeze));

/** Returns the slash token touching the caret: `/word` at the start or after whitespace. */
export function slashQuery(value, caret = text(value).length) {
  const source = text(value);
  if (!Number.isSafeInteger(caret) || caret < 1 || caret > source.length) return null;
  const before = source.slice(0, caret);
  const match = /(^|\s)\/([^\s/]*)$/.exec(before);
  if (!match) return null;
  const start = caret - match[2].length - 1;
  // The token extends to the next whitespace so replacing it keeps text after the caret.
  const tail = /^[^\s/]*/.exec(source.slice(caret))[0];
  return { query: (match[2] + tail).toLowerCase(), start, end: caret + tail.length };
}
/** Replaces exactly the slash token, preserving all surrounding draft text. */
export function replaceSlashToken(value, token, insert) {
  const source = text(value); const before = source.slice(0, token.start); let after = source.slice(token.end);
  if (!insert) { after = before && /\s$/.test(before) ? after.replace(/^\s+/, '') : after; return { value: before + after, caret: before.length }; }
  const spaced = /^\s/.test(after) ? insert : insert + ' ';
  return { value: before + spaced + after, caret: before.length + spaced.length };
}

export function slashAvailability(command, ctx) {
  const idleThread = ctx.thread && !ctx.busy && !ctx.sending && ctx.connected;
  switch (command.id) {
    case 'new': return ctx.sending ? { enabled: false, reason: '正在提交消息' } : { enabled: true };
    case 'compact': return !ctx.thread ? { enabled: false, reason: '新聊天尚无上下文' } : !idleThread ? { enabled: false, reason: '任务运行或连接中断时不可用' } : { enabled: true };
    case 'review': case 'fork': case 'rename': return idleThread ? { enabled: true } : { enabled: false, reason: ctx.thread ? '任务运行或连接中断时不可用' : '需要已有对话' };
    case 'model': return ctx.busy || ctx.sending ? { enabled: false, reason: '任务运行时不可更改' } : { enabled: true };
    case 'usage': case 'account': case 'terminal': return { enabled: true };
    default: return { enabled: false, reason: '不支持' };
  }
}

/** Builds menu entries: implemented commands, then enabled skills from `skills/list`. */
export function slashEntries(query, skills, ctx) {
  const q = text(query).toLowerCase();
  const match = (...values) => !q || values.some(value => text(value).toLowerCase().includes(q));
  const commands = SLASH_COMMANDS.filter(command => match(command.name, command.title))
    .map(command => ({ kind: 'command', id: command.id, icon: command.icon, label: '/' + command.name, title: command.title, detail: command.detail, ...slashAvailability(command, ctx) }));
  const skillRows = (Array.isArray(skills) ? skills : []).filter(skill => skill.enabled !== false && typeof skill.name === 'string' && skill.name)
    .filter(skill => match(skill.name, skill.interface?.displayName, skill.shortDescription))
    .slice(0, 50)
    .map(skill => ({ kind: 'skill', id: 'skill:' + skill.name, icon: 'spark', label: '$' + skill.name, title: text(skill.interface?.displayName) || skill.name,
      detail: text(skill.interface?.shortDescription || skill.shortDescription || skill.description).slice(0, 160), enabled: true, name: skill.name }));
  return [...commands, ...skillRows];
}

// ---------- Read-only history paging ----------

/** True when an RPC error means the method (or its parameter shape) is not implemented by this CLI. */
export function isUnsupportedMethod(error) {
  const message = String(error?.message || '');
  if (error?.code === -32601) return true;
  if (error?.code === -32602 && /itemsView|unknown variant/i.test(message)) return true;
  return /method not found|is not supported|not supported yet|unknown method|unknown variant/i.test(message);
}
export const HISTORY_PAGE = Object.freeze({ items: 80, turns: 20, fetchesPerPage: 4, readKeepTurns: 20 });
/** Shared per server instance: which history methods the connected CLI lacks. */
export function historyCapabilities() { return { unsupported: new Set() }; }

/**
 * Pages one thread's history, newest first, without resuming or subscribing to it.
 * Tries `thread/items/list`; if the CLI lacks it, `thread/turns/list` with `itemsView:'full'` and its
 * cursor; only if both are missing, `thread/read` with turns (one full transfer, explicitly reported).
 * `next()` returns chronological items older than everything returned before, at most `max` per call.
 * Items of a fetched page that do not fit are buffered here, never dropped.
 */
export class HistoryPager {
  constructor(rpc, threadId, capabilities = historyCapabilities()) {
    this.rpc = rpc; this.threadId = threadId; this.capabilities = capabilities;
    this.mode = null; this.cursor = null; this.started = false; this.buffer = []; this.requests = [];
    this.read = null; // read mode: { totalTurns, shownTurns }
  }
  /** More history exists, either buffered here or behind the server cursor. */
  get hasMore() { return this.buffer.length > 0 || this.cursor !== null; }
  /** The next call has to transfer the complete thread again (read fallback only). */
  get nextNeedsFullRead() { return this.mode === 'read' && !this.buffer.length && this.cursor !== null; }
  async call(method, params) { this.requests.push(method); return this.rpc(method, params); }
  async next({ max = HISTORY_PAGE.items } = {}) {
    const turns = []; let activeTurnId = null; let fetches = 0; this.didRead = false;
    const take = rows => { for (const turn of rows) { turns.push(turn); if (turn?.status === 'inProgress') activeTurnId ??= turn.id; } };
    while (this.buffer.length < max && (!this.started || this.cursor !== null) && fetches < HISTORY_PAGE.fetchesPerPage) {
      take(await this.fetch()); fetches++; this.started = true;
      // items: one page per call; read: at most one full transfer per explicit request.
      if (this.mode === 'read' || this.mode === 'items') break;
    }
    const items = this.buffer.splice(Math.max(0, this.buffer.length - max));
    return { mode: this.mode, items, turns, activeTurnId, hasMore: this.hasMore, fullRead: this.didRead, read: this.read && { ...this.read } };
  }
  async fetch() {
    const { unsupported } = this.capabilities;
    if (!this.mode || this.mode === 'items') {
      if (!unsupported.has('items')) {
        try {
          const params = { threadId: this.threadId, limit: HISTORY_PAGE.items, sortDirection: 'desc' }; if (this.cursor) params.cursor = this.cursor;
          const result = await this.call('thread/items/list', params);
          this.mode = 'items'; this.cursor = result?.nextCursor || null;
          const rows = (Array.isArray(result?.data) ? result.data : []).map(historyEntry).filter(Boolean).reverse();
          this.buffer = [...rows, ...this.buffer];
          return [];
        } catch (error) { if (this.mode === 'items' || !isUnsupportedMethod(error)) throw error; unsupported.add('items'); }
      }
    }
    if (!this.mode || this.mode === 'turns') {
      if (!unsupported.has('turns')) {
        try {
          const params = { threadId: this.threadId, limit: HISTORY_PAGE.turns, sortDirection: 'desc', itemsView: 'full' }; if (this.cursor) params.cursor = this.cursor;
          const result = await this.call('thread/turns/list', params);
          const rows = Array.isArray(result?.data) ? result.data : [];
          // A CLI that ignores itemsView returns turns without items: it cannot page items this way.
          const missing = rows.some(turn => !Array.isArray(turn?.items));
          if (missing) { if (this.mode === 'turns') throw new Error('Codex 返回的回合缺少条目，无法继续分页读取历史'); unsupported.add('turns'); }
          else {
            this.mode = 'turns'; this.cursor = result?.nextCursor || null;
            const chronological = [...rows].reverse();
            this.buffer = [...chronological.flatMap(turnItems), ...this.buffer];
            return chronological;
          }
        } catch (error) { if (this.mode === 'turns' || !isUnsupportedMethod(error)) throw error; unsupported.add('turns'); }
      }
    }
    // Neither paging method exists: one full read; only the newest turns are kept, the rest is counted.
    const result = await this.call('thread/read', { threadId: this.threadId, includeTurns: true });
    this.mode = 'read'; this.didRead = true;
    const all = Array.isArray(result?.thread?.turns) ? result.thread.turns : [];
    const shown = this.read ? Math.min(this.read.shownTurns, all.length) : 0;
    const end = all.length - shown; const start = Math.max(0, end - HISTORY_PAGE.readKeepTurns);
    const rows = all.slice(start, end);
    this.read = { totalTurns: all.length, shownTurns: shown + rows.length };
    this.cursor = start > 0 ? { readTurns: this.read.shownTurns } : null;
    this.buffer = [...rows.flatMap(turnItems), ...this.buffer];
    // Metadata for every turn is small; it keeps statuses/durations right without holding older items.
    return all.map(({ items, ...meta }) => meta);
  }
}
/** `thread/items/list` entry → display item. */
export function historyEntry(entry) {
  const item = entry?.item || entry; if (!item?.id) return null;
  const extra = { _complete: true };
  if (typeof entry.turnId === 'string') extra._turnId = entry.turnId;
  if (Number.isFinite(entry.startedAtMs)) extra._startedAtMs = entry.startedAtMs;
  if (Number.isFinite(entry.completedAtMs)) extra._completedAtMs = entry.completedAtMs;
  return { ...item, ...extra };
}
function turnItems(turn) {
  return (Array.isArray(turn?.items) ? turn.items : []).filter(item => item?.id).map(item => ({ ...item, _turnId: turn.id, _complete: true }));
}

/** Flattens `skills/list` entries for one cwd, deduplicated by name. */
export function skillsFromResponse(result) {
  const seen = new Set(); const rows = [];
  for (const entry of Array.isArray(result?.data) ? result.data : []) for (const skill of Array.isArray(entry?.skills) ? entry.skills : []) {
    if (typeof skill?.name !== 'string' || seen.has(skill.name)) continue; seen.add(skill.name); rows.push(skill);
  }
  return rows;
}
