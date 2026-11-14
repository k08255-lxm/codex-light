import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BundledDshBridge} from '../src/dsh-connection.mjs';
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-readiness-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const write=(name,value)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);};write('manifest.json',JSON.stringify({component:'codex-light-dsh-bridge',entry:'src/light-entry.mjs',version:'fixture'}));write('src/light-entry.mjs','// fixture');write('package.json','{}');return {root,write,bridge:new BundledDshBridge({componentRoot:root})};}
function deps(f){for(const name of ['@modelcontextprotocol/sdk','ws','zod','yaml']){f.write(`node_modules/${name}/package.json`,JSON.stringify({name,main:'index.js'}));f.write(`node_modules/${name}/index.js`,'throw Error("must not execute");');}f.write('node_modules/@modelcontextprotocol/sdk/server/mcp.js','throw Error("must not execute");');}
test('development needs real module entry files, not package.json placeholders',t=>{const f=fixture(t);for(const name of ['@modelcontextprotocol/sdk','ws','zod','yaml'])f.write(`node_modules/${name}/package.json`,'{}');assert.equal(f.bridge.bundled().dependenciesReady,false);});
test('complete development dependencies resolve without executing modules',t=>{const f=fixture(t);deps(f);assert.deepEqual(f.bridge.bundled(),{available:true,version:'fixture',dependenciesReady:true});});
test('bundle marker is fail closed even when development dependencies are complete',t=>{const f=fixture(t);deps(f);for(const format of ['codex-light-dsh-bundle-v1','unknown',null]){f.write('manifest.json',JSON.stringify({format,component:'codex-light-dsh-bridge',entry:'src/light-entry.mjs',version:'fixture',files:{}}));assert.equal(f.bridge.bundled().dependenciesReady,false);}});
test('development manifest cannot redirect entry outside component',t=>{const f=fixture(t);deps(f);f.write('manifest.json',JSON.stringify({component:'codex-light-dsh-bridge',entry:'../outside.mjs'}));assert.equal(f.bridge.bundled().available,false);});

test('real built bundle passes then corrupted payload fails closed',{skip:!process.env.DSH_TEST_BUNDLE_ROOT},t=>{const f=fixture(t);fs.cpSync(process.env.DSH_TEST_BUNDLE_ROOT,f.root,{recursive:true});assert.equal(f.bridge.bundled().dependenciesReady,true);fs.appendFileSync(path.join(f.root,'src','light-entry.mjs'),'\n// changed fixture\n');assert.equal(f.bridge.bundled().dependenciesReady,false);});
