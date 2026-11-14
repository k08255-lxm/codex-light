import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
// Static visual contract (tokens, type scale, motion, layout) plus the model catalog loader extracted from app.js.
// Appearance *behaviour* (theme/style persistence, native sync) is exercised in preferences.test.mjs.
const read=path=>readFile(new URL('../public/'+path,import.meta.url),'utf8');
const [css,html,app,plugins]=await Promise.all(['style.css','index.html','app.js','plugins.css'].map(read));
const block=selector=>{const start=css.indexOf(selector);assert.ok(start>=0,`missing ${selector}`);const open=css.indexOf('{',start),close=css.indexOf('}',open);assert.ok(open>start&&close>open,`malformed ${selector}`);return css.slice(open+1,close);};
const rule=(selector,...patterns)=>{for(const pattern of patterns)assert.match(css,new RegExp(selector+'\\s*\\{[^}]*'+pattern,'s'),`${selector} ${pattern}`);};

test('all four codex/claude light/dark token sets use the fixed palette',()=>{
 const sets=[[':root {',['#181818','#202020','#1b1b1b','#252525','#2b2b2b','#333333','#ececec','#b8b8b8','#a2a2a2','#e8e8e8'],'#202020'],[':root[data-visual-style="claude"]',['#262624','#2d2c29','#232320','#32312d','#383730','#403c32','#eceae2','#c2beb1','#aaa597','#d99b79'],'#252420'],[':root[data-theme="light"]',['#ffffff','#f7f7f7','#f2f2f2','#f5f5f5','#e9e9e9','#202020','#525252','#6b6b6b','#282828'],'#ffffff'],[':root[data-theme="light"][data-visual-style="claude"]',['#faf9f5','#f0eee6','#e9e6dc','#f4f2eb','#ffffff','#e7e3d7','#30302b','#5c5a51','#716e62','#a24c31'],'#ffffff']];
 for(const [selector,values,contrast] of sets){const source=block(selector);for(const value of values)assert.ok(source.includes(value),`${value} missing from ${selector}`);assert.ok(source.includes(`--accent-contrast:${contrast}`),selector);}
 assert.match(css,/--canvas:#ffffff; --sidebar:#f7f7f7/);
});

test('frame, typography and geometry follow the fixed scale with a Chinese font fallback',()=>{
 for(const token of ['--rail-width:\\s*52px','--sidebar-width:\\s*272px','--content-width:\\s*760px','--topbar-height:\\s*48px','--sidebar-row-height:\\s*34px','--radius-control:6px; --radius-row:7px; --radius-card:10px; --radius-composer:16px'])assert.match(css,new RegExp(token));
 assert.match(css,/"Segoe UI Variable Text", "Noto Sans SC", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Noto Sans CJK SC"/);assert.doesNotMatch(css,/font-synthesis:\s*none/);
 rule('body','font-size:\\s*\\.9375rem[^}]*line-height:\\s*1\\.65[^}]*letter-spacing:\\s*0');
 rule('button,\\s*input[^{}]*','font-size:\\s*\\.875rem[^}]*line-height:\\s*1\\.5[^}]*letter-spacing:\\s*0');
 rule('\\.settings-content h1,[^{}]*','font-size:\\s*1\\.375rem[^}]*line-height:\\s*1\\.3[^}]*font-weight:\\s*600');
 rule('\\.composer-foot','font-size:\\s*\\.75rem');rule('\\.foot-btn','height:\\s*26px');rule('\\.thread','height:\\s*var\\(--sidebar-row-height\\)[^}]*border-radius:\\s*var\\(--radius-row\\)');
 for(const match of css.matchAll(/font-size:\s*([\d.]+)rem/g))assert.ok(Number(match[1])>=.75,`text size below 12px: ${match[1]}rem`);
 for(const source of [css,plugins])assert.doesNotMatch(source,/letter-spacing:\s*-\.0125em/);
 // Font scale changes the root size; zoom would break layout measurement.
 assert.match(css,/data-font-scale="125"\] \{ font-size: 125%/);assert.doesNotMatch(css,/\bzoom\s*:/);
});

test('success notices are neutral while error, approval and primary semantics stay distinct',()=>{
 const notice=block('.notice {');assert.match(notice,/color:\s*var\(--secondary\)/);assert.match(notice,/background:\s*var\(--notice-bg\)/);assert.doesNotMatch(notice,/#(?:dbc9a0|2b261d|6a5537)/i);
 rule('\\.notice\\.error','color:\\s*var\\(--error\\)[^}]*background:\\s*var\\(--error-bg\\)');
 const approval=block('.approval, .pending-card {');assert.match(approval,/background:\s*var\(--warning-bg\)/);assert.match(approval,/border:\s*1px solid var\(--warning-border\)/);
 for(const selector of ['\\.primary, \\.accept','\\.send'])rule(selector,'background:\\s*var\\(--accent\\)[^}]*color:\\s*var\\(--accent-contrast\\)');
});

test('low-frequency settings motion is scoped; conversation scrolling remains immediate',()=>{
 // The owner explicitly requested visible settings/disclosure motion. Do not
 // restore the old global scale/slide ban or permit it on conversation content.
 assert.doesNotMatch(css,/--motion-press|transition:\s*all|@keyframes\s+fade-in|animation:\s*fade-in|menu-enter|panel-enter|page-enter/);
 const approved=new Map([
  [':root :is(#settings-general,#settings-storage,#settings-about,#settings-appearance):not(.hidden)',/transform:\s*translateY\(4px\)/],
  [':root .update-indicator:active:not(:focus-visible) .update-indicator-badge',/transform:\s*scale\(\.96\)/],
  [':root .sidebar',/transform:\s*translateX\(-8px\)/],
  ['.update-indicator:not([hidden])',/transform:\s*translateY\(-3px\)/],
 ]);
 const seen=new Set();
 for(const [,raw,body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)){
  if(!/(?:scale|translate[XY])\(/.test(body))continue;
  const selector=raw.replace(/\/\*[\s\S]*?\*\//g,'').trim();
  assert.ok(approved.has(selector),`unapproved spatial motion: ${selector}`);
  assert.match(body,approved.get(selector));seen.add(selector);
  assert.doesNotMatch(selector,/[.#](?:thread|message|timeline|feed|turn|conversation)(?:[-\s.#:[>]|$)/);
 }
 assert.equal(seen.size,approved.size,'all approved low-frequency motion remains present');
 assert.match(css,/button:not\(:disabled\):active\s*\{\s*background-color:\s*var\(--selected\)/);
 rule('button','transition:\\s*none');assert.match(css,/\.thread[^{}]*\{[^}]*transition:\s*none/);
 assert.match(css,/@media\s*\(prefers-reduced-motion:reduce\)/);assert.match(css,/animation:\s*none\s*!important/);
 assert.match(css,/data-reduced-motion="true"[^}]*transition:\s*none\s*!important/s);
});

test('model popover is width-capped with natural height and its own contained scroll',()=>{
 const base=block('.reasoning-popover {');assert.match(base,/width:\s*min\(256px,\s*calc\(100vw - 24px\)\)/);assert.match(base,/max-width:\s*256px/);assert.doesNotMatch(base,/(?:^|;)\s*height:\s*\d|min-height/);
 const open=block('.reasoning-popover.models-open');for(const pattern of [/height:\s*auto/,/max-height:\s*min\(310px/,/overflow-y:\s*auto/,/overscroll-behavior:\s*contain/])assert.match(open,pattern);
 rule('\\.model-list-head strong','white-space:\\s*nowrap');rule('\\.model-list-head button','flex:\\s*0 0 24px[^}]*width:\\s*24px');rule('#model-options button','width:\\s*100%');
 assert.doesNotMatch(css,/\.reasoning-model-list button\s*\{/);assert.match(html,/<strong>选择模型<\/strong>/);
});

test('PR surface wraps filters, keeps entries focusable and scrolls patches independently',()=>{
 const start=css.indexOf('/* Read-only GitHub PR'),end=css.indexOf('.reasoning-track.unknown',start);const pr=css.slice(start,end);assert.ok(start>=0&&pr.length>0,'PR styles missing');
 assert.doesNotMatch(pr,/#[0-9a-f]{3,8}\b/i,'PR styles use theme tokens only');
 assert.match(css,/\.review-workspace\s*>\s*\*\s*\{[^}]*width:\s*min\(100%,\s*var\(--content-width\)\)/s);
 for(const pattern of [/\.pr-review-toolbar\s*\{[^}]*flex-wrap:\s*wrap/s,/\.pr-review-toolbar>label[^{}]*\{[^}]*min-width:\s*0/s,/\.pr-review-card:focus-within/,/@media\s*\(hover:hover\)[\s\S]*?\.pr-review-card:hover/,/\.pr-review-card>button\s*\{[^}]*overflow-wrap:\s*anywhere/s,/\.pr-review-patch\s*\{[^}]*white-space:\s*pre[^}]*overflow-x:\s*auto/s,/\.pr-review-list>p,\s*\.pr-review-section>p\s*\{[^}]*border:\s*1px dashed/s,/@media\s*\(forced-colors:\s*active\)/])assert.match(pr,pattern);
});

test('static shell: two pressed-state style choices, hidden text menus with one named entry, CLI version slot',()=>{
 assert.deepEqual([...html.matchAll(/data-style-choice="([^"]+)" aria-pressed="(true|false)"/g)].map(match=>[match[1],match[2]]),[['codex','true'],['claude','false']]);
 assert.match(html,/class="style-cards" role="group" aria-label="界面风格"/);
 assert.match(html,/class="window-bar hidden" aria-hidden="true"/);assert.match(css,/\.window-bar\s*\{\s*display:\s*none/);assert.match(html,/id="menu-app"[^>]*aria-label="应用菜单"/);
 assert.match(html,/<dt>CLI 版本<\/dt><dd id="version-info">未知<\/dd>/);assert.match(app,/\$\('version-info'\)\.textContent=state\.cliVersion\|\|'未知'/);
 assert.doesNotMatch(app,/updateManifest|upgradeRuntime|运行时升级/);
});

test('model labels are normalized for display only',()=>{
 const start=app.indexOf('function formatModelDisplayName'),end=app.indexOf('function effectiveModel',start);assert.ok(start>=0&&end>start);
 const format=new Function(`${app.slice(start,end)};return formatModelDisplayName;`)();
 assert.equal(format('GPT-6-Astra'),'GPT-6 Astra');assert.equal(format('GPT-6.1-Sol'),'GPT-6.1 Sol');assert.equal(format('Acme-Private-Model'),'Acme-Private-Model');assert.equal(format('Claude Sonnet'),'Claude Sonnet');
});

test('model catalog loading is bounded, generation-safe and preserves the last good catalog',async()=>{
 const start=app.indexOf('// model-loader:start'),end=app.indexOf('// model-loader:end',start);assert.ok(start>=0&&end>start);const loadSource=app.slice(app.indexOf('\n',start)+1,end);
 class Option{constructor(text,value){this.text=text;this.value=value;}}
 const select={value:'m-old',options:[],replaceChildren(...nodes){this.options=nodes;},append(node){this.options.push(node);}};
 const state={modelGeneration:0,models:[{model:'seed'}]};let calls=[];let rpc;let effortRenders=0;
 const loadModels=new Function('state','rpc','$','Option','populateEfforts','formatModelDisplayName',`${loadSource};return loadModels;`)(state,(...args)=>{calls.push(args);return rpc(...args);},()=>select,Option,()=>{effortRenders++;},value=>value.replace(/^GPT-(\d+(?:\.\d+)?)-([A-Za-z][A-Za-z0-9]*(?:[-.][A-Za-z0-9]+)*)/,'GPT-$1 $2'));
 rpc=async()=>({data:[{model:'m-one',displayName:'One'},{model:'m-two',displayName:'GPT-6.1-Sol'}],nextCursor:null});
 await loadModels();assert.equal(calls.length,1);assert.deepEqual(state.models.map(m=>m.model),['m-one','m-two']);assert.equal(select.value,'m-old');assert.ok(select.options.some(option=>option.text==='GPT-6.1 Sol'&&option.value==='m-two'));assert.ok(select.options.some(option=>option.text==='m-old（目录外）'));assert.equal(effortRenders,1);
 let firstResolve;let generationCalls=0;calls=[];rpc=async()=>{generationCalls++;if(generationCalls===1)return new Promise(resolve=>{firstResolve=resolve;});return {data:[{model:'new',displayName:'New'}],nextCursor:null};};
 const first=loadModels();const second=loadModels();firstResolve({data:[{model:'old',displayName:'Old'}],nextCursor:null});await Promise.all([first,second]);assert.deepEqual(state.models.map(m=>m.model),['new']);
 const seeded=[{model:'seed'}];state.models=seeded;let page=0;rpc=async()=>({data:[{model:'m'+page}],nextCursor:'same'});await assert.rejects(()=>loadModels(),/分页游标未前进/);assert.equal(state.models,seeded);
 page=0;rpc=async()=>({data:[{model:'p'+page++}],nextCursor:'cursor-'+page});await assert.rejects(()=>loadModels(),/超过 5 页/);assert.equal(state.models,seeded);
 rpc=async()=>({data:Array.from({length:501},(_,i)=>({model:'bulk-'+i})),nextCursor:null});await assert.rejects(()=>loadModels(),/超过 500 项/);assert.equal(state.models,seeded);
});
