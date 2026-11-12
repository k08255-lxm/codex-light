import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,rm,readFile,mkdir} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';import {GitService} from '../src/git.mjs';import {createServer} from '../src/server.mjs';
test('real temporary Git repository: status/diff handle spaces and Chinese, POSIX newline rename, without mutation',async t=>{
 const cwd=await mkdtemp(path.join(os.tmpdir(),'codex-light-git-test-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
 // os.devNull is \\.\nul on Windows and is rejected by Git; use a real empty config file and hooks directory in the fixture.
 const configFile=path.join(cwd,'.gitconfig-empty'),hooks=path.join(cwd,'.empty-hooks');await writeFile(configFile,'');await mkdir(hooks);
 const git=(...args)=>execFileSync('git',args,{cwd,env:{...process.env,GIT_CONFIG_GLOBAL:configFile,GIT_CONFIG_NOSYSTEM:'1'},stdio:'pipe'});
 git('init');const windows=process.platform==='win32';const before=windows?'空格 旧.txt':'空 格\nold.txt',after=windows?'中文 新 name.txt':'中文 新\nname.txt';await writeFile(path.join(cwd,before),'original\n');git('add','--',before);git('-c','user.name=Cloud Test','-c','user.email=test@example.invalid','-c',`core.hooksPath=${hooks}`,'commit','-m','fixture');git('mv','--',before,after);await writeFile(path.join(cwd,after),'original\nchanged\n');await writeFile(path.join(cwd,'未跟踪 file.txt'),'untracked');
 const indexBefore=await readFile(path.join(cwd,'.git/index'));const service=new GitService();
 // This fixture repository is created here and has no attributes; system Git config may still contain LFS filters.
 const result=await service.read({cwd,kind:'status',confirmedInspection:true});const rename=result.files.find(x=>x.index==='R');assert.equal(rename.path,after);assert.equal(rename.originalPath,before);assert.ok(result.files.some(x=>x.path==='未跟踪 file.txt'));
 assert.match((await service.read({cwd,kind:'diff',confirmedInspection:true})).diff,/changed/);assert.match((await service.read({cwd,kind:'stagedDiff',confirmedInspection:true})).diff,/rename/);assert.deepEqual(await readFile(path.join(cwd,'.git/index')),indexBefore);
 const app=await createServer({demo:true});await app.started;t.after(()=>app.close());
 const response=await fetch(app.origin+'/api/git/read',{method:'POST',headers:{Authorization:`Bearer ${app.token}`,'Content-Type':'application/json'},body:JSON.stringify({cwd,kind:'status',confirmedInspection:true})});assert.equal(response.status,200);assert.deepEqual((await response.json()).files,result.files);
});
