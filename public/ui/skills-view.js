import { icon } from '../icons.js';
import { outcomeFromError } from '../submissions.js';
import { el } from './format.js';

const scopeLabels = {
  user: '用户',
  repo: '项目',
  system: '系统',
  admin: '管理员',
  plugin: '插件',
};
const cwdParams = cwd => cwd ? { cwd } : {};

export function skillCatalog(result) {
  if (!Array.isArray(result?.data)) throw new Error('Codex 返回的技能目录无效');
  const rows = new Map();
  const errors = [];
  let cwd = '';
  for (const entry of result.data) {
    if (!Array.isArray(entry?.skills)) throw new Error('Codex 返回的技能目录无效');
    if (!cwd && typeof entry.cwd === 'string') cwd = entry.cwd;
    for (const error of Array.isArray(entry.errors) ? entry.errors : []) {
      errors.push({
        message: typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : '无法读取技能',
        path: typeof error?.path === 'string' ? error.path : '',
      });
    }
    for (const skill of entry.skills) {
      if (typeof skill?.name !== 'string' || !skill.name || typeof skill.path !== 'string' || !skill.path || rows.has(skill.path)) continue;
      const scope = Object.hasOwn(scopeLabels, skill.scope) ? scopeLabels[skill.scope] : skill.scope;
      const plugin = typeof skill.pluginId === 'string' && skill.pluginId ? `插件 · ${skill.pluginId}` : '';
      rows.set(skill.path, {
        ...skill,
        displayName: skill.interface?.displayName || skill.name,
        summary: skill.interface?.shortDescription || skill.shortDescription || skill.description || '',
        source: [scope === '插件' && plugin ? '' : scope, plugin].filter(Boolean).join(' · ') || '来源未知',
      });
    }
  }
  return { cwd, rows, errors };
}

export function mountSkillsView(host, { read, write, pending, onCatalogChanged, pickImport, confirmImport, installImport, releaseUnknown }) {
  const document = host.ownerDocument;
  const make = (tag, className, text) => el(document, tag, className, text);
  const heading = make('h1', '', '技能');
  const refresh = make('button', 'btn ghost small');
  refresh.append(icon(document, 'refresh', { size: 16 }), make('span', '', '刷新'));
  refresh.type = 'button';
  const header = make('div', 'section-head');
  const actions = make('div', 'skills-header-actions');
  const importButton = make('button', 'btn primary small', '导入技能');
  importButton.type = 'button';
  importButton.hidden = true;
  actions.append(refresh, importButton);
  header.append(heading, actions);
  const importFeedback = make('p', 'fine skills-import-feedback');
  importFeedback.setAttribute('role','status');
  importFeedback.setAttribute('aria-live','polite');
  importFeedback.hidden = true;
  const contextLine = make('p', 'skills-context');
  const contextLabel = make('span');
  const contextPath = make('span', 'mono');
  contextLine.append(contextLabel, contextPath);

  const search = make('input');
  search.type = 'search';
  search.id = 'skills-search';
  search.placeholder = '搜索技能名称、来源或路径';
  search.setAttribute('aria-label', '搜索技能');
  const guidance = make('p', 'fine skills-guidance', '按技能路径修改 Codex 的启用状态。相同路径出现在其他项目中时也会生效。');
  const status = make('p', 'fine skills-status');
  status.setAttribute('role', 'status');
  const warnings = make('details', 'skills-warnings');
  const warningsTitle = make('summary');
  const warningList = make('ul');
  warnings.append(warningsTitle, warningList);
  warnings.hidden = true;
  const list = make('ul', 'skills-list');
  list.setAttribute('aria-label', '技能列表');
  host.classList.add('skills-settings');
  host.append(header, contextLine, guidance, importFeedback, search, status, warnings, list);

  const rendered = new Map();
  const saves = new Map();
  const messages = new Map();
  let context = {};
  let generation = 0;
  let loading = null;
  let catalog = null;
  let invalidated = true;
  let forceNextRead = false;
  let loadError = '';
  let active = false;
  let pendingSignature = '';
  let nextId = 0;
  let importAttempt = null;

  function showImportFeedback(text, error = false) {
    importFeedback.textContent = text;
    importFeedback.classList.toggle('skills-error',error);
    importFeedback.hidden = !text;
  }

  async function startImport() {
    if (!active || !context.connected || !context.canImportSkill || importAttempt) return;
    const attempt = new AbortController();
    importAttempt = attempt;
    const server = context.serverInstance;
    const current = () => !attempt.signal.aborted && active && context.connected && context.canImportSkill && context.serverInstance === server;
    let installing = false;
    let notice = '';
    render();
    try {
      showImportFeedback('请选择包含 SKILL.md 的技能文件夹。');
      const {plan} = await pickImport();
      if (!plan || !current()) return;
      const accepted = await confirmImport(
        `将 ${plan.name}（${plan.fileCount} 个文件）复制到本机 Codex 的个人技能目录。原文件不变，也不会覆盖现有技能。
只导入你信任的技能。导入不会运行任何内容，但 Codex 之后可能自动选用它。`,
        { titleText:'导入技能', acceptText:'导入', opener:importButton, signal:attempt.signal },
      );
      if (!accepted || !current()) return;
      installing = true;
      showImportFeedback('正在复制技能…');
      const result = await installImport(plan.id);
      notice = `已导入 ${result.name}。`;
      onCatalogChanged();
      void invalidate();
    } catch (error) {
      if (current()) {
        notice = installing && outcomeFromError(error) === 'unknown'
          ? '未能确认导入结果，个人技能目录中可能留下不完整的文件夹。请先刷新列表或检查目录。'
          : `导入失败：${error.message || String(error)}`;
        showImportFeedback(notice,true);
      }
    } finally {
      if (importAttempt === attempt) importAttempt = null;
      if (current() && !importFeedback.classList.contains('skills-error')) showImportFeedback(notice);
      render();
      if (current()) importButton.focus();
    }
  }
  importButton.addEventListener('click', () => { void startImport(); });

  function renderWarnings() {
    const errors = catalog?.errors || [];
    warnings.hidden = !errors.length;
    warningsTitle.textContent = `${errors.length} 个技能读取失败`;
    warningList.replaceChildren(...errors.map(error => {
      const item = make('li', '', error.message);
      if (error.path) item.append(make('code', '', error.path));
      return item;
    }));
  }

  function createRow(path) {
    const row = make('li', 'skills-row');
    const text = make('div', 'skills-row-text');
    const name = make('h2');
    const command = make('code');
    const title = make('div', 'skills-row-title');
    title.append(name, command);
    const description = make('p', 'fine skills-description');
    const details = make('details', 'skills-source');
    const source = make('summary');
    const fullPath = make('code', '', path);
    fullPath.id = `skills-path-${++nextId}`;
    details.append(source, fullPath);
    const feedback = make('p', 'skills-feedback');
    feedback.id = `skills-feedback-${nextId}`;
    feedback.setAttribute('role', 'status');
    text.append(title, description, details, feedback);
    const toggle = make('button', 'skills-switch');
    toggle.type = 'button';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-describedby', `${fullPath.id} ${feedback.id}`);
    const track = make('span', 'switch');
    track.setAttribute('aria-hidden', 'true');
    toggle.append(track);
    toggle.addEventListener('click', () => { void change(path); });
    row.append(text, toggle);
    return { row, name, command, description, details, source, feedback, toggle };
  }

  function render() {
    importButton.hidden = !context.canImportSkill || !pickImport || !confirmImport || !installImport;
    importButton.disabled = !context.connected || !!importAttempt;
    guidance.textContent = context.runtimeTarget === 'wsl'
      ? '可启用或停用 WSL 技能。暂不支持从 Windows 窗口导入到 WSL，请在 WSL 中使用个人技能目录。'
      : '按技能路径修改 Codex 的启用状态。相同路径出现在其他项目中时也会生效。';
    const records = pending();
    const canWrite = context.connected && !!context.serverInstance && !loadError;
    const restored = records.some(record => !record.path);
    const locked = new Set(records.map(record => record.path));
    const writing = new Set([...saves.keys(), ...locked]);
    const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rows = [...(catalog?.rows.values() || [])];
    const visible = rows.filter(skill => {
      const text = ['$' + skill.name, skill.displayName, skill.summary, skill.source, skill.path].join(' ').toLowerCase();
      return words.every(word => text.includes(word));
    });
    const sameName = new Map();
    for (const skill of rows) sameName.set(skill.name, (sameName.get(skill.name) || 0) + 1);

    contextLabel.textContent = context.projectless ? '无项目 · Codex 会话目录' : '当前项目';
    contextPath.textContent = context.cwd || catalog?.cwd || '';
    refresh.setAttribute('aria-disabled', String(!context.connected || !!loading));
    list.setAttribute('aria-busy', String(!!loading));
    const message = !context.connected ? 'Codex 连接已断开，无法读取技能目录。'
      : loadError ? `技能目录读取失败：${loadError}${rows.length ? '。下方为上次读取结果。' : ''}`
      : loading ? '正在读取技能…'
      : restored ? '正在同步技能状态…'
      : !rows.length ? (catalog?.errors.length ? '没有读到可用的技能。' : '未发现技能。')
      : !visible.length ? '没有匹配的技能。'
      : '';
    status.hidden = !message;
    if (status.textContent !== message) status.textContent = message;
    status.classList.toggle('skills-error', !!loadError);

    const nodes = visible.map(skill => {
      let view = rendered.get(skill.path);
      if (!view) {
        view = createRow(skill.path);
        view.details.open = sameName.get(skill.name) > 1;
        rendered.set(skill.path, view);
      }
      const { name, command, description, source, feedback, toggle, row } = view;
      name.textContent = skill.displayName;
      command.textContent = '$' + skill.name;
      description.textContent = skill.summary;
      description.hidden = !skill.summary;
      source.textContent = skill.source + ' · 路径';
      const busy = writing.has(skill.path);
      const toggleMessage = saves.has(skill.path) ? '正在更新…'
        : busy ? '正在同步技能状态…'
        : messages.get(skill.path)?.text || (typeof skill.enabled === 'boolean' ? '' : 'Codex 未报告启用状态。');
      if (feedback.textContent !== toggleMessage) feedback.textContent = toggleMessage;
      feedback.hidden = !toggleMessage;
      feedback.classList.toggle('skills-error', !busy && messages.get(skill.path)?.error === true);
      toggle.setAttribute('aria-checked', String(skill.enabled === true));
      toggle.setAttribute('aria-disabled', String(!canWrite || restored || busy || typeof skill.enabled !== 'boolean'));
      toggle.setAttribute('aria-label', skill.displayName + ' · ' + skill.source);
      return row;
    });
    for (const path of rendered.keys()) if (!catalog?.rows.has(path)) rendered.delete(path);
    if (nodes.length !== list.children.length || nodes.some((node, index) => list.children[index] !== node)) {
      const focused = document.activeElement;
      const hadFocus = list.contains(focused);
      list.replaceChildren(...nodes);
      if (hadFocus && active) (list.contains(focused) ? focused : search).focus({ preventScroll: true });
    }
  }

  function cancelRead() {
    generation++;
    loading?.abort();
    loading = null;
  }

  async function load(forceReload = false) {
    if (!active || !context.connected) return;
    cancelRead();
    const mine = generation;
    const controller = new AbortController();
    loading = controller;
    loadError = '';
    render();
    try {
      const unknown = releaseUnknown ? pending().filter(record => record.status === 'unknown') : [];
      const next = skillCatalog(await read(context.cwd, { forceReload:forceReload || unknown.length > 0, signal: controller.signal }));
      if (mine !== generation) return;
      catalog = next;
      invalidated = false;
      forceNextRead = false;
      for (const [path, message] of messages) {
        if (typeof message.enabled === 'boolean' && next.rows.get(path)?.enabled !== message.enabled) messages.delete(path);
      }
      renderWarnings();
      const current=()=>active && mine===generation && !controller.signal.aborted;
      for(const marker of unknown){
        if(!current())return;
        if(await releaseUnknown(marker.requestId,current)){
          if(marker.path)messages.delete(marker.path);
          onCatalogChanged();
        }
      }
      return true;
    } catch (error) {
      if (mine !== generation) return;
      loadError = error.message || String(error);
    } finally {
      if (mine === generation) {
        loading = null;
        render();
      }
    }
  }

  function invalidate({ forceReload = true } = {}) {
    invalidated = true;
    forceNextRead ||= forceReload;
    return load(forceNextRead);
  }

  function showEffective(path, enabled) {
    const current = catalog?.rows.get(path);
    if (current) current.enabled = enabled;
    messages.set(path, { text: enabled ? '已启用。' : '已停用。', enabled });
  }

  async function change(path) {
    const row = catalog?.rows.get(path);
    if (rendered.get(path)?.toggle.getAttribute('aria-disabled') !== 'false' || typeof row?.enabled !== 'boolean') return;
    const attempt = {};
    saves.set(path, attempt);
    messages.delete(path);
    render();
    let reload = false;
    try {
      const result = await write({ ...cwdParams(context.cwd), path, enabled: !row.enabled });
      if (saves.get(path) !== attempt) return;
      showEffective(path, result.effectiveEnabled);
      reload = true;
    } catch (error) {
      if (saves.get(path) !== attempt) return;
      const unknown = outcomeFromError(error) === 'unknown';
      messages.set(path, {
        text: unknown ? '更新结果待确认。可刷新查看当前状态。' : `更新失败：${error.message}`,
        error: true,
      });
      reload = unknown;
    } finally {
      if (saves.get(path) === attempt) {
        saves.delete(path);
        if (reload) {
          onCatalogChanged();
          void invalidate();
        }
        render();
      }
    }
  }

  function setContext(next) {
    if (next.cwd === context.cwd && next.projectless === context.projectless && next.connected === context.connected &&
        next.serverInstance === context.serverInstance && next.runtimeTarget === context.runtimeTarget && next.canImportSkill === context.canImportSkill) return;
    if (!next.connected || !next.canImportSkill || next.serverInstance !== context.serverInstance) { importAttempt?.abort(); showImportFeedback(''); }
    if (next.serverInstance !== context.serverInstance || next.runtimeTarget !== context.runtimeTarget) {
      saves.clear();
      messages.clear();
      forceNextRead = false;
    }
    context = next;
    cancelRead();
    catalog = null;
    loadError = '';
    invalidated = true;
    renderWarnings();
    if (active && context.connected) return load(forceNextRead);
    render();
  }

  refresh.addEventListener('click', () => {
    if (!context.connected || loading) return;
    onCatalogChanged();
    void invalidate();
  });
  search.addEventListener('input', render);
  return {
    setContext,
    activate() {
      active = true;
      if ((invalidated || pending().some(row=>row.status==='unknown')) && !loading && context.connected) return load(forceNextRead);
      render();
    },
    deactivate() {
      active = false;
      importAttempt?.abort();
      showImportFeedback('');
      if (loading) {
        cancelRead();
        invalidated = true;
      }
    },
    invalidate,
    recover(path, result, decision) {
      if (path && decision === 'succeeded') showEffective(path, result.effectiveEnabled);
      else if (path) messages.set(path, { text: '已确认原技能操作未成功。', error: true });
      void invalidate();
    },
    syncPending() {
      if (!active) return;
      const signature = JSON.stringify(pending());
      if (signature === pendingSignature) return;
      pendingSignature = signature;
      if(releaseUnknown && context.connected && pending().some(row=>row.status==='unknown'))void invalidate();
      else render();
    },
  };
}
