// Counts describe recorded edits unless an authoritative turn net diff replaces them.
const count = value => Number.isSafeInteger(value) && value >= 0;
const unknown = reason => ({ added: null, removed: null, reason });

export function changeEvidence(change) {
  const source = typeof change?.diff === 'string' ? change.diff : null;
  if (change?.statsReason === 'binary' || change?.binary === true || source !== null && /^(?:Binary files .* differ|GIT binary patch)/m.test(source)) return unknown('binary');
  const stats = change?.lineStats;
  if (count(stats?.added) && count(stats?.removed)) return { added: stats.added, removed: stats.removed, reason: null };
  if (change?.statsReason) return unknown(['missing','truncated','malformed','binary','limited'].includes(change.statsReason) ? change.statsReason : 'missing');
  if (change?.diffTruncated === true) return unknown('truncated');
  if (source === null) return unknown('missing');
  const kind = change?.kind?.type || change?.kind;
  const diff = source.replace(/\r\n?/g, '\n');
  if (change?.diffFormat !== 'unified' && (kind === 'add' || kind === 'delete')) {
    const lines = diff ? diff.replace(/\n$/, '').split('\n').length : 0;
    return { added: kind === 'add' ? lines : 0, removed: kind === 'delete' ? lines : 0, reason: null };
  }
  if (!diff) return unknown('missing');
  let added = 0, removed = 0, oldLeft = 0, newLeft = 0, hunks = 0;
  for (const line of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      if (oldLeft || newLeft) return unknown('truncated');
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]); newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]); hunks++; continue;
    }
    if (line.startsWith('\\')) continue;
    if (oldLeft || newLeft) {
      if (line.startsWith('+') && newLeft > 0) { added++; newLeft--; }
      else if (line.startsWith('-') && oldLeft > 0) { removed++; oldLeft--; }
      else if (line.startsWith(' ') && oldLeft > 0 && newLeft > 0) { oldLeft--; newLeft--; }
      else return unknown('truncated');
    } else if (/^[+-]/.test(line) && !/^(?:---|\+\+\+) /.test(line)) return unknown('malformed');
  }
  if (oldLeft || newLeft) return unknown('truncated');
  if (!hunks && !/^(?:old mode |new mode |new file mode |deleted file mode |rename from |rename to |similarity index )/m.test(diff)) return unknown('malformed');
  return { added, removed, reason: null };
}

export function changeStats(change) {
  const { added, removed } = changeEvidence(change); return { added, removed };
}

export function summarizeFileRows(rows, running = false) {
  const knownRows = rows.filter(row => row.known);
  const contributions = rows.filter(row => row.known || row.knownEdits > 0);
  const unknownCount = rows.length - knownRows.length;
  return {
    count: rows.length, running, rows, complete: rows.length > 0 && unknownCount === 0,
    added: contributions.length ? contributions.reduce((sum, row) => sum + (row.known ? row.added : row.knownAdded), 0) : null,
    removed: contributions.length ? contributions.reduce((sum, row) => sum + (row.known ? row.removed : row.knownRemoved), 0) : null,
    unknownCount, binaryCount: rows.filter(row => row.statsReasons?.includes('binary')).length,
    statsBasis: rows.some(row => row.statsBasis === 'edits') ? 'edits' : 'net',
  };
}
