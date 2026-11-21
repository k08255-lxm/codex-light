import assert from 'node:assert/strict';
import {lstat,mkdir,mkdtemp,readFile,realpath,readdir,rm,symlink,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createSkillImporter} from '../src/skill-import.mjs';

async function fixture(t){
 const tmp=await mkdtemp(path.join(await realpath(os.tmpdir()),'codecang-skill-import-'));
 t.after(()=>rm(tmp,{recursive:true,force:true}));
 const home=path.join(tmp,'home'),source=path.join(tmp,'sample-skill');
 await mkdir(home);await mkdir(source);
 const manifest=path.join(source,'SKILL.md'),dest=path.join(home,'.agents','skills','sample-skill');
 const content='---\nname: sample-skill\ndescription: A test skill\n---\n# Sample\n';
 await writeFile(manifest,content);
 return {tmp,home,source,manifest,dest,content};
}

test('copies only the approved native selection once, including Unicode resources',async t=>{
 const {home,source,manifest,dest,content}=await fixture(t);
 const files=path.join(source,'references');
 await mkdir(files);await writeFile(path.join(files,'示例说明.md'),'fixture');
 const importer=createSkillImporter({home,chooseFolder:async()=>source});
 const {plan}=await importer.pick();
 assert.equal(plan.name,'sample-skill');
 assert.equal(plan.fileCount,2);
 assert.deepEqual(await readdir(home),[]);
 await assert.rejects(importer.install({planId:plan.id,confirmed:false}),/请确认/);
 await writeFile(manifest,'source changed after preview');
 assert.deepEqual(await importer.install({planId:plan.id,confirmed:true}),{name:plan.name});
 assert.equal(await readFile(path.join(dest,'SKILL.md'),'utf8'),content);
 assert.equal(await readFile(path.join(dest,'references','示例说明.md'),'utf8'),'fixture');
 assert.equal(await readFile(manifest,'utf8'),'source changed after preview');
 assert.deepEqual((await readdir(dest)).sort(),['SKILL.md','references']);
 await assert.rejects(importer.install({planId:plan.id,confirmed:true}),/失效/);
});

test('blocks same-name target without overwriting and expires selected plans',async t=>{
 const {home,source,dest,content}=await fixture(t);
 let clock=0;
 const importer=createSkillImporter({home,chooseFolder:async()=>source,now:()=>clock});
 const {plan}=await importer.pick();
 clock=5*60*1000;
 await assert.rejects(importer.install({planId:plan.id,confirmed:true}),/失效/);
 assert.deepEqual(await readdir(home),[]);
 await mkdir(dest,{recursive:true});await writeFile(path.join(dest,'SKILL.md'),content+'old');
 const newer=await importer.pick();
 await assert.rejects(importer.install({planId:newer.plan.id,confirmed:true}),/未覆盖/);
 assert.equal(await readFile(path.join(dest,'SKILL.md'),'utf8'),content+'old');
});

test('rejects malformed, misnamed and hidden payloads before touching the destination',async t=>{
 const {home,source,manifest,content}=await fixture(t);
 const importer=createSkillImporter({home,chooseFolder:async()=>source});
 await writeFile(manifest,content.replace('sample-skill','mismatch'));
 await assert.rejects(importer.pick(),/名称必须/);
 await writeFile(manifest,content.replace('description: A test skill','description: ""'));
 await assert.rejects(importer.pick(),/description/);
 await writeFile(manifest,content);
 await writeFile(path.join(source,'.env'),'fixture only');
 await assert.rejects(importer.pick(),/隐藏文件/);
 assert.deepEqual(await readdir(home),[]);
});

test('rejects symlinked source entries and destination roots',async t=>{
 const {tmp,home,source,manifest}=await fixture(t);
 const external=path.join(tmp,'external');await mkdir(external);
 try{await symlink(external,path.join(source,'link'),'junction');}
 catch(error){if(error.code==='EPERM'){t.skip('requires link creation permission');return;}throw error;}
 const importer=createSkillImporter({home,chooseFolder:async()=>source});
 await assert.rejects(importer.pick(),/链接|重解析/);
 const other=path.join(tmp,'other');
 await mkdir(other);await symlink(external,path.join(home,'.agents'),'junction');
 const unnamed=path.join(other,'sample-skill');
 await mkdir(unnamed);await writeFile(path.join(unnamed,'SKILL.md'),await readFile(manifest));
 const safe=newImport(unnamed);
 const {plan}=await safe.pick();
 await assert.rejects(safe.install({planId:plan.id,confirmed:true}),/重解析/);
 assert.deepEqual(await readdir(external),[]);
 assert.equal((await lstat(path.join(home,'.agents'))).isSymbolicLink(),true);
 function newImport(folder){return createSkillImporter({home,chooseFolder:async()=>folder});}
});
