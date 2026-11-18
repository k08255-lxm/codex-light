export function createNavigationHistory(initial, limit = 64) {
  let entries = [initial], index = 0;
  const same = (a, b) => a.name === b.name && a.section === b.section && a.threadId === b.threadId && (a.threadId || (a.cwd || '') === (b.cwd || ''));
  return {
    push(entry) { if (same(entries[index], entry)) return; entries = entries.slice(0, index + 1); entries.push(entry); if (entries.length > limit) entries.shift(); index = entries.length - 1; },
    replace(entry) { entries[index] = entry; },
    get current() { return entries[index]; },
    move(delta) { const next = index + delta; if (next < 0 || next >= entries.length) return null; index = next; return entries[index]; },
    get canBack() { return index > 0; }, get canForward() { return index < entries.length - 1; },
  };
}
