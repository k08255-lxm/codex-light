import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {WslRuntime,WslSelectionStore,validateWslSelection,wslPathToHost,hostPathToWsl,mapWslRequest,mapWslResponse,wslProfileId} from '../src/wsl-runtime.mjs';
import {RpcClient} from '../src/rpc.mjs';
import {TerminalService} from '../src/terminal.mjs';

const candidate={distribution:'Ubuntu',user:'lee',home:'/home/lee',codexHome:'/home/lee/.codex',codexPath:'/home/lee/bin/codex',available:true};
test('registered distribution detection decodes UTF16 and never executes Codex',async()=>{
 const calls=[];const runtime=new WslRuntime({platform:'win32',env:{SystemRoot:'C:\\Windows'},run:async(command,args)=>{calls.push({command,args});return {stdout:args.includes('--list')?Buffer.from('Ubuntu\r\nDebian\r\n','utf16le'):'noise\nCODECANG_WSL\nlee\n/home/lee\n/home/lee/.codex\n/home/lee/bin/codex\nlinux\n'};}});
 const result=await runtime.probe({distribution:'Ubuntu'});assert.deepEqual(result,candidate);assert.equal(calls.length,2);assert.ok(calls.every(x=>x.command==='C:\\Windows\\System32\\wsl.exe'));assert.ok(calls.every(x=>!x.args.includes('--version')&&!x.args.includes('app-server')));
 await assert.rejects(runtime.probe({distribution:'not-installed'}),e=>e.code==='WSL_NOT_FOUND');
});
test('selection rejects injected names and arbitrary command options',()=>{
 for(const value of [{distribution:'Ubuntu;whoami'},{distribution:'--exec'},{distribution:'Ubuntu',user:'a\nb'},{distribution:'Ubuntu',command:'/bin/sh'}])assert.throws(()=>validateWslSelection(value));
 assert.deepEqual(validateWslSelection({distribution:'Ubuntu-24.04',user:'lee'}),{distribution:'Ubuntu-24.04',user:'lee'});assert.equal(validateWslSelection(null),null);
});
test('probe rejects non-default users and identifies Windows interop shims as unavailable',async()=>{
 const runtime=new WslRuntime({platform:'win32',run:async(c,args)=>({stdout:args.includes('--list')?Buffer.from('Ubuntu\n','utf16le'):'CODECANG_WSL\nlee\n/home/lee\n/home/lee/.codex\n/mnt/c/npm/codex\nwindows-interop\n'})});
 await assert.rejects(runtime.probe({distribution:'Ubuntu',user:'root'}),e=>e.code==='WSL_USER_MISMATCH');
 const result=await runtime.probe({distribution:'Ubuntu',user:'lee'});assert.equal(result.available,false);assert.match(result.diagnostic,/Windows interop/);
});
test('custom nvm CLI path is a positional parameter and verified Node directory is launch-local',async()=>{
 const custom='/home/lee/.nvm/versions/node/v24/bin/codex';let probeArgs;
 const runtime=new WslRuntime({platform:'win32',run:async(c,args)=>{if(args.includes('--list'))return {stdout:Buffer.from('Ubuntu\n','utf16le')};probeArgs=args;return {stdout:'CODECANG_WSL\nlee\n/home/lee\n/home/lee/.codex\n/home/lee/.nvm/versions/node/v24/lib/node_modules/@openai/codex/bin/codex.js\nlinux\n/home/lee/.nvm/versions/node/v24/bin\n'};}});
 const result=await runtime.probe({distribution:'Ubuntu',codexPath:custom});assert.equal(probeArgs.at(-1),custom);assert.ok(!probeArgs[probeArgs.indexOf('-lc')+1].includes(custom));assert.equal(result.available,true);assert.ok(runtime.launch(result).args.includes('/home/lee/.nvm/versions/node/v24/bin'));
});
test('probe refuses an unrepresentable Linux Codex home before constructing runtime services',async()=>{
 const runtime=new WslRuntime({platform:'win32',run:async(c,args)=>({stdout:args.includes('--list')?Buffer.from('Ubuntu\n','utf16le'):'CODECANG_WSL\nlee\n/home/lee\n/home/lee/cache:bad\n/usr/bin/codex\nlinux\n'})});
 await assert.rejects(runtime.probe({distribution:'Ubuntu'}),e=>e.code==='WSL_PATH_UNSUPPORTED');
});
test('probe and launch isolate Windows home/key and pass user/command as individual arguments',async()=>{
 let options;const runtime=new WslRuntime({platform:'win32',env:{SystemRoot:'C:\\Windows',CODEX_HOME:'C:\\secret',OPENAI_API_KEY:'do-not-forward',DSH_HOME:'C:\\private-dsh',DSH_SUBAGENT_CONFIG:'C:\\private-state',DEEPSEEK_API_KEY:'private-key',dsh_home:'mixed-case',WslEnv:'MY_WB_KEY/u',MY_WB_KEY:'private-custom',WSLENV:'CODEX_HOME/p:OPENAI_API_KEY:DSH_HOME/p:DSH_SUBAGENT_CONFIG/p:DEEPSEEK_API_KEY:LANG',LANG:'en_US.UTF-8'},run:async(c,a,o)=>{options=o;return {stdout:''};}});
 await runtime.distributions();assert.equal(options.env.CODEX_HOME,undefined);assert.equal(options.env.OPENAI_API_KEY,undefined);assert.equal(options.env.WSLENV,'');assert.equal(options.env.DSH_HOME,undefined);assert.equal(options.env.DSH_SUBAGENT_CONFIG,undefined);assert.equal(options.env.DEEPSEEK_API_KEY,undefined);assert.equal(options.env.dsh_home,undefined);assert.equal(options.env.WslEnv,undefined);
 const launch=runtime.launch(candidate);assert.ok(launch.args.includes(candidate.codexPath));assert.deepEqual(launch.args.slice(0,6),['--distribution','Ubuntu','--user','lee','--cd','/home/lee']);assert.equal(launch.env.CODEX_HOME,undefined);assert.ok(launch.args.some(x=>x.includes('exec "$@"')));
 assert.throws(()=>runtime.launch({...candidate,available:false}),e=>e.code==='WSL_CODEX_NOT_FOUND');
});
test('UNC mapping confines distribution, preserves case, refuses generic network shares',()=>{
 assert.equal(wslPathToHost('/home/Lee/Repo','Ubuntu'),'\\\\wsl.localhost\\Ubuntu\\home\\Lee\\Repo');
 assert.equal(hostPathToWsl('\\\\wsl$\\Ubuntu\\home\\Lee\\Repo','Ubuntu'),'/home/Lee/Repo');
 assert.throws(()=>hostPathToWsl('\\\\wsl.localhost\\Debian\\etc','Ubuntu'),e=>e.code==='WSL_CROSS_DISTRIBUTION');
 for(const value of ['\\\\server\\share','C:\\repo'])assert.throws(()=>hostPathToWsl(value,'Ubuntu'));
 assert.throws(()=>wslPathToHost('/home/../etc','Ubuntu'));assert.throws(()=>wslPathToHost('/home/a:b','Ubuntu'));
});
test('drive mapping asks selected distro wslpath instead of assuming /mnt/c',async()=>{
 let seen;const runtime=new WslRuntime({platform:'win32',run:async(c,args)=>{seen=args;return {stdout:'/custom/c/Repo\n'};}});
 assert.equal(await runtime.toLinux('C:\\Repo with spaces',candidate),'/custom/c/Repo');assert.deepEqual(seen,['--distribution','Ubuntu','--user','lee','--exec','wslpath','-a','-u','C:\\Repo with spaces']);
});
test('explicit discovery includes a stopped registered distro and uses exec to probe it',async()=>{
 let state='Stopped';const runtime=new WslRuntime({platform:'win32',run:async(c,args)=>{if(args.includes('--list')){assert.ok(!args.includes('--running'));return {stdout:Buffer.from('Ubuntu\n','utf16le')};}assert.ok(args.includes('--exec'));state='Running';return {stdout:'CODECANG_WSL\nlee\n/home/lee\n/home/lee/.codex\n/usr/bin/codex\nlinux\n'};}});
 assert.equal(state,'Stopped');const result=await runtime.discover();assert.equal(state,'Running');assert.equal(result.candidates[0].available,true);
});
test('RPC path translation handles structured fields but does not rewrite user text',async()=>{
 const value={cwd:'\\\\wsl.localhost\\Ubuntu\\home\\lee',cwds:['\\\\wsl.localhost\\Ubuntu\\repo'],sandboxPolicy:{writableRoots:['\\\\wsl.localhost\\Ubuntu\\repo']},input:[{type:'text',text:'C:\\private do not rewrite'}]};
 const mapped=await mapWslRequest(value,v=>hostPathToWsl(v,'Ubuntu'));assert.equal(mapped.cwd,'/home/lee');assert.deepEqual(mapped.cwds,['/repo']);assert.deepEqual(mapped.sandboxPolicy.writableRoots,['/repo']);assert.equal(mapped.input[0].text,value.input[0].text);
 const result=mapWslResponse({thread:{cwd:'/home/Lee'},text:'/home/Lee'},'Ubuntu');assert.equal(result.thread.cwd,'\\\\wsl.localhost\\Ubuntu\\home\\Lee');assert.equal(result.text,'/home/Lee');
});
test('profile identity isolates Linux users, distributions and CODEX_HOME',()=>{
 const id=wslProfileId(candidate);for(const patch of [{user:'other'},{distribution:'Debian'},{codexHome:'/tmp/codex'}])assert.notEqual(wslProfileId({...candidate,...patch}),id);assert.equal(wslProfileId({...candidate}),id);
});
test('selection persists only app metadata and supports reset without touching Codex',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'codecang-wsl-store-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=new WslSelectionStore({root});assert.equal(await store.read(),null);await store.save({distribution:'Ubuntu',user:'lee'});assert.deepEqual(await store.read(),{distribution:'Ubuntu',user:'lee'});assert.equal(await readFile(store.file,'utf8'),'{"distribution":"Ubuntu","user":"lee"}');await store.save(null);assert.equal(await store.read(),null);await writeFile(store.file,'{"distribution":"Ubuntu","command":"bad"}');await assert.rejects(store.read());
});
test('RPC adapter works against synthetic process without running Codex',async t=>{
 const rpc=new RpcClient({command:process.execPath,args:[fileURLToPath(new URL('./fake-app-server.mjs',import.meta.url))],mapRequest:params=>mapWslRequest(params,p=>hostPathToWsl(p,'Ubuntu')),mapResponse:value=>mapWslResponse(value,'Ubuntu')});t.after(()=>rpc.close());await rpc.start();const result=await rpc.call('echo',{cwd:'\\\\wsl.localhost\\Ubuntu\\home\\Lee'});assert.equal(result.echo.cwd,'\\\\wsl.localhost\\Ubuntu\\home\\Lee');
 const requests=[];rpc.on('event',msg=>requests.push(msg));rpc.consume(JSON.stringify({id:'approval-wsl',method:'item/commandExecution/requestApproval',params:{cwd:'/home/Lee',threadId:'t'}})+'\n');assert.equal(requests.at(-1).params.cwd,'/home/Lee');
});
test('WSL terminal selects Linux shell while validating Windows UNC workspace',async()=>{
 const calls=[];const rpc={connected:true,call:async(method,params)=>{calls.push({method,params});return {exitCode:0};}};
 const terminal=new TerminalService(rpc,{platform:'win32',shellCommand:['/bin/sh'],validateCwd:async()=>{}});
 await terminal.open({cwd:'\\\\wsl.localhost\\Ubuntu\\home\\lee\\repo with spaces',size:{rows:24,cols:80}});await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(calls[0].params.command,['/bin/sh']);assert.equal(calls[0].method,'command/exec');assert.ok(calls[0].params.cwd.endsWith('repo with spaces'));await terminal.close();
});
