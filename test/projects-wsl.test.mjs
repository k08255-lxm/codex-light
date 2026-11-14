import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {ProjectStore} from '../src/projects.mjs';
const a=String.raw`\\wsl.localhost\Ubuntu\home\lee\Repo`,b=String.raw`\\wsl.localhost\Ubuntu\home\lee\repo`;
test('WSL ProjectStore keys preserve Linux case while native Windows keys remain insensitive',()=>{
 const store=new ProjectStore({root:process.cwd(),platform:'win32',wslDistribution:'Ubuntu'});
 assert.notEqual(store.key(a),store.key(b));assert.equal(store.key(a),store.key(String.raw`\\WSL$\Ubuntu\home\lee\Repo`));
 assert.equal(store.key('C:\\Repo'),store.key('c:\\repo'));
 const native=new ProjectStore({root:process.cwd(),platform:'win32'});assert.equal(native.key('C:\\Repo'),native.key('c:\\repo'));
});
test('WSL case-distinct saved projects survive read and add deduplicates only exact paths',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'wsl-project-case-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const store=new ProjectStore({root,platform:'win32',wslDistribution:'Ubuntu'});
 // No actual WSL repository or user data is touched in this registry fixture.
 store.directory=async value=>value;
 const first=await store.add(a),second=await store.add(b);assert.equal(second.projects.length,2);assert.notEqual(first.selectedId,second.selectedId);
 const same=await store.add(String.raw`\\wsl$\Ubuntu\home\lee\Repo`);assert.equal(same.projects.length,2);assert.equal(same.selectedId,first.selectedId);
 const restored=await new ProjectStore({root,platform:'win32',wslDistribution:'Ubuntu'}).list();assert.equal(restored.projects.length,2);
 const duplicate={...restored,projects:[...restored.projects,{...restored.projects[0],id:'f'.repeat(32),path:String.raw`\\wsl$\Ubuntu\home\lee\Repo`}]};assert.throws(()=>store.validate(duplicate));
});
