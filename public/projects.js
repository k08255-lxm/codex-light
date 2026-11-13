const windowsPath = value => /^[a-z]:[\\/]/i.test(value) || /^(?:\\\\|\/\/)[^\\/]/.test(value);

export function projectPathKey(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) return '';
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

export function projectThreadGroups(projects, threads, {selectedPath = '', searching = false} = {}) {
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
  return [...groups.values()].filter(group => !searching || group.threads.length).sort((a,b) => Number(b.pinned === true) - Number(a.pinned === true));
}
