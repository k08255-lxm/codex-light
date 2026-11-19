import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';import path from 'node:path';import {createServer} from '../src/server.mjs';import {DemoClient} from '../src/demo.mjs';
const {chromium}=createRequire(import.meta.url)('playwright');const out=path.resolve('artifacts/settings-motion');await mkdir(out,{recursive:true});const profile=await mkdtemp(path.join(out,'profile-'));const app=await createServer({client:new DemoClient(),demo:true,cwd:process.cwd(),desktopStateRoot:path.join(profile,'state'),projectsRoot:path.join(profile,'projects')});await app.started;const browser=await chromium.launchPersistentContext(profile,{headless:true,executablePath:process.env.CHROMIUM_PATH,viewport:{width:1257,height:945},reducedMotion:'no-preference'});const page=browser.pages()[0],checks=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.route('**/api/storage/scan',route=>route.fulfill({json:{categories:['cache','images','install'].map(category=>({category,bytes:2097152,cleanableBytes:1048576,protectedBytes:1048576,fileCount:3,impact:'测试：保留正在使用的数据，只处理明确归属本应用的旧文件。',warnings:[]})),recoveries:[],note:'仅演示扫描结果；没有清理真实文件。'}}));
await page.addInitScript(() => {
  window.fixtureNotificationPermission = 'permission_required';
  window.codexLightQuestionNotifications = {
    status: () => window.fixtureNotificationPermission,
    requestPermission: async () => {
      window.fixtureNotificationPermission = 'ready';
      return 'granted';
    },
  };
});
let releaseDsh;
const pendingDsh = new Promise(resolve => { releaseDsh = resolve; });
const dshModels = [
  {model:'same-model',provider:'team-z',name:'同名模型',providerName:'Z 服务'},
  {model:'same-model',provider:'team-a',name:'同名模型',providerName:'A 服务'},
  {model:'alpha',provider:'team-z',name:'Alpha',providerName:'Z 服务'},
];
let dshSelection = {model:'removed-model',provider:'retired'};
const dshSaves = [];
await page.route('**/api/dsh/connection/status', async route => {
  await pendingDsh;
  await route.fulfill({json:{bundled:{available:true},registration:{state:'none'},modelDefaults:{available:true,selection:dshSelection,models:dshModels}}});
});
await page.route('**/api/dsh/connection/saveModel', route => {
  ({selection:dshSelection}=route.request().postDataJSON());
  dshSaves.push(dshSelection);
  return route.fulfill({json:{available:true,selection:dshSelection}});
});
const models = [
  {model:'example-codex', displayName:'示例模型'},
  {model:'example-long-model-id-for-checking-the-width', displayName:'用于验证长名称展示的第二个模型'},
];
await page.route('**/api/title-summary/status', route => route.fulfill({json:{enabled:true,model:models[1].model}}));
await page.route('**/api/title-summary/models', route => route.fulfill({json:{data:models}}));
await page.route('**/api/title-summary/test', route => route.fulfill({json:{title:'检查会话配置'}}));
await page.route('**/api/config-settings/read', route => route.fulfill({json:{fields:{model:{readonly:false,value:models[0].model,label:models[0].displayName,options:models.map(row=>row.model)}}}}));
try{await page.goto(app.url);await page.locator('#connection-text').filter({hasText:'演示模式'}).waitFor();await page.locator('#rail-settings').click();await page.locator('[data-settings-section="appearance"]').click();let active=await page.locator('#settings-appearance').evaluate(n=>n.getAnimations().map(a=>({duration:a.effect.getTiming().duration,frames:a.effect.getKeyframes()})));assert(active.length>0,'pointer section entrance animates');assert(active.every(a=>a.duration<=200));checks.push('pointer settings entrance <= 200ms');
const search=page.getByRole('searchbox',{name:'搜索设置'});
await search.fill('工作目录');
await page.locator('#settings-search-results').getByRole('button',{name:'工作目录 连接与运行',exact:true}).click();
assert(await page.locator('#settings-general').isVisible());
assert.equal(await page.evaluate(()=>document.activeElement.textContent),'工作目录');
await search.fill('zzzzzz');
assert(await page.getByText('没有找到相关设置').isVisible());
await search.press('Escape');
assert(await page.locator('#settings-nav').isVisible());
await search.fill('减少动画');
await search.press('Enter');
assert(await page.locator('#settings-appearance').isVisible());
checks.push('settings search opens exact rows across sections and clears empty searches');
await search.fill('DSH 默认模型');
await search.press('ArrowDown');
await page.keyboard.press('Enter');
assert(await page.locator('#settings-dsh').isVisible());
assert.equal(await page.evaluate(()=>document.activeElement.id),'dsh-connection-root');
releaseDsh();
await page.waitForFunction(() => document.activeElement.textContent === '子代理默认模型');
const dshModel=page.locator('.dsh-default-model').getByRole('combobox',{name:'模型',exact:true});
const dshGroups=()=>dshModel.evaluate(select=>[...select.querySelectorAll('optgroup')].map(group=>[
  group.label,[...group.querySelectorAll('option')].map(option=>option.textContent),
]));
assert.equal(await dshModel.evaluate(select=>select.multiple),false);
assert.deepEqual(await dshGroups(),[
  ['Z 服务',['同名模型','Alpha']],['A 服务',['同名模型']],['当前目录外',['removed-model · retired（已保存）']],
]);
assert.equal(await dshModel.inputValue(),'["retired","removed-model"]');
await dshModel.focus();
await page.keyboard.press('Home');
assert.equal(await dshModel.inputValue(),'["team-z","same-model"]');
await page.keyboard.press('ArrowDown');
assert.equal(await dshModel.inputValue(),'["team-z","alpha"]');
await page.keyboard.press('ArrowDown');
assert.equal(await dshModel.inputValue(),'["team-a","same-model"]');
const dshSave=page.getByRole('button',{name:'保存默认模型',exact:true});
await page.keyboard.press('Tab');
assert(await dshSave.evaluate(button=>button===document.activeElement));
await page.keyboard.press('Enter');
await page.getByText('已保存，下次新建子代理时生效。',{exact:true}).waitFor();
assert.deepEqual(dshSaves,[{provider:'team-a',model:'same-model'}]);
assert.deepEqual(await dshGroups(),[['Z 服务',['同名模型','Alpha']],['A 服务',['同名模型']]]);
await page.getByRole('button',{name:'恢复 DSH 默认值',exact:true}).click();
await page.getByText('已恢复 DSH 默认值。',{exact:true}).waitFor();
assert.equal(await dshModel.inputValue(),'');
assert.deepEqual(dshSaves,[{provider:'team-a',model:'same-model'},null]);
checks.push('native DSH model groups preserve catalog order, keyboard selection, legacy value and reset');
await search.fill('模型');
await search.press('ArrowDown');
await page.keyboard.press('End');
assert(await page.locator('#settings-search-results button').last().evaluate(node=>node===document.activeElement));
await page.keyboard.press('Home');
await page.keyboard.press('ArrowUp');
assert(await search.evaluate(node=>node===document.activeElement));
await search.press('ArrowUp');
await page.keyboard.press('Escape');
assert(await search.evaluate(node=>node===document.activeElement));
assert.equal(await search.inputValue(),'');
checks.push('keyboard search locates a lazy DSH default-model panel when its response arrives');

const permission = page.locator('#question-notification-permission');
const title = page.locator('#title-settings-root');
const titleModel = title.getByLabel('标题总结模型');
const configModel = page.locator('#config-panel').getByLabel('默认模型');
const finishSectionMotion = locator => locator.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished.catch(()=>{}))));
async function searchFor(query, narrow) {
  if (narrow) await page.locator('#rail-sidebar').click();
  await search.fill(query);
  await search.press('Enter');
}
async function verifySettingsLayout(narrow) {
  const size = narrow ? 'narrow' : 'wide';
  await searchFor('允许通知', narrow);
  assert(await permission.evaluate(node=>node===document.activeElement));
  const notifications = page.locator('#settings-notifications');
  await finishSectionMotion(notifications);
  const insets = await permission.evaluate(node=>{
    const panel=node.closest('.panel').getBoundingClientRect(), button=node.getBoundingClientRect();
    const toggle=document.getElementById('preference-approval').getBoundingClientRect();
    return {bottom:panel.bottom-button.bottom,right:panel.right-button.right,alignment:Math.abs(button.right-toggle.right)};
  });
  assert(insets.bottom>=14&&insets.right>=14&&insets.alignment<=1,JSON.stringify(insets));
  await page.screenshot({path:path.join(out,`notifications-${size}-permission.png`)});
  await permission.click();
  await permission.waitFor({state:'hidden'});
  assert.match(await page.locator('#question-notification-status').textContent(),/已授权/);
  await searchFor('允许通知', narrow);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'question-notification-label');
  await page.mouse.move(2,2);
  await page.screenshot({path:path.join(out,`notifications-${size}-granted.png`)});

  await searchFor('摘要标题', narrow);
  assert.equal(await page.evaluate(()=>document.activeElement.textContent),'对话标题');
  await titleModel.selectOption(models[0].model);
  await configModel.selectOption(models[1].model);
  await searchFor('摘要标题', narrow);
  assert.equal(await titleModel.inputValue(),models[0].model);
  assert.equal(await configModel.inputValue(),models[1].model);
  await title.getByRole('button',{name:'立即测试'}).click();
  await title.locator('.title-test-copy').getByRole('status').filter({hasText:'测试成功 · 检查会话配置'}).waitFor();
  await titleModel.selectOption(models[1].model);
  await finishSectionMotion(page.locator('#settings-configuration'));
  assert(await page.locator('.settings-content').evaluate(node=>node.scrollWidth<=node.clientWidth));
  await page.screenshot({path:path.join(out,`configuration-${size}.png`)});
  await title.screenshot({path:path.join(out,`title-settings-${size}.png`)});
  checks.push(`${size} settings: permission button alignment and removal, title feedback, draft preservation, and no overflow`);
}
await verifySettingsLayout(false);
await page.locator('[data-settings-section="general"]').focus();await page.keyboard.press('Enter');assert((await page.locator('#settings-general').evaluate(n=>n.getAnimations().length))>0);checks.push('keyboard settings switch also transitions');
for(const mode of ['app','system']){await page.evaluate(mode=>{if(mode==='app')document.documentElement.dataset.reducedMotion='true';else delete document.documentElement.dataset.reducedMotion;},mode);await page.emulateMedia({reducedMotion:mode==='system'?'reduce':'no-preference'});await page.locator('[data-settings-section="appearance"]').click();assert.equal(await page.locator('#settings-appearance').evaluate(n=>n.getAnimations().length),0);await page.locator('[data-settings-section="general"]').click();checks.push(mode+' reduced motion: no animation');}
await page.emulateMedia({reducedMotion:'no-preference'});await page.evaluate(()=>delete document.documentElement.dataset.reducedMotion);await page.locator('[data-settings-section="storage"]').click();await page.getByText('仅演示扫描结果；没有清理真实文件。',{exact:true}).waitFor();await page.locator('#settings-storage').evaluate(n=>Promise.all(n.getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{}))));await page.screenshot({path:path.join(out,'storage-desktop.png')});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);checks.push('storage layout no horizontal overflow');
await page.setViewportSize({width:390,height:844});await page.locator('#rail-sidebar').click();active=await page.locator('#sidebar').evaluate(n=>n.getAnimations().map(a=>a.effect.getTiming().duration));assert(active.length>0);await page.keyboard.press('Escape');assert((await page.locator('#sidebar').evaluate(n=>n.getAnimations().length))>0);assert.equal(await page.locator('#rail-sidebar').getAttribute('aria-expanded'),'false');checks.push('mobile sidebar opens and exits smoothly');await page.locator('#sidebar').evaluate(n=>Promise.all(n.getAnimations().map(a=>a.finished.catch(()=>{}))));await page.screenshot({path:path.join(out,'storage-mobile.png')});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
await page.evaluate(()=>{window.fixtureNotificationPermission='permission_required';window.dispatchEvent(new Event('codexlight-question-notification-status'));});
await verifySettingsLayout(true);
assert.deepEqual(errors,[]);await writeFile(path.join(out,'result.json'),JSON.stringify({checks,errors},null,2));console.log(checks);
}finally{await browser.close();await app.close();}
