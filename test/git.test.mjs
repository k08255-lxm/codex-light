import test from 'node:test';
import assert from 'node:assert/strict';
import {GitService,parseGitStatus} from '../src/git.mjs';
test('Git NUL format preserves filenames and rename direction',()=>{
 assert.deepEqual(parseGitStatus(' M space name.txt\0R  new\nname\0old name\0?? 新.txt\0'),[
 {index:' ',worktree:'M',path:'space name.txt'},
 {index:'R',worktree:' ',path:'new\nname',originalPath:'old name'},
 {index:'?',worktree:'?',path:'新.txt'}]);
 assert.throws(()=>parseGitStatus('R  incomplete\0'));
});
test('Git read has fixed argv and never invokes shell or mutations',async()=>{
 const calls=[];const service=new GitService({platform:'linux',validateDirectory:async()=>{},run:async(cwd,args)=>{calls.push({cwd,args});return {exitCode:0,stdout:'',stderr:''};}});
 assert.deepEqual(await service.read({cwd:'/tmp/a b',kind:'status'}),{files:[]});
 await service.read({cwd:'/tmp/a b',kind:'stagedDiff'});
 assert.deepEqual(calls[3].args,['diff','--no-ext-diff','--no-textconv','--no-color','--cached','--']);
 for(const input of [{cwd:'/tmp',kind:'commit'},{cwd:'relative',kind:'status'},{cwd:'/tmp',kind:'diff',args:['push']}])await assert.rejects(service.read(input));
 assert.equal(calls.length,4);
});
test('Git errors never become empty success',async()=>{
 const service=new GitService({platform:'linux',validateDirectory:async()=>{},run:async()=>({exitCode:128,stdout:'',stderr:'not a repository'})});
 await assert.rejects(service.read({cwd:'/tmp',kind:'status'}),/not a repository/);
});
test('configured filters block before status/diff, explicit consent is per read',async()=>{const calls=[];const service=new GitService({platform:'linux',validateDirectory:async()=>{},run:async(cwd,args)=>{calls.push(args);return{exitCode:0,stdout:args[0]==='config'?'filter.canary.clean\n':'',stderr:''};}});await assert.rejects(()=>service.read({cwd:'/tmp',kind:'diff'}),{code:'GIT_INSPECTION_CONFIRMATION_REQUIRED'});assert.equal(calls.length,1);assert.equal(calls[0][0],'config');await service.read({cwd:'/tmp',kind:'diff',confirmedInspection:true});assert.equal(calls[2][0],'diff');await assert.rejects(()=>service.read({cwd:'/tmp',kind:'status'}),{code:'GIT_INSPECTION_CONFIRMATION_REQUIRED'});});
