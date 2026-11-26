const windowsPath = value => /^[a-z]:[\\/]/i.test(value) || /^(?:\\\\|\/\/)[^\\/]/.test(value);
const ordinaryWindowsPath = value => value.replace(/^(?:\\\\|\/\/)\?[\\/]UNC[\\/]/i, '//').replace(/^(?:\\\\|\/\/)\?[\\/](?=[a-z]:[\\/])/i, '');

export function projectPathKey(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) return '';
  value = ordinaryWindowsPath(value);
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
  value = ordinaryWindowsPath(value);
  const normalized = windowsPath(value) ? value.replace(/\\/g, '/') : value;
  const trimmed = normalized.replace(/\/+$/, '');
  if (!trimmed || /^[a-z]:$/i.test(trimmed)) return value;
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

// Seconds or milliseconds since the epoch → milliseconds; anything else is "unknown" (0).
export function activityTime(value) { const n = Number(value); return Number.isFinite(n) && n > 0 ? (n < 1e12 ? n * 1000 : n) : 0; }
export const threadProjectPath = thread => thread?.projectless ? '' : thread?.cwd || '';
const threadActivity = thread => activityTime(thread.submittedAt) || activityTime(thread.createdAt);

/**
 * Confirmed submissions and explicit project additions determine activity.
 * Creation time keeps older history stable when there is no recorded submission.
 */
export function navigationKey(group) {
  return group.saved ? '@saved:' + group.projectId : group.projectless ? '@projectless' : group.path || '@other';
}

export function projectThreadGroups(projects, threads, {selectedPath = '', searching = false, runningThreadIds = new Set(), recent = {}, restoredOrder = null} = {}) {
  const groups = new Map();
  const selectedKey = projectPathKey(selectedPath);
  for (const project of projects) {
    const key = projectPathKey(project.path);
    if (!key || groups.has(key)) continue;
    groups.set(key, {key, path: project.path, name: project.name || projectName(project.path), pinned: project.pinned === true, addedAt: project.addedAt, projectId: project.id, saved: true, selected: key === selectedKey, threads: []});
  }
  for (const thread of threads) {
    const projectPath = threadProjectPath(thread), projectless = thread.projectless === true;
    const key = projectless ? '@projectless' : projectPathKey(projectPath);
    if (!groups.has(key)) groups.set(key, {key, path: key ? projectPath : '', name: projectless ? '无项目' : key ? projectName(projectPath) : '其他对话', projectless, projectId: null, saved: false, selected: projectless ? !selectedKey : !!key && key === selectedKey, threads: []});
    groups.get(key).threads.push(thread);
  }
  // On startup only, show the previous group headers while the live first page loads.
  const positions = new Map();
  for (const [index, entry] of (restoredOrder || []).entries()) {
    positions.set(entry, index);
    if (entry.startsWith('@saved:')) continue;
    const projectless = entry === '@projectless';
    const path = entry === '@other' || projectless ? '' : entry;
    const key = projectless ? entry : projectPathKey(path);
    if (!groups.has(key)) groups.set(key, {key, path, name: projectless ? '无项目' : path ? projectName(path) : '其他对话', projectless, saved:false, selected:projectless ? !selectedKey : !!key && key === selectedKey, threads:[]});
  }
  const running = id => runningThreadIds?.has?.(id) === true;
  const rows = [...groups.values()].filter(group => !searching || group.threads.length).map((group, index) => {
    group.threads.sort((a, b) => threadActivity(b) - threadActivity(a));
    const latest = Math.max(activityTime(recent?.[group.key]), activityTime(group.addedAt), ...group.threads.map(threadActivity));
    return {group: {...group, running: group.threads.some(thread => running(thread.id)), lastActivity: latest}, index};
  });
  return rows.sort((a, b) => Number(b.group.pinned === true) - Number(a.group.pinned === true) || (restoredOrder ? (positions.get(navigationKey(a.group)) ?? Infinity) - (positions.get(navigationKey(b.group)) ?? Infinity) : 0) || b.group.lastActivity - a.group.lastActivity || a.index - b.index).map(row => row.group);
}
