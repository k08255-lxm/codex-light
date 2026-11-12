// Minimal DOM for behaviour tests of DOM-building modules. Not a browser: no layout or CSS.
class ClassList {
  constructor(node) { this.node = node; }
  get values() { return this.node.className.split(/\s+/).filter(Boolean); }
  add(...names) { this.node.className = [...new Set([...this.values, ...names])].join(' '); }
  remove(...names) { this.node.className = this.values.filter(name => !names.includes(name)).join(' '); }
  toggle(name, force) { const next = force === undefined ? !this.contains(name) : !!force; if (next) this.add(name); else this.remove(name); return next; }
  contains(name) { return this.values.includes(name); }
}
export class MiniNode {
  constructor(document, tag, text = '') {
    this.ownerDocument = document; this.tagName = tag.toUpperCase(); this.tag = tag.toLowerCase(); this.children = []; this.parentElement = null;
    this.className = ''; this.id = ''; this.dataset = {}; this.attributes = {}; this.listeners = {}; this.hidden = false; this._open = false; this._text = text; this.style = { setProperty() {} };
    this.classList = new ClassList(this);
  }
  get open() { return this._open; }
  set open(value) { const next = !!value; if (next === this._open) return; this._open = next; this.dispatch('toggle'); }
  get textContent() { return this.tag === '#text' ? this._text : this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value ?? ''); for (const child of this.children) child.parentElement = null; this.children = []; }
  set innerHTML(_) { throw new Error('innerHTML is forbidden'); }
  get firstChild() { return this.children[0] || null; }
  get options() { return this.children.filter(child => child.tag === 'option'); }
  append(...nodes) { for (const node of nodes) this.insertBefore(typeof node === 'string' ? this.ownerDocument.createTextNode(node) : node, null); }
  insertBefore(node, reference) {
    if (node.tag === '#fragment') { for (const child of [...node.children]) this.insertBefore(child, reference); return node; }
    if (node.parentElement) node.remove();
    const index = reference ? this.children.indexOf(reference) : -1;
    this.children.splice(index < 0 ? this.children.length : index, 0, node); node.parentElement = this; return node;
  }
  replaceChildren(...nodes) { for (const child of this.children) child.parentElement = null; this.children = []; this._text = ''; this.append(...nodes); }
  replaceWith(node) { const parent = this.parentElement; if (!parent) return; parent.insertBefore(node, this); this.remove(); }
  remove() { if (!this.parentElement) return; const list = this.parentElement.children; list.splice(list.indexOf(this), 1); this.parentElement = null; }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  setAttribute(key, value) { this.attributes[key] = String(value); if (key === 'id') this.id = String(value); if (key === 'class') this.className = String(value); }
  getAttribute(key) { return key in this.attributes ? this.attributes[key] : null; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  dispatch(name, event = {}) { const e = { type: name, target: this, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...event }; for (const callback of this.listeners[name] || []) callback(e); return e; }
  click() { return this.dispatch('click'); }
  focus() { this.ownerDocument.activeElement = this; }
  scrollIntoView() {}
  get descendants() { return [this, ...this.children.flatMap(child => child.descendants)]; }
  querySelectorAll(selector) { return this.descendants.slice(1).filter(node => matches(node, selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
function matches(node, selector) {
  return selector.split(',').some(part => {
    const s = part.trim();
    if (s.startsWith('#')) return node.id === s.slice(1) || node.attributes.id === s.slice(1);
    const m = /^([a-z]*)((?:\.[\w-]+)*)(?:\[([\w-]+)(?:="([^"]*)")?\])?$/i.exec(s);
    if (!m) throw new Error('unsupported selector ' + s);
    if (m[1] && node.tag !== m[1].toLowerCase()) return false;
    for (const name of (m[2] || '').split('.').filter(Boolean)) if (!node.classList.contains(name)) return false;
    if (m[3]) { const value = m[3].startsWith('data-') ? node.dataset[m[3].slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] : node.getAttribute(m[3]); if (value === undefined || value === null) return false; if (m[4] !== undefined && String(value) !== m[4]) return false; }
    return true;
  });
}
export function createDocument() {
  const document = { activeElement: null, defaultView: { navigator: {} } };
  document.createElement = tag => new MiniNode(document, tag);
  document.createElementNS = (_, tag) => new MiniNode(document, tag);
  document.createTextNode = text => new MiniNode(document, '#text', String(text));
  document.createDocumentFragment = () => new MiniNode(document, '#fragment');
  document.body = new MiniNode(document, 'body');
  return document;
}
export const visibleText = node => node.hidden ? '' : node.tag === '#text' ? node._text : node._text + node.children.map(visibleText).join('');
