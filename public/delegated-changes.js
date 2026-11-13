// Structured successful edit evidence only. Assistant prose and whole-workspace diffs are not evidence.
import {changeEvidence,summarizeFileRows} from './change-stats.js';
export function projectDelegatedEdit(event) {
  if (!event || typeof event !== 'object') return null;
  const changes = [];
  let diffBudget=262144;
  for (const change of Array.isArray(event.changes) ? event.changes : []) {
    if (typeof change?.path !== 'string' || !change.path || change.path.length > 8192 || /[\0\r\n]/.test(change.path) || /^[a-z][a-z0-9+.-]*:\/\//i.test(change.path)) continue;
    if (['failed','declined','rejected','cancelled','canceled','inProgress','running'].includes(change.status)) continue;
    const kind = typeof change.kind === 'string' ? change.kind : change.kind?.type;
    const row = { path: change.path };
    if (['add', 'update', 'delete'].includes(kind)) row.kind = { type: kind };
    const stats=changeEvidence(change);
    if(stats.added!==null)row.lineStats={added:stats.added,removed:stats.removed};else row.statsReason=stats.reason;
    if(['unified','fragment'].includes(change.diffFormat))row.diffFormat=change.diffFormat;
    if(change.diffTruncated===true)row.diffTruncated=true;
    if (typeof change.diff === 'string') {const kept=change.diff.slice(0,Math.min(65536,diffBudget));if(kept)row.diff=kept;diffBudget-=kept.length;if(kept.length<change.diff.length||change.diffTruncated)row.diffTruncated=true;}
    changes.push(row);
  }
  const taskTurn = Number.isSafeInteger(event.taskTurn) && event.taskTurn > 0 ? event.taskTurn : null;
  const seq = Number.isSafeInteger(Number(event.seq)) && event.seq !== '' && event.seq !== null && event.seq !== undefined ? Number(event.seq) : null;
  const callId = typeof event.callId === 'string' ? event.callId.slice(0, 512) : null;
  return { success: event.success === true&&!['failed','declined','rejected','cancelled','canceled'].includes(event.status), changes, taskTurn, seq, callId };
}

export function absolutePath(value, cwd) {
  const path = String(value || '').replace(/\\/g, '/');
  const base = String(cwd || '').replace(/\\/g, '/').replace(/\/$/, '');
  const absolute = /^(?:[A-Za-z]:\/|\/)/.test(path) ? path : base ? `${base}/${path}` : path;
  const prefix = absolute.startsWith('//') ? '//' : absolute.startsWith('/') ? '/' : '';
  const parts = [];
  for (const part of absolute.replace(/^\/+/, '').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
    else parts.push(part);
  }
  const normal = prefix + parts.join('/');
  return /^[A-Za-z]:\//.test(normal) || normal.startsWith('//') ? normal.toLowerCase() : normal;
}

export function mergeDelegatedFileSummary(primary, delegated, { cwd = '' } = {}) {
  if (!delegated?.rows?.length) return primary;
  const rows = [...primary.rows];
  const keys = new Map(rows.map((row,index) => [absolutePath(row.fullPath || row.path, cwd),index]));
  for (const row of delegated.rows) {
    const key = absolutePath(row.fullPath || row.path, cwd);
    if (keys.has(key)) {
      const index=keys.get(key),previous=rows[index];
      if(previous.statsBasis==='net')continue; // Native turn net diff is authoritative, including a zero net change.
      const known=previous.known&&row.known;
      const knownAdded=(previous.known?previous.added:previous.knownAdded||0)+(row.known?row.added:row.knownAdded||0);
      const knownRemoved=(previous.known?previous.removed:previous.knownRemoved||0)+(row.known?row.removed:row.knownRemoved||0);
      rows[index]={...previous,known,added:known?knownAdded:null,removed:known?knownRemoved:null,knownAdded,knownRemoved,knownEdits:(previous.knownEdits||Number(previous.known))+(row.knownEdits||Number(row.known)),statsReasons:[...new Set([...(previous.statsReasons||[]),...(row.statsReasons||[])])],diffs:[...previous.diffs,...row.diffs],delegated:true};
      continue;
    }
    keys.set(key,rows.length); rows.push({ ...row, delegated: true });
  }
  return { ...primary,...summarizeFileRows(rows,primary.running) };
}

export function delegatedItemsForTurn(records, turnId, cwd) {
  const items = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (record.turnId !== turnId || record.success !== true) continue;
    const identity=record.id??(record.agentId&&record.eventId!==undefined?`${record.agentId}:${record.eventId}`:null);
    const changes=[];
    for (const change of record.changes || []) {
      const base=String(record.cwd||cwd||'').replace(/[\\/]$/,'');
      const fullPath=/^(?:[A-Za-z]:[\\/]|[\\/])/.test(change.path)?change.path:base?`${base}/${change.path}`:change.path;
      changes.push({...change,path:fullPath});
    }
    // Repeated snapshots replace the same operation; separate successful operations retain all patches.
    items.set(identity??Symbol(),{id:`delegated:${turnId}:${identity??items.size}`,type:'fileChange',status:'completed',changes});
  }
  return [...items.values()];
}
