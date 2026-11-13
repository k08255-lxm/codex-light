import path from 'node:path';
import {dshResultError} from '../public/dsh.js';
import {diffLines} from '../public/vendor/jsdiff/libesm/diff/line.js';
import {projectDelegatedEdit} from '../public/delegated-changes.js';

const EDIT_TOOLS = /^(?:write|edit|multi_edit|multiedit|apply_patch|delete_file|write_file|edit_file)$/i;
const WRITE_TOOLS = /^(?:write|write_file)$/i;
const CREATE_OPS = new Set(['create','add']);
const TERMINAL = new Set(['completed','idle','interrupted','error','failed','closed','context_exhausted']);
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const UNC_PATH = /^\\\\[^\\]/;
const POSIX_ABSOLUTE = /^\//;

function payload(result) {
  const queue = [result], seen = new Set();
  while (queue.length && seen.size < 30) {
    let row = queue.shift();
    if (typeof row === 'string' && row.length <= 1024 * 1024) { try { row = JSON.parse(row); } catch { continue; } }
    if (!row || typeof row !== 'object' || seen.has(row)) continue;
    seen.add(row);
    if (Array.isArray(row.events)) return row;
    queue.push(row.structuredContent, row.result, row.data);
    for (const part of (row.content || []).slice(0, 20)) if (part?.type === 'text') queue.push(part.text);
  }
  throw new Error('DSH 编辑记录格式无法识别');
}

function object(value) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// Resolve with the path flavor named by the value (or by the binding cwd for a relative
// path). Windows comparisons are case-insensitive; POSIX comparisons stay case-sensitive.
function normalizeTarget(value, cwd) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00\r\n]/.test(value)) return null;
  if (WINDOWS_ABSOLUTE.test(value) || UNC_PATH.test(value)) {
    return path.win32.resolve(value).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  }
  if (POSIX_ABSOLUTE.test(value)) return path.posix.resolve(value).replace(/\/+$/, '');
  if (typeof cwd !== 'string' || !cwd) return null;
  if (WINDOWS_ABSOLUTE.test(cwd) || UNC_PATH.test(cwd)) {
    return path.win32.resolve(cwd, value).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  }
  if (POSIX_ABSOLUTE.test(cwd)) return path.posix.resolve(cwd, value).replace(/\/+$/, '');
  return null;
}

function sameTarget(left, right, cwd) {
  const a = normalizeTarget(left, cwd), b = normalizeTarget(right, cwd);
  return a !== null && a === b;
}

function truncated(...rows) {
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (row.truncated === true || row.summary?.truncated === true || row.data?.truncated === true ||
        row.data?.argumentsTruncated === true || row.data?.meta?.truncated === true) return true;
  }
  return false;
}

// A create reported without hunks still proves the old file did not exist, but only the
// paired successful write call can prove what the new file contains. Read that call once.
async function readCreatedContent({call, agentId, callEventId, callId, toolName, metaPath, cwd}) {
  if (!Number.isSafeInteger(callEventId)) return null;
  const response = await call('dsh_events', {agent_id:agentId, event_id:callEventId, include_tool_events:true, include_descendants:true, max_chars:65536});
  const error = dshResultError(response); if (error) throw new Error(error);
  const batch = payload(response);
  if (batch.truncated === true) return null;
  const event = (Array.isArray(batch.events) ? batch.events : []).find(row => row?.event_id === callEventId);
  if (!event || event.type !== 'tool/call' || truncated(event, batch)) return null;
  const data = object(event.data), summary = object(event.summary);
  const name = typeof data.name === 'string' ? data.name : typeof summary.name === 'string' ? summary.name : '';
  const id = typeof data.callId === 'string' ? data.callId : typeof summary.callId === 'string' ? summary.callId : '';
  if (!id || id !== callId || !name || name.toLowerCase() !== toolName.toLowerCase() || !WRITE_TOOLS.test(name)) return null;
  let args = data.arguments;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { return null; } }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const filePath = args.file_path, content = args.content;
  if (typeof filePath !== 'string' || typeof content !== 'string') return null;
  if (!sameTarget(filePath, metaPath, cwd)) return null;
  return content;
}

// Count physical lines from complete content: CRLF and CR normalize to LF, one trailing
// newline terminates the last line, and an empty file has zero lines. NUL means binary.
function addedLines(content) {
  if (typeof content !== 'string' || content.includes('\0')) return null;
  const text = content.replace(/\r\n?/g, '\n');
  if (text === '') return 0;
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n').length;
}

function editChanges(event) {
  const data = object(event.data), message = object(data.message), meta = object(data.meta);
  if (message.isError !== false) return null;
  const changes = [], paths = new Set();
  const operation = typeof meta.operation === 'string' ? meta.operation.toLowerCase() : '';
  const kind = {create:'add',add:'add',delete:'delete',remove:'delete'}[operation] || 'update';
  for (const row of (Array.isArray(meta.diffs)?meta.diffs:[])) {
    if (typeof row?.path !== 'string' || !row.path || row.path.length > 4096) continue;
    paths.add(row.path);
    const change = {path:row.path,kind:{type:kind}};
    if(typeof row.diff==='string'){change.diff=row.diff;change.diffFormat='unified';}
    else if((row.oldText===null||typeof row.oldText==='string')&&typeof row.newText==='string'){
      // DSH computeHunkDiffs records applied hunks with shared context. Diff the fragments
      // without inventing whole-file locations or counting unchanged context as edits.
      const parts=diffLines(row.oldText??'',row.newText,{timeout:50,maxEditLength:20000,ignoreNewlineAtEof:true});
      if(parts){let added=0,removed=0;const preview=[];for(const part of parts){if(part.added)added+=part.count;else if(part.removed)removed+=part.count;preview.push(...part.value.replace(/\n$/,'').split('\n').map(line=>(part.added?'+':part.removed?'-':' ')+line));}change.lineStats={added,removed};change.diffFormat='fragment';change.diff='已应用的编辑片段（无完整文件行号）\n'+preview.join('\n');}
      else change.statsReason='limited';
    }
    changes.push(change);
  }
  // Empty metadata can mean an identical overwrite or a create without applied hunks.
  // The path is evidence; absence of hunks is not evidence of zero changed lines.
  if(typeof meta.path==='string'&&!paths.has(meta.path))changes.push({path:meta.path,kind:{type:kind}});
  return {data,message,meta,operation,changes};
}

function applyCreatedContent(collected, content) {
  if (typeof collected.meta.path !== 'string' || !collected.meta.path) return false;
  const added = addedLines(content);
  if (added === null) return false;
  let target = collected.changes.find(change => change.path === collected.meta.path);
  if (!target) { target = {path:collected.meta.path}; collected.changes.push(target); }
  target.kind = {type:'add'};
  target.diff = content;
  target.lineStats = {added, removed:0};
  delete target.statsReason;
  delete target.diffFormat;
  delete target.diffTruncated;
  return true;
}

/** Incremental edit evidence. Read-only tool records never inspect the workspace diff. */
export class DshChangeReader {
  constructor() { this.agents = new Map(); }
  clear() { this.agents.clear(); }
  async read(key, agentId, call, {status, updatedAt, cwd} = {}) {
    let state = this.agents.get(key);
    if (!state) {
      state = {cursor:0, edits:new Map(), events:new Map(), processed:new Set(), finished:false, updatedAt:null};
      this.agents.set(key, state);
      while (this.agents.size > 100) this.agents.delete(this.agents.keys().next().value);
    }
    const response = hasMore => ({structuredContent:{events:[...state.events.values()],next_cursor:state.cursor,has_more:hasMore}});
    if (state.finished && TERMINAL.has(status) && state.updatedAt === updatedAt) return response(false);
    let hasMore = true, detailReads = 0;
    for (let page = 0; page < 2 && hasMore; page++) {
      const result = await call('dsh_events',{agent_id:agentId,after:state.cursor,include_tool_events:true,include_descendants:true,limit:100,max_chars:24000});
      const error = dshResultError(result); if (error) throw new Error(error);
      const batch = payload(result), before = state.cursor;
      for (const event of batch.events) {
        if (!Number.isSafeInteger(event.event_id) || event.event_id < 0) continue;
        const summary = object(event.summary);
        if (event.type === 'tool/call' && EDIT_TOOLS.test(summary.name || '')) {
          if (typeof summary.callId === 'string') {
            if(state.edits.size>=200)throw new Error('子代理编辑调用尚未配对，文件汇总暂不完整');
            state.edits.set(summary.callId, {eventId:event.event_id, name:summary.name});
          }
        }
        if (event.type === 'tool/result' && state.edits.size) {
          if (state.processed.has(event.event_id)) { state.cursor = event.event_id; continue; }
          if (detailReads >= 20) return response(true);
          const full = await call('dsh_events',{agent_id:agentId,event_id:event.event_id,include_tool_events:true,include_descendants:true,max_chars:65536});
          detailReads++;
          const fullError = dshResultError(full); if (fullError) throw new Error(fullError);
          const complete = payload(full).events.find(row => row.event_id === event.event_id);
          if (!complete?.data) throw new Error('DSH 编辑结果尚未完整返回');
          const data = object(complete.data), message = object(data.message);
          const callId = message.toolCallId || message.source?.callId;
          const pairing = state.edits.get(callId);
          if (pairing) {
            const collected = editChanges(complete);
            let changes = collected ? projectDelegatedEdit({success:true,changes:collected.changes})?.changes||[] : [];
            const countable = changes.some(row => Number.isSafeInteger(row.lineStats?.added) && Number.isSafeInteger(row.lineStats?.removed));
            // A successful create with no countable hunk can be counted from the complete
            // write call that produced it. Updates never use this path: they need the old file.
            if (collected && !countable && CREATE_OPS.has(collected.operation) && WRITE_TOOLS.test(pairing.name) && typeof collected.meta.path === 'string') {
              if (detailReads >= 20) return response(true);
              const content = await readCreatedContent({call,agentId,callEventId:pairing.eventId,callId,toolName:pairing.name,metaPath:collected.meta.path,cwd});
              detailReads++;
              if (content !== null && applyCreatedContent(collected, content)) changes = projectDelegatedEdit({success:true,changes:collected.changes})?.changes||[];
            }
            if (changes.length && Number.isSafeInteger(data.turn) && data.turn > 0){
              const editKey=`${data.turn}:${event.event_id}`;
              if(!state.events.has(editKey)&&state.events.size>=1000)throw new Error('子代理编辑记录超过读取上限，当前汇总尚不完整');
              state.events.set(editKey,{
                type:'tool/result', event_id:`change:${data.turn}:${event.event_id}`, seq:event.seq ?? event.event_id,
                taskTurn:data.turn, callId, success:true, changes,
              });
            }
            state.edits.delete(callId);
          }
          state.processed.add(event.event_id);
          while (state.processed.size > 2000) state.processed.delete(state.processed.values().next().value);
        }
        state.cursor = event.event_id;
      }
      if (batch.next_cursor !== undefined) state.cursor = batch.next_cursor;
      hasMore = batch.has_more === true;
      if (hasMore && String(before) === String(state.cursor)) throw new Error('DSH 编辑记录分页未向前推进');
    }
    state.finished = !hasMore;
    state.updatedAt = updatedAt;
    return response(hasMore);
  }
}
