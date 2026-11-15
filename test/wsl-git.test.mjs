import test from 'node:test';
import assert from 'node:assert/strict';
import {WslRuntime} from '../src/wsl-runtime.mjs';

const candidate={distribution:'Ubuntu',user:'lee',home:'/home/lee',codexHome:'/home/lee/.codex',codexPath:'/usr/bin/codex',available:true};

test('WSL Git reads use the selected distro/user and preserve paths as argv',async()=>{
 const calls=[],runtime=new WslRuntime({platform:'win32',env:{SystemRoot:'C:\\Windows',GIT_DIR:'C:\\wrong-repo',CODEX_HOME:'C:\\private',WSLENV:'GIT_DIR/p'},run:async(command,args,options)=>{calls.push({command,args,options});return {stdout:'diff bytes',stderr:''};}});
 const result=await runtime.gitRead('\\\\wsl.localhost\\Ubuntu\\home\\lee\\Repo $x; name',['diff','--no-ext-diff','--no-textconv','--no-color','--'],candidate);
 assert.deepEqual(result,{exitCode:0,stdout:'diff bytes',stderr:''});
 const call=calls[0];assert.deepEqual(call.args.slice(0,6),['--distribution','Ubuntu','--user','lee','--cd','/home/lee/Repo $x; name']);
 assert.ok(call.args.includes('--exec'));assert.equal(call.options.shell,false);assert.equal(call.options.windowsHide,true);
 assert.equal(call.options.env.GIT_DIR,undefined);assert.equal(call.options.env.CODEX_HOME,undefined);assert.equal(call.options.env.WSLENV,'');
 assert.equal(call.options.maxBuffer,2*1024*1024);assert.equal(call.options.timeout,15000);
 assert.deepEqual(call.args.slice(-5),['diff','--no-ext-diff','--no-textconv','--no-color','--']);
 assert.ok(!call.args[call.args.indexOf('-lc')+1].includes('Repo $x; name'));
 assert.match(call.args[call.args.indexOf('-lc')+1],/7f454c46/,'an interop Windows Git is never substituted');
});

test('WSL Git nonzero exit is preserved; launch/timeout failures stay failures',async()=>{
 const runtime=new WslRuntime({platform:'win32',run:async()=>{throw Object.assign(new Error('exit'),{code:1,stdout:'',stderr:''});}});
 assert.equal((await runtime.gitRead('/home/lee/repo',['config'],candidate)).exitCode,1);
 runtime.run=async()=>{throw Object.assign(new Error('not a repo'),{code:128,stdout:'',stderr:'not a repository'});};
 assert.equal((await runtime.gitRead('/home/lee/repo',['diff'],candidate)).stderr,'not a repository');
 runtime.run=async()=>{throw Object.assign(new Error('timeout'),{code:null,killed:true,stdout:'partial'});};
 await assert.rejects(runtime.gitRead('/home/lee/repo',['diff'],candidate),/超时|timeout/i);
 runtime.run=async()=>{throw Object.assign(new Error('missing'),{code:'ENOENT'});};
 await assert.rejects(runtime.gitRead('/home/lee/repo',['diff'],candidate));
});

test('WSL Git rejects another distro and generic network paths before invoking a process',async()=>{
 let calls=0;const runtime=new WslRuntime({platform:'win32',run:async()=>{calls++;return {stdout:''};}});
 for(const cwd of ['\\\\wsl.localhost\\Debian\\home\\lee','\\\\server\\share'])await assert.rejects(runtime.gitRead(cwd,['diff'],candidate));
 assert.equal(calls,0);
});

test('WSL Git reports output overflow before the process killed flag',async()=>{
 const runtime=new WslRuntime({platform:'win32',run:async()=>{throw Object.assign(new Error('overflow'),{code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',killed:true,stdout:'partial'});}});
 await assert.rejects(runtime.gitRead('/home/lee/repo',['diff'],candidate),{code:'WSL_GIT_OUTPUT_LIMIT'});
});
