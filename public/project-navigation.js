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

export function mountProjectNavigation(host, { onSelect, onOpenThread, onRemove, onAction, onThreadAction, canManageThread = () => true }) {
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
    if (restore) (owner?.opener || owner?.more)?.focus({ preventScroll: true });
  }
  function openMenu(view, opener, point) {
    if (busy) return;
    if (menuOwner === view && !opener) { closeMenu(true); return; }
    closeMenu(); menuOwner = view; menu.replaceChildren();
    view.opener = opener || view.more;
    for (const [action, label, glyph] of [['pin',view.group.pinned?'取消置顶':'置顶','up'],['rename','编辑名称','compose'],['open','在资源管理器中打开','folder'],['archive',`归档已加载聊天（${view.group.threads.length}）`,'archive'],['remove','移除项目','close']]) {
      const item = element(document, 'button', 'project-menu-item'); item.type = 'button'; item.setAttribute('role','menuitem');
      item.tabIndex = -1;
      item.append(icon(document,glyph,{size:18}), document.createTextNode(label));
      item.disabled = busy || (action === 'remove' && !view.group.saved) || (['pin','rename','open'].includes(action) && !view.group.path) || (action === 'archive' && !view.group.threads.length);
      item.addEventListener('click', () => { const group=view.group; closeMenu(true); if(action==='remove')onRemove(group);else onAction?.(group, action); });
      menu.append(item);
    }
    showMenu(view, '项目操作', 'project', point);
  }
  function showMenu(owner, label, kind, point) {
    owner.more.setAttribute('aria-expanded', 'true');
    menu.setAttribute('aria-label', label);
    menu.dataset.kind = kind;
    menu.hidden = false;
    const rect = (owner.opener || owner.more).getBoundingClientRect();
    const maxLeft = document.documentElement.clientWidth - menu.offsetWidth - 8;
    const maxTop = document.documentElement.clientHeight - menu.offsetHeight - 8;
    const left = point && point.x > maxLeft ? point.x - menu.offsetWidth : point?.x ?? rect.left;
    const below = point?.y ?? rect.bottom + 4;
    const above = (point?.y ?? rect.top - 4) - menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(left, maxLeft))}px`;
    menu.style.top = `${Math.max(8, Math.min(below > maxTop && above >= 8 ? above : below, maxTop))}px`;
    (menu.querySelector('button:not(:disabled)') || menu).focus({ preventScroll: true });
  }
  function openThreadMenu(row, opener, point) {
    if (menuOwner === row && !point) { closeMenu(true); return; }
    closeMenu();
    menuOwner = row;
    row.opener = opener;
    menu.replaceChildren();
    for (const [action, label, glyph] of [['rename', '重命名', 'compose'], ['summarize', '摘要标题', 'spark'], ['archive', '归档', 'archive'], ['delete', '删除', 'trash']]) {
      const item = element(document, 'button', action === 'delete' ? 'project-menu-item project-menu-danger' : 'project-menu-item');
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      item.tabIndex = -1;
      item.append(icon(document, glyph, { size: 18 }), document.createTextNode(label));
      item.disabled = busy || !canManageThread(row.thread);
      item.addEventListener('click', () => {
        const target = row.thread;
        closeMenu(true);
        onThreadAction(target, action);
      });
      menu.append(item);
    }
    showMenu(row, `${row.title.textContent}的对话操作`, 'thread', point);
  }
  menu.tabIndex = -1;
  document.addEventListener('pointerdown', event => { if(menuOwner&&!menu.contains(event.target)&&!menuOwner.more.contains(event.target))closeMenu(); });
  document.defaultView.addEventListener('resize',()=>closeMenu());
  (host.closest('#thread-scroll') || host).addEventListener('scroll',()=>closeMenu());
  menu.addEventListener('keydown', event => {
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeMenu(true);}
    if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
      event.preventDefault();const items=[...menu.querySelectorAll('button:not(:disabled)')];const index=items.indexOf(document.activeElement);
      items[event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();
    }
    if(event.key==='Tab')closeMenu(true);
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
  // Search feedback: shown immediately while a query runs, and as the result count afterwards.
  const statusNode = element(document, 'p', 'project-navigation-status');
  statusNode.setAttribute('role', 'status'); statusNode.setAttribute('aria-live', 'polite'); statusNode.hidden = true;
  const statusText = element(document, 'span', 'project-navigation-status-text');
  statusNode.append(element(document, 'span', 'project-navigation-spinner'), statusText);
  host.replaceChildren(errorNode, statusNode, list, empty);
  const reducedMotion = () => document.documentElement?.dataset?.reducedMotion === 'true';
  let previousOrder = '';

  function setOpen(view, open, remember = true) {
    if (remember) openGroups.set(view.group.key, open);
    view.open = open;
    view.threads.hidden = !open;
    if (!open && menuOwner?.view === view) closeMenu();
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
    header.addEventListener('contextmenu', event => {
      event.preventDefault();
      const opener = event.target.closest('button') || (select.hidden ? more : select);
      const point = event.button === 2 || event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined;
      openMenu(view, opener, point);
    });
    header.addEventListener('keydown', event => {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
      event.preventDefault();
      openMenu(view, event.target);
    });
    compose.addEventListener('click',()=>{if(!busy&&(view.group.path||view.group.projectless))onAction?.(view.group,'new');});
    toggle.addEventListener('click', () => setOpen(view, !view.open));
    select.addEventListener('click', () => {
      if (!busy && (view.group.path||view.group.projectless)) onSelect(view.group);
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
        const spinner = element(document, 'span', 'thread-running-indicator');
        spinner.setAttribute('aria-hidden', 'true');
        const unreadIndicator = element(document, 'span', 'thread-unread-indicator');
        unreadIndicator.setAttribute('aria-hidden', 'true');
        button.append(title, spinner, unreadIndicator);
        const node = element(document, 'div', 'project-thread-row');
        node.append(button);
        row = { node, button, title, spinner, unreadIndicator, thread, view };
        button.addEventListener('click', () => onOpenThread(row.thread.id));
        if (onThreadAction) {
          const more = element(document, 'button', 'project-thread-action');
          more.type = 'button';
          more.setAttribute('aria-haspopup', 'menu');
          more.setAttribute('aria-expanded', 'false');
          more.title = '对话操作';
          more.append(icon(document, 'more', { size: 16 }));
          row.more = more;
          node.append(more);
          more.addEventListener('click', () => openThreadMenu(row, more));
          node.addEventListener('contextmenu', event => {
            event.preventDefault();
            const point = event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined;
            openThreadMenu(row, button, point);
          });
          button.addEventListener('keydown', event => {
            if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
            event.preventDefault();
            openThreadMenu(row, button);
          });
        }
        view.threadViews.set(thread.id, row);
      }
      row.thread = thread;
      const title = thread.name || thread.preview || '未命名对话';
      setText(row.title, title);
      row.more?.setAttribute('aria-label', `${title}的对话操作`);
      const running = view.runningThreadIds.has(thread.id);
      const unread = !running && view.unreadThreadIds.has(thread.id);
      const description = running ? `${title} · 运行中` : unread ? `${title} · 新一轮已完成，未读` : title;
      row.button.title = description;
      row.button.setAttribute('aria-label', description);
      row.button.classList.toggle('running', running);
      row.spinner.hidden = !running;
      row.unreadIndicator.hidden = !unread;
      const active = thread.id === activeThreadId;
      row.button.classList.toggle('active', active);
      if (active) row.button.setAttribute('aria-current', 'page');
      else row.button.removeAttribute('aria-current');
      nodes.push(row.node);
    }
    if(all.length>5&&!view.searching){
      if(!view.showMore){view.showMore=element(document,'button','project-group-show-more');view.showMore.type='button';view.showMore.addEventListener('click',()=>{if(expandedGroups.has(view.group.key))expandedGroups.delete(view.group.key);else expandedGroups.add(view.group.key);updateThreads(view,view.activeThreadId);});}
      setText(view.showMore,expandedGroups.has(view.group.key)?'收起显示':`展开显示（${all.length-5}）`);view.showMore.setAttribute('aria-expanded',String(expandedGroups.has(view.group.key)));nodes.push(view.showMore);
    }
    const previous=[...view.threads.children], focusedIndex=previous.findIndex(node=>node.contains(document.activeElement)&&!nodes.includes(node));
    reconcile(view.threads, nodes);
    if(focusedIndex!==-1)(nodes[Math.min(focusedIndex,nodes.length-1)]?.querySelector('.project-group-thread')||view.toggle).focus({preventScroll:true});
    for (const [id, row] of view.threadViews) if (!ids.has(id)) {
      if (menuOwner === row) closeMenu();
      view.threadViews.delete(id);
    }
  }

  function render({ projects = [], threads = [], selectedPath = '', activeThreadId = '', runningThreadIds = new Set(), unreadThreadIds = new Set(), recent = {}, searching = false, searchStatus = '', busy: isBusy = false, error = '' }) {
    const focused = document.activeElement;
    const keepFocus = focused && host.contains(focused);
    const scrollTop = host.scrollTop;
    busy = isBusy;
    const selectedKey = projectPathKey(selectedPath);
    const selectionChanged = selectedKey !== previousSelectedKey;
    previousSelectedKey = selectedKey;
    const groups = projectThreadGroups(projects, threads, { selectedPath, searching, runningThreadIds, recent });
    const keys = new Set();
    const nodes = [];
    for (const group of groups) {
      keys.add(group.key);
      let view = views.get(group.key);
      if (!view) { view = createGroup(group); views.set(group.key, view); }
      view.group = group;
      view.searching = searching; view.activeThreadId = activeThreadId; view.runningThreadIds = runningThreadIds; view.unreadThreadIds = unreadThreadIds;
      const selectable=!!group.path||group.projectless===true;
      view.compose.hidden = !selectable; view.compose.disabled = busy;
      view.more.disabled = busy;
      view.node.dataset.projectKey = group.key;
      const projectSelected = group.selected && !activeThreadId;
      view.node.classList.toggle('selected', projectSelected);
      view.node.setAttribute('aria-label', group.name);
      setText(view.select, group.name);
      setText(view.unknown, group.name);
      view.select.title = group.path || group.name;
      view.select.hidden = !selectable;
      view.unknown.hidden = selectable;
      view.select.disabled = busy || !selectable;
      view.select.setAttribute('aria-pressed', String(projectSelected));
      if (projectSelected) view.select.setAttribute('aria-current', 'page');
      else view.select.removeAttribute('aria-current');
      if (!openGroups.has(group.key)) openGroups.set(group.key, true);
      if (selectionChanged && group.selected) openGroups.set(group.key, true);
      setOpen(view, searching || openGroups.get(group.key), false);
      updateThreads(view, activeThreadId);
      nodes.push(view.node);
    }
    // A newly used or pinned project moves to its new position with a short FLIP slide.
    const order = groups.map(group => group.key).join('\n');
    const before = new Map();
    if (previousOrder && order !== previousOrder && !reducedMotion()) for (const node of nodes) if (node.isConnected) { const top = node.getBoundingClientRect?.().top; if (Number.isFinite(top)) before.set(node, top); }
    previousOrder = order;
    reconcile(list, nodes);
    for (const [node, top] of before) {
      const delta = top - node.getBoundingClientRect().top;
      if (Math.abs(delta) > 1) node.animate?.([{ transform: `translateY(${delta}px)` }, { transform: 'none' }], { duration: 260, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
    }
    if (menuOwner && (!keys.has((menuOwner.view || menuOwner).group.key) || (menuOwner.view && (busy || !canManageThread(menuOwner.thread)) && !menu.querySelector('button')?.disabled))) closeMenu(true);
    for (const key of views.keys()) if (!keys.has(key)) views.delete(key);
    setText(errorNode, error);
    errorNode.hidden = !error;
    const status = typeof searchStatus === 'string' ? { text: searchStatus, busy: false } : searchStatus || { text: '', busy: false };
    setText(statusText, status.text || ''); statusNode.hidden = !status.text; statusNode.dataset.busy = String(!!status.busy);
    setText(empty, searching ? '无搜索结果' : '添加项目，或打开已有对话。');
    list.setAttribute('aria-busy', String(!!status.busy));
    empty.hidden = groups.length > 0 || !!status.busy;
    if (keepFocus && host.contains(focused) && document.activeElement !== focused) focused.focus({ preventScroll: true });
    if (host.scrollTop !== scrollTop) host.scrollTop = scrollTop;
  }

  return { render };
}
