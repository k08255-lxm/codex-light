import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mountWslRuntimePanel,runtimeTargetLabel} from '../public/wsl-runtime-panel.js';
class El {
 constructor(tag,ownerDocument){Object.assign(this,{tag,ownerDocument,children:[],listeners:{},attributes:{},textContent:'',value:''});}
 append(...nodes){this.children.push(...nodes);}
 replaceChildren(...nodes){this.children=nodes;}
 setAttribute(k,v){this.attributes[k]=v;}
 addEventListener(k,v){this.listeners[k]=v;}
 set innerHTML(_){throw Error('No HTML interpolation');}
}
const all=n=>[n,...n.children.flatMap(all)];
const text=n=>all(n).map(x=>x.textContent).join(' ');
const button=(n,t)=>all(n).find(x=>x.tag==='button'&&x.textContent===t);
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
const native={target:'native'},wsl={target:'wsl',distribution:'Ubuntu',user:'lee'};
const data=()=>({supported:true,canSelect:true,current:native,selected:native,restartRequired:false,limitations:[]});
function setup(overrides={}){
 const doc={createElement:tag=>new El(tag,doc)},host=new El('div',doc),calls=[];
 const panel=mountWslRuntimePanel(host,{read:async()=>{calls.push('read');return data();},discover:async()=>{calls.push('discover');return {...data(),candidates:[{distribution:'Ubuntu',user:'lee',available:true,codexPath:'/bin/codex',codexHome:'/home/lee/.codex'}]};},select:async target=>{calls.push(target);return {...data(),selected:target,restartRequired:true};},...overrides});
 return {host,panel,calls};
}
const click=(x,t)=>button(x.host,t).listeners.click();
const choose=x=>{const select=all(x.host).find(x=>x.tag==='select');select.value=select.children[1].value;select.listeners.change();};
test('runtime values and expandable compatibility notes have separate hierarchy',async()=>{
 const notes=['WSL Git 说明','DSH 环境说明'];
 const x=setup({read:async()=>({...data(),limitations:notes})});
 x.panel.setActive(true);await flush();
 const nodes=all(x.host);
 assert.deepEqual(nodes.filter(node=>node.tag==='dt').map(node=>node.textContent),['当前运行','下次启动']);
 const details=nodes.find(node=>node.tag==='details');
 assert.equal(details.hidden,false);assert.ok(!details.open);
 assert.deepEqual(all(details).filter(node=>node.tag==='li').map(node=>node.textContent),notes);
 assert.equal(nodes.find(node=>node.tag==='label'&&node.textContent==='Linux Codex 路径（可选）').hidden,true);
});
test('entry only reads; explicit discover never saves; save separates current and next launch',async()=>{
 const x=setup();assert.deepEqual(x.calls,[]);x.panel.setActive(true);await flush();assert.deepEqual(x.calls,['read']);
 await click(x,'发现 WSL 中的 Codex');choose(x);assert.equal(button(x.host,'保存环境').disabled,false);assert.equal(x.calls.length,2);
 await click(x,'保存环境');assert.deepEqual(x.calls[2],wsl);assert.match(text(x.host),/Windows 本机/);assert.match(text(x.host),/重启后生效/);assert.match(text(x.host),/Ubuntu/);
});
test('LAN never reads or offers mutation',async()=>{
 const x=setup({isLocal:()=>false});x.panel.setActive(true);await flush();await click(x,'发现 WSL 中的 Codex');assert.deepEqual(x.calls,[]);assert.equal(x.host.children[0].hidden,true);
});
test('save failure disables resubmission until explicit status reconciliation',async()=>{
 const x=setup({select:async()=>{throw Error('timeout');}});x.panel.setActive(true);await flush();await click(x,'发现 WSL 中的 Codex');choose(x);await click(x,'保存环境');assert.match(text(x.host),/保存结果未确认/);assert.equal(button(x.host,'保存环境').disabled,true);await click(x,'刷新状态');assert.equal(button(x.host,'发现 WSL 中的 Codex').disabled,false);
});
test('deactivated stale discovery cannot replace refreshed state',async()=>{
 let resolve;const x=setup({discover:()=>new Promise(r=>resolve=r)});x.panel.setActive(true);await flush();const pending=click(x,'发现 WSL 中的 Codex');x.panel.setActive(false);x.panel.setActive(true);await flush();resolve({...data(),selected:wsl,candidates:[]});await pending;assert.doesNotMatch(text(x.host),/Ubuntu/);
});
test('unavailable distributions require explicit absolute path',async()=>{
 const x=setup({discover:async()=>({...data(),candidates:[{distribution:'Debian',available:false,diagnostic:'未安装 Codex'}]})});x.panel.setActive(true);await flush();await click(x,'发现 WSL 中的 Codex');assert.match(text(x.host),/未安装 Codex/);assert.equal(all(x.host).find(x=>x.tag==='select').children.length,2);choose(x);assert.equal(button(x.host,'保存环境').disabled,true);const path=all(x.host).find(x=>x.tag==='input');path.value='/opt/codex/bin/codex';path.listeners.input();assert.equal(button(x.host,'保存环境').disabled,false);await click(x,'保存环境');assert.equal(x.calls.at(-1).codexPath,'/opt/codex/bin/codex');
});
test('repeat saves while pending send once; navigation re-reads outcome without replay',async()=>{
 let resolve,count=0;const x=setup({select:()=>{count++;return new Promise(r=>resolve=r);}});x.panel.setActive(true);await flush();await click(x,'发现 WSL 中的 Codex');choose(x);const pending=click(x,'保存环境');await click(x,'保存环境');assert.equal(count,1);x.panel.setActive(false);x.panel.setActive(true);resolve({...data(),selected:wsl});await pending;await flush();assert.equal(count,1);assert.equal(x.calls.at(-1),'read');
});
test('labels show distribution and independent user',()=>{assert.equal(runtimeTargetLabel(wsl),'WSL · Ubuntu · lee');});
test('manual discovery may resolve the default user without claiming save failed',async()=>{
 const x=setup({discover:async()=>({...data(),candidates:[{distribution:'Ubuntu',available:false,diagnostic:'需要指定路径'}]}),select:async target=>({...data(),selected:{...target,user:'lee'},restartRequired:true})});
 x.panel.setActive(true);await flush();await click(x,'发现 WSL 中的 Codex');choose(x);
 const path=all(x.host).find(x=>x.tag==='input');path.value='/opt/codex';path.listeners.input();await click(x,'保存环境');
 assert.doesNotMatch(text(x.host),/保存结果未确认/);assert.match(text(x.host),/已保存/);
});
test('integration uses desktop-local access and hides unsupported Windows operations',()=>{
 const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 assert.match(app,/isLocal:\(\)=>!state\.lan&&state\.desktop===true/);
 assert.match(app,/state\.runtimeTarget=status\.runtimeTarget==='wsl'\?'wsl':'native';applyRuntimeTarget\(\)/);
 assert.match(app,/if\(state\.runtimeTarget!=='wsl'\)dshConfigView\.activate\(\)/);
 assert.match(app,/function runtimePanelShouldBeActive\(\)\{return state\.runtimeTarget!=='wsl'/);
 assert.match(app,/host\.inert=wsl/);
});
