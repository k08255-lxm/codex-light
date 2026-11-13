import {dshResultError} from '../public/dsh.js';

const EDIT_TOOLS = /^(?:write|edit|multi_edit|multiedit|apply_patch|delete_file|write_file|edit_file)$/i;
const TERMINAL = new Set(['completed','idle','interrupted','error','failed','closed','context_exhausted']);

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

function fileChanges(event) {
  const data = object(event.data), message = object(data.message), meta = object(data.meta);
  if (message.isError !== false) return [];
  const changes = [], paths = new Set();
  const kind = {create:'add',add:'add',delete:'delete',remove:'delete'}[meta.operation] || 'update';
  for (const row of [...(Array.isArray(meta.diffs) ? meta.diffs : []), meta].slice(0, 200)) {
    if (typeof row?.path !== 'string' || !row.path || row.path.length > 4096 || paths.has(row.path)) continue;
    paths.add(row.path);
    const change = {path:row.path,kind:{type:kind}};
    // oldText/newText are replacement fragments, not a net file diff or real line locations.
    changes.push(change);
  }
  return changes;
}

/** Incremental edit evidence. Read-only tool records never inspect the workspace diff. */
export class DshChangeReader {
  constructor() { this.agents = new Map(); }
  clear() { this.agents.clear(); }
  async read(key, agentId, call, {status, updatedAt} = {}) {
    let state = this.agents.get(key);
    if (!state) {
      state = {cursor:0, edits:new Map(), events:new Map(), finished:false, updatedAt:null};
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
            state.edits.set(summary.callId, summary.name);
          }
        }
        if (event.type === 'tool/result' && state.edits.size) {
          if (detailReads >= 20) return response(true);
          const full = await call('dsh_events',{agent_id:agentId,event_id:event.event_id,include_tool_events:true,include_descendants:true,max_chars:65536});
          detailReads++;
          const fullError = dshResultError(full); if (fullError) throw new Error(fullError);
          const complete = payload(full).events.find(row => row.event_id === event.event_id);
          if (!complete?.data) throw new Error('DSH 编辑结果尚未完整返回');
          const data = object(complete.data), message = object(data.message);
          const callId = message.toolCallId || message.source?.callId;
          if (state.edits.has(callId)) {
            const changes = fileChanges(complete);
            if (changes.length && Number.isSafeInteger(data.turn) && data.turn > 0) for(const change of changes){
              const fileKey=`${data.turn}:${change.path.replace(/\\/g,'/').toLowerCase()}`;
              const previous=state.events.get(fileKey);
              if(!previous&&state.events.size>=1000)throw new Error('子代理文件记录超过读取上限，当前汇总尚不完整');
              // Multiple edits to a file do not make the last patch its net diff.
              const projected=previous?{path:change.path,kind:change.kind}:change;
              state.events.set(fileKey,{
                type:'tool/result', event_id:previous?.event_id||`change:${data.turn}:${state.events.size+1}`, seq:event.seq ?? event.event_id,
                taskTurn:data.turn, callId, success:true, changes:[projected],
              });
            }
            state.edits.delete(callId);
          }
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
