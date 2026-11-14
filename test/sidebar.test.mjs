import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');const css=await readFile(new URL('../public/style.css',import.meta.url),'utf8');
function classList(node){const values=new Set();return{add(...names){for(const name of names)values.add(name);},remove(...names){for(const name of names)values.delete(name);},toggle(name,force){const next=force===undefined?!values.has(name):!!force;if(next)values.add(name);else values.delete(name);return next;},contains(name){return values.has(name);},values(){return [...values];},node};}
function element(id,{hidden=false}={}){let attributes={};const node={id,attributes,classList:classList(),visible:!hidden,focus(){document.activeElement=node;},setAttribute(name,value){attributes[name]=String(value);},removeAttribute(name){delete attributes[name];},getAttribute(name){return attributes[name];},getClientRects(){return node.visible?[{}]:[];},addEventListener(){},contains(other){return other===node||(id==='sidebar'&&(other===elements['close-sidebar']||other===elements['settings-sidebar-close']));},querySelectorAll(){return[];}};node.classList.node=node;elements[id]=node;return node;}
const elements={};const document={activeElement:null,createComment(){return {after(node){node.parentNode='rail';node.previousSibling=this;}};},querySelector(selector){return selector.includes('settings-dialog')?settingsActions:chatActions;}};
const chatActions={prepend(node){node.parentNode=this;node.previousSibling=null;}},settingsActions={prepend(node){node.parentNode=this;node.previousSibling=null;}};document.documentElement=element('root');document.body=element('body');
for(const id of ['app','sidebar','sidebar-overlay','rail-sidebar','settings-dialog','close-sidebar','settings-sidebar-close'])element(id);
elements['rail-sidebar'].before=anchor=>{elements['rail-sidebar'].parentNode='rail';elements['rail-sidebar'].previousSibling=anchor;};
elements['settings-dialog'].classList.add('hidden');
const media={matches:false,handler:null,addEventListener(type,handler){if(type==='change')media.handler=handler;}};
const window={matchMedia(){return media;}};
const $=id=>elements[id];
const start=app.indexOf('// sidebar-controller:start');const end=app.indexOf('// sidebar-controller:end',start);assert.ok(start>=0&&end>start,'sidebar controller markers missing');
const source=app.slice(app.indexOf('\n',start)+1,end);
const create=new Function('$','window','document','requestAnimationFrame',`${source}\nreturn sidebarController;`);
const sidebar=create($,window,document,callback=>callback());
const expanded=id=>elements[id].getAttribute('aria-expanded');
const hidden=()=>elements['sidebar-overlay'].classList.contains('hidden');
test('wide sidebar defaults open, collapses into real layout space, and reopens from the persistent rail entry',()=>{
 assert.equal(elements.sidebar.inert,false);assert.equal(expanded('rail-sidebar'),'true');assert.equal(expanded('rail-sidebar'),'true');assert.equal(elements.app.classList.contains('sidebar-collapsed'),false);assert.equal(hidden(),true);
 sidebar.toggle();assert.equal(elements.app.classList.contains('sidebar-collapsed'),true);assert.equal(elements.sidebar.inert,true);assert.equal(elements.sidebar.getAttribute('aria-hidden'),'true');assert.equal(expanded('rail-sidebar'),'false');assert.equal(expanded('rail-sidebar'),'false');
 sidebar.toggle();assert.equal(elements.app.classList.contains('sidebar-collapsed'),false);assert.equal(elements.sidebar.inert,false);assert.equal(elements.sidebar.getAttribute('aria-hidden'),undefined);assert.equal(expanded('rail-sidebar'),'true');
});
test('narrow sidebar uses an overlay, traps state through inert/aria, and returns focus to a visible toggle',()=>{
 media.matches=true;media.handler();assert.equal(elements.sidebar.inert,true);assert.equal(hidden(),true);assert.equal(expanded('rail-sidebar'),'false');
 document.activeElement=elements['rail-sidebar'];sidebar.toggle();assert.equal(elements.app.classList.contains('sidebar-open'),true);assert.equal(hidden(),false);assert.equal(elements.sidebar.inert,false);assert.equal(expanded('rail-sidebar'),'true');assert.equal(document.activeElement,elements['close-sidebar']);
 sidebar.close();assert.equal(elements.app.classList.contains('sidebar-open'),false);assert.equal(hidden(),true);assert.equal(elements.sidebar.inert,true);assert.equal(document.activeElement,elements['rail-sidebar']);
});
test('settings mode focuses its own close entry and breakpoint changes remove all overlay state',()=>{
 elements['settings-dialog'].classList.remove('hidden');media.matches=true;media.handler();document.activeElement=elements['rail-sidebar'];sidebar.toggle();assert.equal(document.activeElement,elements['settings-sidebar-close']);
 media.matches=false;media.handler();assert.equal(elements.app.classList.contains('sidebar-open'),false);assert.equal(elements.sidebar.inert,false);assert.equal(hidden(),true);assert.equal(expanded('rail-sidebar'),'true');
 media.matches=true;media.handler();assert.equal(elements.app.classList.contains('sidebar-open'),false);assert.equal(elements.sidebar.inert,true);assert.equal(hidden(),true);assert.equal(expanded('rail-sidebar'),'false');
});
test('static shell exposes one overlay, two in-sidebar closers, and a single persistent rail control',()=>{
 assert.equal((html.match(/id="sidebar-overlay"/g)||[]).length,1);assert.equal((html.match(/id="sidebar"/g)||[]).length,1);
 for(const id of ['close-sidebar','settings-sidebar-close'])assert.match(html,new RegExp(`id="${id}"[^>]*aria-label="收起侧栏"`));
 assert.doesNotMatch(html,/id="toggle-sidebar"/);assert.doesNotMatch(app,/toggle-sidebar/);assert.match(html,/id="rail-sidebar"[^>]*aria-controls="sidebar"[^>]*aria-expanded="true"/);
 assert.doesNotMatch(app,/show-sidebar/);assert.doesNotMatch(css,/show-sidebar/);
 assert.match(css,/\.app\.sidebar-collapsed \.sidebar\s*\{\s*display:\s*none/);assert.match(css,/\.app\.sidebar-open \.sidebar\s*\{[^}]*visibility:\s*visible/s);assert.match(css,/\.sidebar-overlay\s*\{[^}]*position:\s*fixed[^}]*inset:\s*0 0 0 var\(--rail-width\)/s);
});


test('one sidebar control relocates on narrow chat/settings and restores on wide view',()=>{
 media.matches=true;media.handler();sidebar.setRoute('chat');assert.equal(elements['rail-sidebar'].parentNode,chatActions);
 sidebar.setRoute('settings');assert.equal(elements['rail-sidebar'].parentNode,settingsActions);
 media.matches=false;media.handler();assert.equal(elements['rail-sidebar'].parentNode,'rail');
});
