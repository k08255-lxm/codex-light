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

export function mountProjectNavigation(host, { onSelect, onOpenThread, onRemove, onAction }) {
  const document = host.ownerDocument;
  const navigationId = ++nextNavigationId;
  let nextGroupId = 0;
  let previousSelectedKey;
  let busy = false;
  const views = new Map();
  const openGroups = new Map();
  const expandedGroups = new Set();
  let menuOwner = null;
  const menu = element(document, 'div', 'project-actions-menu');
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  document.body.append(menu);
  function closeMenu(restore = false) {
    const owner = menuOwner; menu.hidden = true; menuOwner = null;
    owner?.more.setAttribute('aria-expanded', 'false');
    if (restore) owner?.more.focus();
  }
  function openMenu(view) {
    if (menuOwner === view) { closeMenu(true); return; }
    closeMenu(); menuOwner = view; menu.replaceChildren();
    for (const [action, label, glyph] of [['pin',view.group.pinned?'取消置顶':'置顶','up'],['rename','编辑名称','compose'],['open','在资源管理器中打开','folder'],['archive',`归档已加载聊天（${view.group.threads.length}）`,'archive'],['remove','移除项目','close']]) {
      const item = element(document, 'button', 'project-menu-item'); item.type = 'button'; item.setAttribute('role','menuitem');
      item.append(icon(document,glyph,{size:18}), document.createTextNode(label));
      item.disabled = busy || (action === 'remove' && !view.group.saved) || (['pin','rename','open'].includes(action) && !view.group.path) || (action === 'archive' && !view.group.threads.length);
      item.addEventListener('click', () => { const group=view.group; closeMenu(true); if(action==='remove')onRemove(group);else onAction?.(group, action); });
      menu.append(item);
    }
    view.more.setAttribute('aria-expanded','true'); menu.hidden=false;
    const rect=view.more.getBoundingClientRect();
    menu.style.left=`${Math.max(8,Math.min(rect.left,document.documentElement.clientWidth-menu.offsetWidth-8))}px`;
    menu.style.top=`${Math.max(8,Math.min(rect.bottom+4,document.documentElement.clientHeight-menu.offsetHeight-8))}px`;
    menu.querySelector('button:not(:disabled)')?.focus();
  }
  document.addEventListener('pointerdown', event => { if(menuOwner&&!menu.contains(event.target)&&!menuOwner.more.contains(event.target))closeMenu(); });
  document.defaultView.addEventListener('resize',()=>closeMenu());
  host.addEventListener('scroll',()=>closeMenu());
  menu.addEventListener('keydown', event => {
    if(event.key==='Escape'){event.preventDefault();closeMenu(true);}
    if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
      event.preventDefault();const items=[...menu.querySelectorAll('button:not(:disabled)')];const index=items.indexOf(document.activeElement);
      items[event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();
    }
    if(event.key==='Tab')closeMenu();
  });
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
    toggle.append(icon(document, 'folder', { size: 18 }));
    const select = element(document, 'button', 'project-group-select');
    select.type = 'button';
    const unknown = element(document, 'span', 'project-group-unknown');
    const threads = element(document, 'div', 'project-group-threads');
    threads.id = `project-navigation-${navigationId}-group-${++nextGroupId}`;
    toggle.setAttribute('aria-controls', threads.id);
    const more = element(document,'button','project-group-action'); more.type='button';more.title='项目操作';more.setAttribute('aria-label','项目操作');more.setAttribute('aria-haspopup','menu');more.setAttribute('aria-expanded','false');more.append(icon(document,'more',{size:17}));
    const compose = element(document,'button','project-group-action');compose.type='button';compose.title='新建聊天';compose.setAttribute('aria-label','新建聊天');compose.append(icon(document,'compose',{size:17}));
    header.append(toggle, select, unknown, more, compose);
    node.append(header, threads);
    const view = { node, toggle, select, unknown, more, compose, threads, group, threadViews: new Map() };
    more.addEventListener('click',()=>openMenu(view));
    compose.addEventListener('click',()=>{if(!busy&&view.group.path)onAction?.(view.group,'new');});
    toggle.addEventListener('click', () => setOpen(view, !view.open));
    select.addEventListener('click', () => {
      if (!busy && view.group.path) onSelect(view.group);
    });
    return view;
  }

  function updateThreads(view, activeThreadId) {
    const nodes = [];
    const ids = new Set();
    const all = view.group.threads;
    const visible = expandedGroups.has(view.group.key) || view.searching ? all : all.slice(0, 5);
    for (const thread of visible) {
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
    if(all.length>5&&!view.searching){
      if(!view.showMore){view.showMore=element(document,'button','project-group-show-more');view.showMore.type='button';view.showMore.addEventListener('click',()=>{if(expandedGroups.has(view.group.key))expandedGroups.delete(view.group.key);else expandedGroups.add(view.group.key);updateThreads(view,view.activeThreadId);});}
      setText(view.showMore,expandedGroups.has(view.group.key)?'收起显示':`展开显示（${all.length-5}）`);view.showMore.setAttribute('aria-expanded',String(expandedGroups.has(view.group.key)));nodes.push(view.showMore);
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
      view.searching = searching; view.activeThreadId = activeThreadId;
      view.compose.hidden = !group.path; view.compose.disabled = busy;
      view.more.disabled = busy;
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
      if (!openGroups.has(group.key)) openGroups.set(group.key, true);
      if (selectionChanged && group.selected) openGroups.set(group.key, true);
      setOpen(view, searching || openGroups.get(group.key), false);
      updateThreads(view, activeThreadId);
      nodes.push(view.node);
    }
    reconcile(list, nodes);
    if(menuOwner&&!keys.has(menuOwner.group.key))closeMenu();
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
