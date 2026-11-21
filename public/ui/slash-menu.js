// Composer slash menu: caret-local `/token` → implemented commands and real skills.
// Keyboard: ↑/↓ skip disabled rows, Enter/Tab choose, Escape closes. IME composition is handled by
// the caller (composition keys never reach here). Only the token is replaced; the draft is never sent.
import { slashQuery, slashEntries, skillsFromResponse, replaceSlashToken } from '../state.js';
import { icon } from '../icons.js';

/**
 * @param {object} deps
 * @param {HTMLTextAreaElement} deps.prompt  @param {HTMLElement} deps.menu
 * @param {() => {thread:boolean,busy:boolean,sending:boolean,connected:boolean,cwd:string}} deps.context
 * @param {Function} deps.readSkills read-only skill catalog for the active project or session cwd
 * @param {Record<string, Function>} deps.commands  handlers for implemented command ids
 * @param {() => void} deps.onDraftChange  called after the draft text changes
 */
export function createSlashMenu({ document, prompt, menu, el, readSkills, context, commands, onDraftChange }) {
  const slash = { open: false, entries: [], index: 0 };
  const empty = () => ({ key: '', rows: [], loading: false, error: '' });
  let skills = empty();
  let contextKey = '';
  let controller = null;
  let forceNextRead = false;
  const keyFor = ({ cwd, connected, serverInstance, runtimeTarget }) => JSON.stringify([cwd || '', connected, serverInstance, runtimeTarget]);

  async function loadSkills() {
    const current = context();
    const key = keyFor(current);
    if (!current.connected || skills.key === key) return;
    const request = new AbortController();
    controller = request;
    skills = { ...empty(), key, loading: true };
    try {
      const result = await readSkills(current.cwd, { forceReload: forceNextRead, signal: request.signal });
      if (controller !== request || keyFor(context()) !== key) return;
      skills = { ...empty(), key, rows: skillsFromResponse(result) };
      forceNextRead = false;
    } catch (error) {
      if (controller !== request || keyFor(context()) !== key) return;
      skills = { ...empty(), key, error: error.message || String(error) };
    }
    controller = null;
    if (slash.open) update();
  }
  function close() {
    if (!slash.open) return;
    slash.open = false; menu.classList.add('hidden'); prompt.setAttribute('aria-expanded', 'false'); prompt.removeAttribute('aria-activedescendant');
  }
  function update() {
    const query = slashQuery(prompt.value, prompt.selectionStart ?? prompt.value.length);
    if (!query) { close(); return; }
    syncContext(false);
    void loadSkills();
    const entries = slashEntries(query.query, skills.rows, context());
    const firstEnabled = entries.findIndex(entry => entry.enabled);
    if (!slash.open || slash.entries.length !== entries.length || slash.entries.some((entry, i) => entry.id !== entries[i].id)) slash.index = Math.max(0, firstEnabled);
    slash.entries = entries; slash.open = true;
    render();
  }
  function render() {
    const fragment = document.createDocumentFragment();
    let lastKind = '';
    slash.entries.forEach((entry, i) => {
      if (entry.kind !== lastKind) { fragment.append(el('div', 'slash-group', entry.kind === 'command' ? '命令' : '技能（插入为提示引用）')); lastKind = entry.kind; }
      const option = el('div', 'slash-option'); option.id = 'slash-option-' + i; option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(i === slash.index)); option.setAttribute('aria-disabled', String(!entry.enabled));
      const glyph = el('span', 'slash-icon'); glyph.append(icon(document, entry.icon || 'info', { size: 16 }));
      option.append(glyph, el('span', 'slash-title', entry.title), el('span', 'slash-label', entry.label), el('span', 'slash-detail', entry.enabled ? entry.detail : entry.reason));
      option.addEventListener('pointerdown', event => { event.preventDefault(); slash.index = i; choose(); });
      fragment.append(option);
    });
    if (skills.loading) fragment.append(el('div', 'slash-empty', '正在读取技能…'));
    else if (skills.error) fragment.append(el('div', 'slash-empty', '技能列表读取失败：' + skills.error));
    if (!slash.entries.length && !skills.loading) fragment.append(el('div', 'slash-empty', '没有匹配的命令或技能'));
    menu.replaceChildren(fragment); menu.classList.remove('hidden');
    prompt.setAttribute('aria-expanded', 'true');
    if (slash.entries.length) { prompt.setAttribute('aria-activedescendant', 'slash-option-' + slash.index); menu.querySelector?.('#slash-option-' + slash.index)?.scrollIntoView?.({ block: 'nearest' }); }
    else prompt.removeAttribute('aria-activedescendant');
  }
  function move(step) {
    const { entries } = slash; if (!entries.length) return;
    let next = slash.index;
    for (let n = 0; n < entries.length; n++) { next = (next + step + entries.length) % entries.length; if (entries[next].enabled) break; }
    slash.index = next; render();
  }
  function choose() {
    const entry = slash.entries[slash.index]; if (!entry || !entry.enabled) return;
    const token = slashQuery(prompt.value, prompt.selectionStart ?? prompt.value.length);
    close(); if (!token) return;
    // Only the `/token` is replaced; the rest of the draft stays exactly as typed and is never sent here.
    const next = replaceSlashToken(prompt.value, token, entry.kind === 'skill' ? '$' + entry.name : '');
    prompt.value = next.value; prompt.setSelectionRange(next.caret, next.caret); onDraftChange();
    if (entry.kind === 'skill') { prompt.focus(); return; }
    commands[entry.id]?.();
  }
  /** Handles a non-composing keydown while the menu is open. Returns true when consumed. */
  function handleKey(event) {
    if (!slash.open) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); move(event.key === 'ArrowDown' ? 1 : -1); return true; }
    if (((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') && slash.entries.length) { event.preventDefault(); choose(); return true; }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return true; }
    return false;
  }
  function invalidateSkills({ updateOpen = true, forceReload = true } = {}) {
    controller?.abort();
    controller = null;
    skills = empty();
    forceNextRead ||= forceReload;
    if (updateOpen && slash.open) update();
  }
  function syncContext(updateOpen = true) {
    const key = keyFor(context());
    if (key === contextKey) return;
    contextKey = key;
    invalidateSkills({ updateOpen, forceReload: false });
  }
  return { update, close, handleKey, invalidateSkills, syncContext, isOpen: () => slash.open, snapshot: () => ({ ...slash, skills }) };
}
