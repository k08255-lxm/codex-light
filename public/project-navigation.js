import { projectPathKey, projectThreadGroups } from './projects.js';
import { icon } from './icons.js';

let nextNavigationId = 0;

function element(document, tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setText(node, value) {
  if (node.textContent !== value) node.textContent = value;
}

function reconcile(parent, nodes) {
  const retained = new Set(nodes);
  for (const node of [...parent.children]) if (!retained.has(node)) node.remove();
  nodes.forEach((node, index) => {
    if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] || null);
  });
}

export function mountProjectNavigation(host, { onSelect, onOpenThread, onRemove }) {
  const document = host.ownerDocument;
  const navigationId = ++nextNavigationId;
  let nextGroupId = 0;
  let previousSelectedKey;
  let busy = false;
  const views = new Map();
  const openGroups = new Map();
  host.classList.add('project-navigation');
  host.setAttribute('role', 'navigation');
  host.setAttribute('aria-label', '项目与对话');
  const errorNode = element(document, 'p', 'project-navigation-error');
  errorNode.setAttribute('role', 'status');
  errorNode.hidden = true;
  const list = element(document, 'div', 'project-navigation-list');
  const empty = element(document, 'p', 'project-navigation-empty');
  empty.hidden = true;
  host.replaceChildren(errorNode, list, empty);

  function setOpen(view, open, remember = true) {
    if (remember) openGroups.set(view.group.key, open);
    view.open = open;
    view.threads.hidden = !open;
    view.toggle.setAttribute('aria-expanded', String(open));
    view.toggle.setAttribute('aria-label', `${open ? '折叠' : '展开'} ${view.group.name}`);
    view.node.dataset.open = String(open);
  }

  function createGroup(group) {
    const node = element(document, 'section', 'project-group');
    const header = element(document, 'div', 'project-group-header');
    const toggle = element(document, 'button', 'project-group-toggle');
    toggle.type = 'button';
    toggle.append(icon(document, 'right', { size: 12 }));
    const folder = element(document, 'span', 'project-group-folder');
    folder.append(icon(document, 'folder', { size: 15 }));
    const select = element(document, 'button', 'project-group-select');
    select.type = 'button';
    const unknown = element(document, 'span', 'project-group-unknown');
    const remove = element(document, 'button', 'project-group-remove');
    remove.type = 'button';
    remove.title = '从项目列表移除（不删除文件）';
    remove.append(icon(document, 'close', { size: 13 }));
    const threads = element(document, 'div', 'project-group-threads');
    threads.id = `project-navigation-${navigationId}-group-${++nextGroupId}`;
    toggle.setAttribute('aria-controls', threads.id);
    header.append(toggle, folder, select, unknown, remove);
    node.append(header, threads);
    const view = { node, toggle, select, unknown, remove, threads, group, threadViews: new Map() };
    toggle.addEventListener('click', () => setOpen(view, !view.open));
    select.addEventListener('click', () => {
      if (!busy && view.group.path) onSelect(view.group);
    });
    remove.addEventListener('click', () => {
      if (!busy && view.group.saved) onRemove(view.group);
    });
    return view;
  }

  function updateThreads(view, activeThreadId) {
    const nodes = [];
    const ids = new Set();
    for (const thread of view.group.threads) {
      ids.add(thread.id);
      let row = view.threadViews.get(thread.id);
      if (!row) {
        const button = element(document, 'button', 'project-group-thread');
        button.type = 'button';
        const title = element(document, 'span', 'thread-name');
        button.append(title);
        row = { button, title, thread };
        button.addEventListener('click', () => onOpenThread(row.thread.id));
        view.threadViews.set(thread.id, row);
      }
      row.thread = thread;
      const title = thread.name || thread.preview || '未命名对话';
      setText(row.title, title);
      row.button.title = title;
      const active = thread.id === activeThreadId;
      row.button.classList.toggle('active', active);
      row.button.setAttribute('aria-current', active ? 'page' : 'false');
      nodes.push(row.button);
    }
    reconcile(view.threads, nodes);
    for (const id of view.threadViews.keys()) if (!ids.has(id)) view.threadViews.delete(id);
  }

  function render({ projects = [], threads = [], selectedPath = '', activeThreadId = '', searching = false, busy: isBusy = false, error = '' }) {
    const focused = document.activeElement;
    const keepFocus = focused && host.contains(focused);
    const scrollTop = host.scrollTop;
    busy = isBusy;
    const selectedKey = projectPathKey(selectedPath);
    const selectionChanged = selectedKey !== previousSelectedKey;
    previousSelectedKey = selectedKey;
    const groups = projectThreadGroups(projects, threads, { selectedPath, searching });
    const keys = new Set();
    const nodes = [];
    for (const group of groups) {
      keys.add(group.key);
      let view = views.get(group.key);
      if (!view) { view = createGroup(group); views.set(group.key, view); }
      view.group = group;
      view.node.dataset.projectKey = group.key;
      view.node.classList.toggle('selected', group.selected);
      view.node.setAttribute('aria-label', group.name);
      setText(view.select, group.name);
      setText(view.unknown, group.name);
      view.select.title = group.path;
      view.select.hidden = !group.path;
      view.unknown.hidden = !!group.path;
      view.select.disabled = busy || !group.path;
      view.select.setAttribute('aria-pressed', String(group.selected));
      view.remove.hidden = !group.saved;
      view.remove.disabled = busy;
      view.remove.setAttribute('aria-label', `从项目列表移除 ${group.name}（不删除文件）`);
      if (!openGroups.has(group.key)) openGroups.set(group.key, group.selected);
      if (selectionChanged && group.selected) openGroups.set(group.key, true);
      setOpen(view, searching || openGroups.get(group.key), false);
      updateThreads(view, activeThreadId);
      nodes.push(view.node);
    }
    reconcile(list, nodes);
    for (const key of views.keys()) if (!keys.has(key)) views.delete(key);
    setText(errorNode, error);
    errorNode.hidden = !error;
    setText(empty, searching ? '无搜索结果' : '添加项目，或打开已有对话。');
    empty.hidden = groups.length > 0;
    if (keepFocus && host.contains(focused) && document.activeElement !== focused) focused.focus({ preventScroll: true });
    if (host.scrollTop !== scrollTop) host.scrollTop = scrollTop;
  }

  return { render };
}
