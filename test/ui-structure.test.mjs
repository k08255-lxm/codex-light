import test from 'node:test';import assert from 'node:assert/strict';import {readFile,readdir} from 'node:fs/promises';
// Static shell contract: every element looked up by code exists exactly once, no HTML sinks, and
// identity/warning copy that the product relies on. Visual tokens live in visual-style-ui.test.mjs.
const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const views=await Promise.all((await readdir(new URL('../public/ui/',import.meta.url))).filter(name=>name.endsWith('.js')).map(name=>readFile(new URL('../public/ui/'+name,import.meta.url),'utf8')));
const dynamicIds=new Set(['optimistic-messages']);
const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);
const mountedOnce=id=>assert.equal(ids.filter(value=>value===id).length,1,`${id} must be mounted exactly once`);

test('HTML ids are unique and every literal $(id) lookup in app.js and view modules resolves',()=>{
 assert.equal(ids.length,new Set(ids).size,'duplicate HTML id');
 for(const source of [app,...views])for(const match of source.matchAll(/\$\('([^']+)'\)/g))assert.ok(ids.includes(match[1])||dynamicIds.has(match[1]),`missing element ${match[1]}`);
});

test('app shell and view modules build DOM without HTML or code strings',()=>{
 assert.doesNotMatch(app,/\.innerHTML\s*=/,'model content must not flow into HTML');
 for(const source of views)assert.doesNotMatch(source,/\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=|\beval\(|new Function\(/);
});

test('single mounts for review, menus and the separate terminal/Git/usage/account surfaces',()=>{
 for(const id of ['menu-file','menu-view','menu-help','menu-app','terminal-page','terminal-container','terminal-git-workspace','usage-page','stats-root','account-page','account-root','settings-plugins','settings-appearance','settings-notifications','settings-shortcuts'])mountedOnce(id);
 assert.doesNotMatch(html,/id="review-page"|id="menu-edit"|编辑菜单尚未实现|<button[^>]*disabled[^>]*>\s*编辑\s*<\/button>/);
});

test('product identity without nonofficial badges, and the meaningful safety warnings remain',()=>{
 assert.match(html,/<strong>Codex Light<\/strong>/);assert.doesNotMatch(html,/非官方|非 OpenAI 官方应用|class="version"|class="window-app-label"/);assert.doesNotMatch(app,/非官方实验客户端/);
 assert.match(app,/演示模式 · 不调用模型/);
 for(const warning of ['修改会直接影响源文件','配对码到期只结束本次配对流程','连接或配对成功不等于手机端已验证可用','不暂存、提交或推送','不会调用模型'])assert.ok(html.includes(warning),warning);
});

test('dynamic optimistic host is created exactly once by composer beside messages, initially hidden',async()=>{
 const {createDocument}=await import('./mini-dom.mjs');
 const {createComposer}=await import('../public/ui/composer.js');
 assert.equal(ids.filter(id=>dynamicIds.has(id)).length,0,'dynamic hosts must not duplicate static HTML ids');
 const document=createDocument(),container=document.createElement('section'),messages=document.createElement('div');
 messages.id='messages';container.append(messages);document.body.append(container);
 createComposer({document,session:{},drafts:{},ledger:{},thread:{},view:{$:id=>id==='messages'?messages:null}});
 for(const id of dynamicIds){
  const matches=container.children.filter(node=>node.id===id);
  assert.equal(matches.length,1,`${id} must be mounted exactly once`);
  assert.equal(matches[0].parentElement,messages.parentElement);
  assert.equal(matches[0].hidden,true,'empty optimistic area must not occupy chat space');
 }
});
