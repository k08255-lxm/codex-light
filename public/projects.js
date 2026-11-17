const windowsPath = value => /^[a-z]:[\\/]/i.test(value) || /^(?:\\\\|\/\/)[^\\/]/.test(value);

export function projectPathKey(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) return '';
  const wsl = value.replace(/\\/g, '/').match(/^\/\/(wsl\.localhost|wsl\$)\/([^/]+)(\/.*)?$/i);
  if (wsl) return '//wsl.localhost/' + wsl[2].toLowerCase() + (wsl[3] || '').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  if (windowsPath(value)) {
    let key = value.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    if (/^(?:\\\\|\/\/)/.test(value)) key = '/' + key;
    key = key.replace(/\/+$/, '');
    if (/^[a-z]:$/i.test(key)) key += '/';
    return key.toLowerCase();
  }
  if (!value.startsWith('/')) return '';
  return value.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
}

export function projectName(value) {
  if (typeof value !== 'string' || !value) return '';
  const normalized = windowsPath(value) ? value.replace(/\\/g, '/') : value;
  const trimmed = normalized.replace(/\/+$/, '');
  if (!trimmed || /^[a-z]:$/i.test(trimmed)) return value;
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

// Seconds or milliseconds since the epoch → milliseconds; anything else is "unknown" (0).
export function activityTime(value) { const n = Number(value); return Number.isFinite(n) && n > 0 ? (n < 1e12 ? n * 1000 : n) : 0; }

/**
 * Groups are ordered: pinned, then most recently used, then their original order. A local use takes
 * precedence over background thread updates; historical timestamps fill gaps before a project is used.
 * Thread order comes from the caller. Running state is display information, not a sorting priority.
 */
export function projectThreadGroups(projects, threads, {selectedPath = '', searching = false, runningThreadIds = new Set(), recent = {}} = {}) {
  const groups = new Map();
  const selectedKey = projectPathKey(selectedPath);
  for (const project of projects) {
    const key = projectPathKey(project.path);
    if (!key || groups.has(key)) continue;
    groups.set(key, {key, path: project.path, name: project.name || projectName(project.path), pinned: project.pinned === true, projectId: project.id, saved: true, selected: key === selectedKey, threads: []});
  }
  for (const thread of threads) {
    const key = projectPathKey(thread.cwd);
    if (!groups.has(key)) groups.set(key, {key, path: key ? thread.cwd : '', name: key ? projectName(thread.cwd) : '其他对话', projectId: null, saved: false, selected: Boolean(key) && key === selectedKey, threads: []});
    groups.get(key).threads.push(thread);
  }
  const running = id => runningThreadIds?.has?.(id) === true;
  const rows = [...groups.values()].filter(group => !searching || group.threads.length).map((group, index) => {
    const latest = activityTime(recent?.[group.key]) || Math.max(0, ...group.threads.map(thread => Math.max(activityTime(thread.updatedAt), activityTime(thread.createdAt))));
    return {group: {...group, running: group.threads.some(thread => running(thread.id)), lastActivity: latest}, index};
  });
  return rows.sort((a, b) => Number(b.group.pinned === true) - Number(a.group.pinned === true) || b.group.lastActivity - a.group.lastActivity || a.index - b.index).map(row => row.group);
}
