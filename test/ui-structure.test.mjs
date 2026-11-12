import test from 'node:test';import assert from 'node:assert/strict';import {readFile,readdir} from 'node:fs/promises';
// Static shell contract: every element looked up by code exists exactly once, no HTML sinks, and
// identity/warning copy that the product relies on. Visual tokens live in visual-style-ui.test.mjs.
const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const views=await Promise.all((await readdir(new URL('../public/ui/',import.meta.url))).filter(name=>name.endsWith('.js')).map(name=>readFile(new URL('../public/ui/'+name,import.meta.url),'utf8')));
const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);
const mountedOnce=id=>assert.equal(ids.filter(value=>value===id).length,1,`${id} must be mounted exactly once`);

test('HTML ids are unique and every literal $(id) lookup in app.js and view modules resolves',()=>{
 assert.equal(ids.length,new Set(ids).size,'duplicate HTML id');
 for(const source of [app,...views])for(const match of source.matchAll(/\$\('([^']+)'\)/g))assert.ok(ids.includes(match[1]),`missing element ${match[1]}`);
});

test('app shell and view modules build DOM without HTML or code strings',()=>{
 assert.doesNotMatch(app,/\.innerHTML\s*=/,'model content must not flow into HTML');
 for(const source of views)assert.doesNotMatch(source,/\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=|\beval\(|new Function\(/);
});

test('single mounts for review, menus and the separate terminal/Git/usage/account surfaces',()=>{
 for(const id of ['review-view','pr-review-panel','menu-file','menu-view','menu-help','menu-app','terminal-page','terminal-container','terminal-git-workspace','usage-page','stats-root','account-page','account-root','settings-plugins','settings-appearance','settings-notifications','settings-shortcuts'])mountedOnce(id);
 assert.doesNotMatch(html,/id="review-page"|id="menu-edit"|编辑菜单尚未实现|<button[^>]*disabled[^>]*>\s*编辑\s*<\/button>/);
});

test('product identity without nonofficial badges, and the meaningful safety warnings remain',()=>{
 assert.match(html,/<strong>Codex Light<\/strong>/);assert.doesNotMatch(html,/非官方|非 OpenAI 官方应用|class="version"|class="window-app-label"/);assert.doesNotMatch(app,/非官方实验客户端/);
 assert.match(app,/演示模式 · 不调用模型/);
 for(const warning of ['修改会直接影响源文件','配对码到期只结束本次配对流程','连接或配对成功不等于手机端已验证可用','不暂存、提交或推送','不会调用模型'])assert.ok(html.includes(warning),warning);
});
