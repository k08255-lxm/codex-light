import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {StorageMaintenance} from '../src/storage-maintenance.mjs';
import {assertUpdateIdle,UpdateReservation} from '../src/app-update-safety.mjs';
test('storage maintenance never selects pending nupkg or updater lock',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'codex-pending-storage-')),files=[];
 for(const rel of ['packages/CodexLightDesktop-9.0.0-full.nupkg','packages/.velopack_lock','Updates/9.0.0-0123456789abcdef/CodexLightDesktop-9.0.0-full.nupkg']){const file=path.join(root,rel);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,'pending fixture');files.push(file);}
 const s=new StorageMaintenance({root});for(const category of ['cache','images','install']){const p=await s.plan({category});assert.equal(p.fileCount,0);await s.apply({...p,confirmed:true});}
 for(const f of files)assert.equal(await readFile(f,'utf8'),'pending fixture');
});
test('pending package does not bypass explicit idle and reservation gates',async()=>{
 const state={rpc:{connected:true,requests:new Map()},sessions:{queues:new Map(),snapshot:()=>({threads:[]})},terminal:{sessions:new Map()},dsh:{threads:new Map(),pending:new Map()},operations:{entries:new Map()},runtime:{busy:()=>true},requestId:'update'};
 let applies=0;const gate=new UpdateReservation();await assert.rejects(gate.run(()=>assertUpdateIdle(state),async()=>applies++),e=>e.code==='APP_UPDATE_WORK_ACTIVE');assert.equal(applies,0);assert.equal(gate.reserved,false);
});
test('production startup disables auto apply before second-instance branch',async()=>{const s=await readFile(new URL('../desktop/Program.cs',import.meta.url),'utf8');const disabled=s.indexOf('SetAutoApplyOnStartup(false).Run()');assert.ok(disabled>=0);assert.ok(disabled<s.indexOf('if(!first)'));assert.ok(s.includes('if(!first){wake.Set();return;}'));assert.equal(s.includes('SetAutoApplyOnStartup(true)'),false);});
