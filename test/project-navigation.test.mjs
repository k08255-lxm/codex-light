import test from 'node:test';
import assert from 'node:assert/strict';
import { mountProjectNavigation } from '../public/project-navigation.js';

class Element {
  constructor(tag, document) {
    this.tag = tag; this.ownerDocument = document; this.children = []; this.listeners = {};
    this.attributes = {}; this.dataset = {}; this.value = ''; this.hidden = false; this.disabled = false; this.scrollTop = 0;
    this.classes = new Set();
    this.classList = {
      add: name => this.classes.add(name),
      toggle: (name, value) => value ? this.classes.add(name) : this.classes.delete(name),
      contains: name => this.classes.has(name),
    };
  }
  get textContent() { return this.value + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.value = value; this.children = []; }
  set innerHTML(_) { throw new Error('Unsafe HTML'); }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
  replaceChildren(...nodes) { for (const node of [...this.children]) node.remove(); this.append(...nodes); }
  insertBefore(node, reference) {
    if (node.parentElement) node.remove();
    const index = reference ? this.children.indexOf(reference) : this.children.length;
    this.children.splice(index, 0, node); node.parentElement = this;
  }
  remove() {
    if (!this.parentElement) return;
    const children = this.parentElement.children;
    children.splice(children.indexOf(this), 1); this.parentElement = null;
  }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  click() { for (const callback of this.listeners.click || []) callback(); }
  focus(options) { this.ownerDocument.activeElement = this; this.focusOptions = options; }
}
function setup() {
  const document = { activeElement: null };
  document.createElement = tag => new Element(tag, document);
  document.createElementNS = (_, tag) => new Element(tag, document);
  const host = new Element('div', document);
  const calls = [];
  const navigation = mountProjectNavigation(host, {
    onSelect: group => calls.push(['select', group]),
    onOpenThread: id => calls.push(['open', id]),
    onRemove: group => calls.push(['remove', group]),
  });
  return { document, host, calls, ...navigation };
}
const all = node => [node, ...node.children.flatMap(all)];
const find = (node, className) => all(node).find(child => child.className === className);
const groups = host => all(host).filter(child => child.className === 'project-group');
const projects = [{ id: 'a', path: 'C:\\Work\\A', name: 'Alpha' }, { id: 'b', path: '/work/b', name: 'Beta' }];
const threads = [{ id: 'c', cwd: '/history/c', name: 'History' }, { id: 'a1', cwd: 'c:/work/a/', name: 'Alpha thread' }, { id: 'unknown', name: 'Unknown directory' }];

test('saved projects lead historical directories; unknown cwd cannot select a project', () => {
  const view = setup();
  view.render({ projects, threads, selectedPath: 'c:/WORK/a/', activeThreadId: 'a1' });
  const result = groups(view.host);
  assert.deepEqual(result.map(group => find(group, 'project-group-select').textContent), ['Alpha', 'Beta', 'c', '其他对话']);
  assert.equal(result[0].classList.contains('selected'), true);
  assert.equal(find(result[0], 'project-group-toggle').attributes['aria-expanded'], 'true');
  assert.equal(find(result[0], 'project-group-select').title, 'C:\\Work\\A');
  assert.equal(find(result[0], 'project-group-thread').attributes['aria-current'], 'page');
  assert.equal(find(result[3], 'project-group-select').hidden, true);
  assert.equal(find(result[3], 'project-group-unknown').hidden, false);
  find(result[3], 'project-group-select').click();
  assert.deepEqual(view.calls, []);
  assert.equal(find(result[2], 'project-group-remove').hidden, true);
});

test('a user collapse survives normalized selectedPath and list refresh; changed selection opens its group', () => {
  const view = setup();
  view.render({ projects, threads, selectedPath: 'C:\\Work\\A' });
  const first = groups(view.host)[0]; const toggle = find(first, 'project-group-toggle');
  toggle.click();
  view.render({ projects, threads, selectedPath: 'c:/WORK/a/' });
  assert.equal(groups(view.host)[0], first);
  assert.equal(toggle.attributes['aria-expanded'], 'false');
  assert.equal(find(first, 'project-group-threads').hidden, true);
  view.render({ projects, threads, selectedPath: '/work/b' });
  assert.equal(find(groups(view.host)[1], 'project-group-toggle').attributes['aria-expanded'], 'true');
  view.render({ projects, threads, selectedPath: 'C:\\Work\\A' });
  assert.equal(toggle.attributes['aria-expanded'], 'true');
});

test('search opens all result groups while retaining the normal collapsed state', () => {
  const view = setup();
  view.render({ projects, threads, selectedPath: 'C:\\Work\\A' });
  find(groups(view.host)[0], 'project-group-toggle').click();
  view.render({ projects, threads, selectedPath: 'C:\\Work\\A', searching: true });
  assert.equal(groups(view.host).length, 3);
  assert.ok(groups(view.host).every(group => find(group, 'project-group-toggle').attributes['aria-expanded'] === 'true'));
  view.render({ projects, threads, selectedPath: 'C:\\Work\\A' });
  assert.equal(find(groups(view.host)[0], 'project-group-toggle').attributes['aria-expanded'], 'false');
});

test('separate buttons dispatch latest group/thread data and busy only blocks project mutations', () => {
  const view = setup();
  view.render({ projects, threads, selectedPath: 'C:\\Work\\A', busy: true });
  const group = groups(view.host)[0];
  const select = find(group, 'project-group-select'); const remove = find(group, 'project-group-remove');
  assert.equal(select.disabled, true); assert.equal(remove.disabled, true);
  select.click(); remove.click(); assert.deepEqual(view.calls, []);
  find(group, 'project-group-thread').click(); assert.deepEqual(view.calls, [['open', 'a1']]);
  find(group, 'project-group-toggle').click();
  assert.equal(find(group, 'project-group-toggle').attributes['aria-expanded'], 'false');
  view.render({ projects: [{ ...projects[0], name: 'Renamed' }], threads, selectedPath: 'C:\\Work\\A' });
  select.click(); remove.click();
  assert.equal(view.calls[1][0], 'select'); assert.equal(view.calls[1][1].name, 'Renamed');
  assert.equal(view.calls[2][0], 'remove'); assert.equal(view.calls[2][1].projectId, 'a');
  assert.equal(remove.title, '从项目列表移除（不删除文件）');
});

test('refresh reuses focused thread buttons, preserves scroll and renders all untrusted text literally', () => {
  const view = setup();
  view.render({ projects, threads, selectedPath: 'C:\\Work\\A' });
  const group = groups(view.host)[0]; const button = find(group, 'project-group-thread');
  button.focus(); view.host.scrollTop = 67;
  view.render({ projects: [{ ...projects[0], name: '<img src=x>' }, projects[1]],
    threads: [{ ...threads[1], name: '<script>unsafe</script>' }, threads[0]], selectedPath: 'C:\\Work\\A', error: '<b>Failed</b>' });
  assert.equal(view.document.activeElement, button);
  assert.equal(find(groups(view.host)[0], 'project-group-thread'), button);
  assert.equal(view.host.scrollTop, 67);
  assert.equal(find(button, 'thread-name').textContent, '<script>unsafe</script>');
  assert.equal(find(view.host, 'project-navigation-error').textContent, '<b>Failed</b>');
  assert.ok(all(view.host).every(node => !['script', 'img', 'b'].includes(node.tag)));
});

test('empty and search empty states distinguish adding a project from no results', () => {
  const view = setup();
  view.render({ projects: [], threads: [] });
  const empty = find(view.host, 'project-navigation-empty');
  assert.equal(empty.hidden, false); assert.match(empty.textContent, /添加项目/);
  view.render({ projects, threads: [], searching: true });
  assert.equal(empty.textContent, '无搜索结果');
  assert.equal(groups(view.host).length, 0);
  view.render({ projects, threads: [] });
  assert.equal(empty.hidden, true);
});
