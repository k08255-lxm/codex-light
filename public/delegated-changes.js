// Structured successful edit evidence only. Assistant prose and whole-workspace diffs are not evidence.
export function projectDelegatedEdit(event) {
  if (!event || typeof event !== 'object') return null;
  const changes = [];
  let diffBudget=262144;
  for (const change of Array.isArray(event.changes) ? event.changes.slice(0, 100) : []) {
    if (typeof change?.path !== 'string' || !change.path || change.path.length > 8192 || /[\0\r\n]/.test(change.path) || /^[a-z][a-z0-9+.-]*:\/\//i.test(change.path)) continue;
    if (['failed','declined','rejected','cancelled','canceled','inProgress','running'].includes(change.status)) continue;
    const kind = typeof change.kind === 'string' ? change.kind : change.kind?.type;
    const row = { path: change.path };
    if (['add', 'update', 'delete'].includes(kind)) row.kind = { type: kind };
    if (typeof change.diff === 'string' && change.diff.length <= 65536 && change.diff.length<=diffBudget) {row.diff = change.diff;diffBudget-=change.diff.length;}
    changes.push(row);
  }
  const taskTurn = Number.isSafeInteger(event.taskTurn) && event.taskTurn > 0 ? event.taskTurn : null;
  const seq = Number.isSafeInteger(Number(event.seq)) && event.seq !== '' && event.seq !== null && event.seq !== undefined ? Number(event.seq) : null;
  const callId = typeof event.callId === 'string' ? event.callId.slice(0, 512) : null;
  return { success: event.success === true&&!['failed','declined','rejected','cancelled','canceled'].includes(event.status), changes, taskTurn, seq, callId };
}

function absolutePath(value, cwd) {
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
  const keys = new Set(primary.rows.map(row => absolutePath(row.fullPath || row.path, cwd)));
  const rows = [...primary.rows];
  for (const row of delegated.rows) {
    const key = absolutePath(row.fullPath || row.path, cwd);
    if (keys.has(key)) continue; // Native turn net diff is authoritative, including a zero net change.
    keys.add(key); rows.push({ ...row, delegated: true });
  }
  const known = rows.length > 0 && rows.every(row => row.known);
  return { ...primary, rows, count: rows.length, complete: known,
    added: known ? rows.reduce((sum, row) => sum + row.added, 0) : null,
    removed: known ? rows.reduce((sum, row) => sum + row.removed, 0) : null };
}

export function delegatedItemsForTurn(records, turnId, cwd) {
  const files = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (record.turnId !== turnId || record.success !== true) continue;
    for (const change of record.changes || []) {
      const key = absolutePath(change.path, record.cwd || cwd);
      const previous = files.get(key);
      // Multiple patches are not a proven net diff. Retain paths but leave line counts unknown.
      const base=String(record.cwd||cwd||'').replace(/[\\/]$/,'');
      const fullPath=/^(?:[A-Za-z]:[\\/]|[\\/])/.test(change.path)?change.path:base?`${base}/${change.path}`:change.path;
      files.set(key, { path: fullPath, kind: change.kind, ...(previous ? {} : typeof change.diff === 'string' ? { diff: change.diff } : {}) });
    }
  }
  return files.size ? [{ id: `delegated:${turnId}`, type: 'fileChange', status: 'completed', changes: [...files.values()] }] : [];
}
