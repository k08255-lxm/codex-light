import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument } from './mini-dom.mjs';
import { mountDshConnection, describeConnection, describeCallbackStatus } from '../public/ui/dsh-connection-view.js';

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const status = (over = {}) => ({ bundled: { available: true, version: '0.8.0-light.1', dependenciesReady: true }, dsh: { installed: true, executablePath: 'C:/Apps/DeepSeek Harness/DeepSeek Harness.exe' }, registration: { state: 'none', serverName: 'dsh_subagent' }, runtime: { state: null }, canConnect: true, error: null, ...over });
const bundled = runtime => status({ registration: { state: 'bundled', serverName: 'dsh_subagent' }, runtime: { state: runtime }, canConnect: false });
const fail = (code, message, outcome = 'notExecuted') => Object.assign(new Error(message), { code, outcome });

function harness(responses, opts = {}) {
  const document = createDocument(); const host = document.createElement('div'); const calls = []; let changes = 0;
  const api = async (path, body) => { calls.push([path, structuredClone(body)]); const next = responses.shift(); if (!next) throw new Error('unexpected call ' + path); if (next instanceof Error) throw next; return next; };
  const view = mountDshConnection(host, { api, wait: async () => {}, followUps: 2, onChange: () => changes++, ...opts });
  const byText = text => host.querySelectorAll('button').find(b => b.textContent === text);
  return { host, view, calls, byText, changes: () => changes, paths: () => calls.map(([path]) => path) };
}

test('the optional default model editor saves, confirms, clears and stays available without an installed DSH',async()=>{
  const selected={model:'vendor/fast',provider:'custom'};
  const models=[
    {...selected,name:'Fast',providerName:'Shared'},
    {model:'vendor/fast',provider:'other',name:'Fast',providerName:'Shared'},
    {model:'vendor/alpha',provider:'custom',name:'Alpha',providerName:'Shared'},
  ];
  let saves=0;
  const h=harness([
    status({dsh:{installed:false},modelDefaults:{available:true,selection:null,models}}),
    {available:true,selection:selected},{available:true,selection:null}
  ],{onModelSaved:()=>saves++});
  h.view.activate();await settle();
  const panel=h.host.querySelector('.dsh-default-model'),form=panel.querySelector('form');
  const model=form.querySelector('select');
  assert.equal(form.querySelectorAll('input').length,0);
  assert.equal(h.byText('保存默认模型').disabled,true);
  const groups=model.querySelectorAll('optgroup');
  assert.deepEqual(groups.map(group=>group.label),['Shared（custom）','Shared（other）']);
  assert.deepEqual(groups.map(group=>group.querySelectorAll('option').map(option=>option.textContent)),[['Fast','Alpha'],['Fast']]);
  model.value=groups[0].querySelector('option').value;model.dispatch('change');
  assert.equal(h.byText('保存默认模型').disabled,false);
  form.dispatch('submit');await settle();
  assert.deepEqual(h.calls[1],['/api/dsh/connection/saveModel',{selection:selected}]);
  assert.match(panel.textContent,/已保存/);assert.equal(saves,1);
  assert.equal(h.byText('保存默认模型').disabled,true);
  h.byText('恢复 DSH 默认值').click();await settle();
  assert.equal(model.value,'');assert.equal(model.querySelectorAll('option').length,4);
  assert.deepEqual(h.calls[2],['/api/dsh/connection/saveModel',{selection:null}]);
  assert.equal(h.byText('恢复 DSH 默认值').disabled,true);
});

test('a saved model outside the catalog stays visible and can be reset when loading the catalog fails',async()=>{
  const selection={model:'prior/model'};
  const h=harness([status({modelDefaults:{available:true,selection,models:[],catalogError:'无法读取目录'}}),{available:true,selection:null}]);
  h.view.activate();await settle();
  const panel=h.host.querySelector('.dsh-default-model'),model=panel.querySelector('select');
  assert.match(panel.textContent,/无法读取目录/);
  const groups=model.querySelectorAll('optgroup');
  assert.deepEqual(groups.map(group=>group.label),['当前目录外']);
  assert.match(groups[0].querySelector('option').textContent,/prior\/model · 默认提供商（已保存）/);
  assert.equal(groups[0].querySelector('option').value,model.value);
  assert.equal(h.byText('保存默认模型').disabled,true);
  h.byText('恢复 DSH 默认值').click();await settle();
  assert.deepEqual(h.calls[1],['/api/dsh/connection/saveModel',{selection:null}]);
});

test('refreshing enabled sources replaces the model options from the refreshed setting status', async()=>{
  const row={model:'added/model',provider:'custom',name:'Added',providerName:'Custom'};
  const h=harness([status({modelDefaults:{available:true,selection:null,models:[]}}),{available:true,selection:null,models:[row]}]);
  h.view.activate();await settle();
  assert.equal(h.host.querySelector('.dsh-default-model').querySelector('select').disabled,true);
  h.view.refreshModels();await settle();
  assert.deepEqual(h.calls[1],['/api/dsh/connection/modelStatus',{}]);
  const select=h.host.querySelector('.dsh-default-model').querySelector('select');
  assert.equal(select.disabled,false);
  const group=select.querySelector('optgroup');
  assert.equal(group.label,'Custom');
  assert.equal(group.querySelector('option').textContent,'Added');
});

test('source refresh waits for an in-flight default model save and preserves the saved selection',async()=>{
  const selected={model:'first',provider:'custom'};
  let finishSave;
  const pending=new Promise(resolve=>{finishSave=resolve;});
  const h=harness([
    status({modelDefaults:{available:true,selection:null,models:[{...selected,name:'First',providerName:'Custom'}]}}),
    pending,
    {available:true,selection:null,models:[{model:'new',provider:'other',name:'New',providerName:'Other'}]},
  ]);
  h.view.activate();await settle();
  const form=h.host.querySelector('.dsh-default-model').querySelector('form');
  const select=form.querySelector('select');
  select.value=select.querySelector('optgroup').querySelector('option').value;form.dispatch('submit');
  h.view.refreshModels();
  assert.equal(h.paths().length,2);
  finishSave({available:true,selection:selected});await settle();
  assert.equal(h.paths().at(-1),'/api/dsh/connection/modelStatus');
  const refreshed=h.host.querySelector('.dsh-default-model').querySelector('select');
  assert.equal(refreshed.value,select.value);
  const groups=refreshed.querySelectorAll('optgroup');
  assert.deepEqual(groups.map(group=>group.label),['Other','当前目录外']);
  assert.equal(groups[0].querySelector('option').textContent,'New');
  assert.match(groups[1].querySelector('option').textContent,/first · custom（已保存）/);
});

test('one click runs plan then connect once; registered and queued are not shown as connected', async () => {
  const h = harness([status(), { planId: 'p1', serverName: 'dsh_subagent', scope: 'user', preservesExisting: true, dsh: { executablePath: 'x' } },
    { registered: true, registration: { state: 'bundled', serverName: 'dsh_subagent' }, reload: { queued: true, error: null }, runtime: { state: null }, warning: null },
    bundled(null), bundled('starting'), bundled('starting')]);
  h.view.activate(); await settle();
  assert.match(h.host.textContent, /未连接/); assert.match(h.host.textContent, /mcp_servers\.dsh_subagent/);
  h.byText('连接 DSH').click(); h.byText('正在连接…')?.click(); await settle();
  assert.deepEqual(h.paths().slice(0, 3), ['/api/dsh/connection/status', '/api/dsh/connection/plan', '/api/dsh/connection/connect']);
  assert.equal(h.paths().filter(p => p.endsWith('/connect')).length, 1, 'a double click never connects twice');
  assert.deepEqual(h.calls[2][1], { planId: 'p1', confirmed: true });
  const text = h.host.textContent;
  assert.match(text, /已注册，尚未确认连接/); assert.match(text, /已排队（不等于已连接）/); assert.match(text, /正在启动/);
  assert.doesNotMatch(text, /随包桥已在 Codex 中注册并连接/);
  assert.equal(h.paths().filter(p => p.endsWith('/status')).length, 4, 'runtime status is re-read a bounded number of times');
  assert.equal(h.changes(), 1);
});

test('the runtime connected state comes only from status', () => {
  assert.equal(describeConnection(bundled('connected')).label, '已连接');
  assert.equal(describeConnection(bundled(null), { reload: { queued: true } }).label, '已注册，尚未确认连接');
  assert.match(describeConnection(bundled(null), { reload: { queued: false, error: { message: 'old' } } }).detail, /重新打开会话/);
  assert.equal(describeConnection(bundled('failed')).tone, 'fail');
});

test('version facts distinguish bundled, loaded, legacy and external bridges',async()=>{
  const available={available:true,version:'0.8.0-light.3',dependenciesReady:true};
  for(const [registration,runtime,expected] of [
    ['bundled',{loadedVersion:'0.8.0-light.2'},/已加载的桥版本0\.8\.0-light\.2.*待当前任务结束后重启/],
    ['bundled',{reportedVersion:available.version},/已加载的桥版本未确认/],
    ['bundled',{},/已加载的桥版本当前 Codex 未提供版本/],
    ['external',{reportedVersion:'custom.1'},/外部桥报告的版本custom\.1/],
  ]){
    const h=harness([status({bundled:available,registration:{state:registration},runtime:{state:'connected',...runtime}})]);
    h.view.activate();await settle();
    assert.match(h.host.textContent,expected);
    assert.match(h.host.textContent,/随包桥0\.8\.0-light\.3/);
    h.view.deactivate();
  }
});

test('an existing external MCP is kept; no connect or replace action is offered', async () => {
  const h = harness([status({ registration: { state: 'external', serverName: 'dsh_subagent' }, runtime: { state: 'connected' }, canConnect: false })]);
  h.view.activate(); await settle();
  assert.match(h.host.textContent, /使用已有配置/); assert.match(h.host.textContent, /已保留/);
  assert.equal(h.byText('连接 DSH'), undefined);
  assert.doesNotMatch(h.host.textContent, /替换|覆盖已有/);
});

test('missing DSH is optional: path input is required and sent only when DSH was not detected', async () => {
  const h = harness([status({ dsh: { installed: false, executablePath: null } }), fail('INVALID_EXECUTABLE', '不是 DSH 本体', 'notExecuted'), status({ dsh: { installed: false, executablePath: null } })]);
  h.view.activate(); await settle();
  assert.match(h.host.textContent, /不影响普通聊天/);
  assert.equal(h.byText('连接 DSH').disabled, true);
  const input = h.host.querySelectorAll('input')[0]; input.value = 'D:/DSH/DeepSeek Harness.exe'; input.dispatch('input');
  assert.equal(h.byText('连接 DSH').disabled, false);
  h.byText('连接 DSH').click(); await settle();
  assert.deepEqual(h.calls[1], ['/api/dsh/connection/plan', { executablePath: 'D:/DSH/DeepSeek Harness.exe' }]);
  assert.equal(h.paths().includes('/api/dsh/connection/connect'), false, 'a failed plan never continues to connect or retries');
  assert.match(h.host.textContent, /不是 DSH 本体/);
});

test('plan conflict for an existing config is stated without retry', async () => {
  const h = harness([status(), fail('MCP_ALREADY_CONFIGURED', '已存在 DSH MCP 配置，已保留，不会覆盖'), status({ registration: { state: 'external', serverName: 'dsh_subagent' }, canConnect: false })]);
  h.view.activate(); await settle(); h.byText('连接 DSH').click(); await settle();
  assert.deepEqual(h.paths(), ['/api/dsh/connection/status', '/api/dsh/connection/plan', '/api/dsh/connection/status']);
  assert.match(h.host.textContent, /现有配置可继续使用/);
});

test('an unknown connect outcome is reported as unknown and never resent', async () => {
  const h = harness([status(), { planId: 'p2' }, fail('CONNECTION_OUTCOME_UNKNOWN', '配置写入结果需核对', 'unknown'), status()]);
  h.view.activate(); await settle(); h.byText('连接 DSH').click(); await settle();
  assert.equal(h.paths().filter(p => p.endsWith('/connect')).length, 1);
  assert.match(h.host.textContent, /连接结果未知/); assert.match(h.host.textContent, /不会自动重发/);
});

test('unavailable bundle or config limits only this feature', () => {
  assert.equal(describeConnection(status({ bundled: { available: false, dependenciesReady: false } })).action, null);
  assert.match(describeConnection(status({ error: { code: 'CODEX_CONFIG_UNAVAILABLE', message: '无法读取 Codex MCP 配置' } })).detail, /普通聊天不受影响/);
  assert.equal(describeConnection(status({ canConnect: false })).action, null);
});

test('the entry is local-only markup next to config sources', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<div id="dsh-connection-root" class="local-only"><\/div>\s*<div id="dsh-config-root"/);
});

test('WSL requires an explicit mode, status and plan bind it, connect carries only the confirmed plan',async()=>{
 const h=harness([{selectionRequired:true,canConnect:false},status(),{planId:'wsl-plan'}, {registered:true,reload:{queued:true}},bundled('connected')],{runtimeTarget:()=> 'wsl'});
 h.view.activate();await settle();assert.equal(h.byText('连接 DSH'),undefined);
 const picker=h.host.querySelectorAll('select')[0];picker.value='windows';picker.dispatch('change');await settle();
 assert.deepEqual(h.calls[1],['/api/dsh/connection/status',{mode:'windows'}]);
 assert.match(h.host.textContent,/Linux \/home.*不可用/);assert.match(h.host.textContent,/Windows 盘项目/);
 h.byText('连接 DSH').click();await settle();
 assert.deepEqual(h.calls[2],['/api/dsh/connection/plan',{mode:'windows'}]);
 assert.deepEqual(h.calls[3],['/api/dsh/connection/connect',{planId:'wsl-plan',confirmed:true}]);
});

test('native WSL mode uses Linux path and resets stale path and status on mode change',async()=>{
 const missing=status({dsh:{installed:false}});
 const h=harness([{selectionRequired:true},missing,missing],{runtimeTarget:()=> 'wsl'});
 h.view.activate();await settle();let picker=h.host.querySelectorAll('select')[0];picker.value='native-wsl';picker.dispatch('change');await settle();
 const input=h.host.querySelectorAll('input')[0];assert.match(input.placeholder,/^\/home/);input.value='/home/lee/dsh';input.dispatch('input');
 picker=h.host.querySelectorAll('select')[0];picker.value='windows';picker.dispatch('change');await settle();
 assert.equal(h.host.querySelectorAll('input')[0].value,'');assert.equal(h.byText('连接 DSH').disabled,true);
});

test('mode status read failure cannot retain a prior connect action',async()=>{
 const h=harness([{selectionRequired:true},status(),new Error('读取失败')],{runtimeTarget:()=> 'wsl'});
 h.view.activate();await settle();let picker=h.host.querySelectorAll('select')[0];picker.value='native-wsl';picker.dispatch('change');await settle();
 picker=h.host.querySelectorAll('select')[0];picker.value='windows';picker.dispatch('change');await settle();
 assert.equal(h.byText('连接 DSH'),undefined);assert.match(h.host.textContent,/读取失败/);
});

test('native diagnostic is text, not an installation claim; top-level completion capabilities are visible',async()=>{
 const h=harness([status({dsh:{installed:false,diagnostic:{code:'PROVIDER_REQUIRED',message:'未配置默认供应商 <script>bad</script>'}},capabilities:{completionMode:'dsh_wait',automaticWakeup:false}})],{runtimeTarget:()=> 'wsl'});
 h.view.activate();await settle();
 assert.match(h.host.textContent,/未配置默认供应商/);assert.match(h.host.textContent,/自动检测未就绪/);
 assert.doesNotMatch(h.host.textContent,/未检测到 DSH 本体/);assert.match(h.host.textContent,/dsh_wait/);assert.match(h.host.textContent,/不支持完成后自动唤醒/);
 assert.equal(h.host.querySelectorAll('script').length,0);assert.equal(h.host.querySelectorAll('input').length,1);
});

test('callback state reports account pause and error rather than treating capability as delivery',async()=>{
 const h=harness([status({capabilities:{automaticWakeup:true},callbackStatus:{automaticWakeup:true,accountVerified:false,pendingBindings:2,error:null}})]);
 h.view.activate();await settle();assert.match(h.host.textContent,/尚未核对当前账户/);assert.doesNotMatch(h.host.textContent,/当前账户已核对/);
 assert.match(describeCallbackStatus({automaticWakeup:true,accountVerified:true,error:{message:'<script>bad</script>'}}),/自动唤醒暂停/);
 assert.match(describeCallbackStatus({automaticWakeup:true,accountVerified:true,pendingBindings:2}),/待处理绑定 2 个/);
 assert.match(describeCallbackStatus({automaticWakeup:true,accountVerified:true,pendingBindings:0}),/以实际结果为准/);
 assert.match(describeCallbackStatus({automaticWakeup:false,accountVerified:true}),/未启用/);
});

test('callback error is rendered as bounded text',async()=>{
 const h=harness([status({callbackStatus:{automaticWakeup:true,accountVerified:true,error:'<script>bad</script>'}})]);
 h.view.activate();await settle();assert.match(h.host.textContent,/自动唤醒暂停：<script>bad<\/script>/);assert.equal(h.host.querySelectorAll('script').length,0);
});
