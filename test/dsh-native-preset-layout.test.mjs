import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {runtimeConfig} from '../components/dsh-bridge/src/config.mjs';
import {resolvePresetLayout} from '../components/dsh-bridge/src/preset-layout.mjs';
import {nativeProbe} from '../components/dsh-bridge/src/wsl-native-helper.mjs';

const legacy='dsh-agent-presets';
const split=['dsh-agent-preset','dsh-agent-preset-registry'];
const required=['dsh-base','dsh-sdk-app','dsh-sdk-jsonrpc-server','dsh-workspace','dsh-tool-subagent/model-selection-settings'];
function fixture(t,modules){
 const home=mkdtempSync(join(tmpdir(),'codecang-dsh-preset-'));
 t.after(()=>rmSync(home,{recursive:true,force:true}));
 const packageRoot=join(home,'node_modules','@deepseek-ai','dsh'), cli=join(packageRoot,'bin','dsh.mjs');
 mkdirSync(dirname(cli),{recursive:true});writeFileSync(cli,'');
 writeFileSync(join(packageRoot,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh',version:'0.2.2-rc.5',bin:{dsh:'bin/dsh.mjs'}}));
 for(const module of modules){
  const target=join(home,'node_modules','@deepseek-ai',...module.split('/'));
  mkdirSync(target,{recursive:true});writeFileSync(join(target,'index.js'),'');
 }
 return {home,cli};
}
test('legacy CLI retains original preset and old-session compositions', t=>{
 const {home,cli}=fixture(t,[legacy]);
 const {patch,legacyPatch}=runtimeConfig(join(home,'state'),cli);
 assert.equal(resolvePresetLayout(cli),'legacy');
 assert.match(readFileSync(patch,'utf8'),/id: tool-bash\n  disabled: true/);
 assert.doesNotMatch(readFileSync(legacyPatch,'utf8'),/id: tool-bash/);
 for(const file of [patch,legacyPatch]) {
  assert.match(readFileSync(file,'utf8'),/name: '@deepseek-ai\/dsh-agent-presets'/);
  assert.doesNotMatch(readFileSync(file,'utf8'),/dsh-agent-preset-registry/);
 }
});
test('split CLI mounts preset declarations even when the legacy package also exists', t=>{
 const {home,cli}=fixture(t,[...split,legacy]);
 const {patch,legacyPatch}=runtimeConfig(join(home,'state'),cli);
 assert.equal(resolvePresetLayout(cli),'split');
 for(const file of [patch,legacyPatch]) {
  const yaml=readFileSync(file,'utf8');
  assert.match(yaml,/name: '@deepseek-ai\/dsh-agent-preset-registry'/);
  assert.match(yaml,/id: preset-standard/);
  assert.match(yaml,/id: preset-minimal/);
  assert.doesNotMatch(yaml,/name: '@deepseek-ai\/dsh-agent-presets'/);
  assert.equal(yaml.match(/id: agent-preset-registry/g).length,1);
 }
});
test('incomplete split layout falls back only to a complete legacy installation', t=>{
 const mixed=fixture(t,[legacy,split[0]]);
 assert.equal(resolvePresetLayout(mixed.cli),'legacy');
 const partial=fixture(t,[split[1]]);
 assert.throws(()=>resolvePresetLayout(partial.cli),{code:'DSH_PRESETS_UNAVAILABLE'});
});
test('WSL native helper accepts split CLI and diagnoses incomplete install', {skip:process.platform!=='linux'}, t=>{
 for(const layout of [split,[legacy],[split[0]]]){
  const {home,cli}=fixture(t,[...required,...layout]);
  const options={home,cli,env:{DEEPSEEK_API_KEY:'mock-only'}};
  if(layout.length===1&&layout[0]===split[0]) assert.throws(()=>nativeProbe(options),{code:'DSH_PRESETS_UNAVAILABLE'});
  else assert.equal(nativeProbe(options).version,'0.2.2-rc.5');
 }
});
test('Desktop continues to use the existing overlay independently of CLI package checks',t=>{
 const {home,cli}=fixture(t,[]);
 const previous=process.env.DSH_DESKTOP_EXECUTABLE;
 process.env.DSH_DESKTOP_EXECUTABLE=cli;
 t.after(()=>{if(previous===undefined)delete process.env.DSH_DESKTOP_EXECUTABLE;else process.env.DSH_DESKTOP_EXECUTABLE=previous;});
 const {patch,legacyPatch}=runtimeConfig(join(home,'state'),cli);
 assert.match(readFileSync(patch,'utf8'),/name: '@deepseek-ai\/dsh-agent-preset-registry'/);
 assert.equal(readFileSync(patch,'utf8'),readFileSync(legacyPatch,'utf8'));
});
