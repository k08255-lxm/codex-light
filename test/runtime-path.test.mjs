import test from 'node:test';import assert from 'node:assert/strict';import {nativeCodex,resolveCodexRuntime,parseCodexVersion,discoverDesktopLocation} from '../src/runtime-path.mjs';

const npmPath='C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
const desktopLocation='C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0.0_x64__abc';
const desktopPath=desktopLocation+'\\app\\resources\\codex.exe';

test('Windows resolver never falls back to cwd codex.exe',()=>{
 const probes=[];assert.throws(()=>nativeCodex({platform:'win32',env:{APPDATA:'C:\\User\\AppData'},home:'C:\\User',exists:p=>{probes.push(p);return p==='codex.exe';},discoverDesktop:()=>null}),/不会从工作目录/);assert.ok(probes.every(p=>p.startsWith('C:\\')));
 const found=nativeCodex({platform:'win32',env:{APPDATA:'C:\\User\\AppData'},exists:p=>p.includes('codex-win32-x64'),discoverDesktop:()=>null,versionOf:()=>'0.157.1'});assert.ok(found.endsWith('\\bin\\codex.exe'));
});

test('Explicit native CLI requires absolute path and has highest priority',()=>{
 for(const value of ['codex.exe','C:\\tools\\codex.cmd','C:\\bad\n.exe'])assert.throws(()=>nativeCodex({platform:'win32',env:{CODEX_LIGHT_CODEX:value},exists:()=>true}));
 let discovered=0;
 const resolved=resolveCodexRuntime({platform:'win32',env:{CODEX_LIGHT_CODEX:'C:\\tools\\codex.exe'},exists:()=>true,discoverDesktop:()=>{discovered++;return desktopLocation;}});
 assert.equal(resolved.path,'C:\\tools\\codex.exe');assert.equal(resolved.source,'env');assert.equal(discovered,0);
 assert.equal(nativeCodex({platform:'win32',env:{CODEX_LIGHT_CODEX:'C:\\tools\\codex.exe'},exists:()=>true}),'C:\\tools\\codex.exe');
});

test('Non-Windows keeps absolute PATH lookup only',()=>{
 assert.equal(nativeCodex({platform:'linux',env:{PATH:'.:relative:/usr/bin'},exists:()=>true}),'/usr/bin/codex');
 assert.throws(()=>nativeCodex({platform:'linux',env:{PATH:'.:relative'},exists:()=>true}),/未找到已安装/);
});

test('Windows picks the newer SemVer and prefers npm on a tie',()=>{
 const run=(npmVersion,desktopVersion)=>{
  const versionOf=p=>p===npmPath?npmVersion:p===desktopPath?desktopVersion:null;
  return resolveCodexRuntime({platform:'win32',env:{APPDATA:'C:\\Users\\u\\AppData\\Roaming'},exists:p=>p===npmPath||p===desktopPath,discoverDesktop:()=>desktopLocation,versionOf});
 };
 let resolved=run('0.157.1','0.167.0-alpha.3.2');
 assert.equal(resolved.path,desktopPath);assert.equal(resolved.source,'desktop');assert.equal(resolved.npm.version,'0.157.1');assert.equal(resolved.desktop.version,'0.167.0-alpha.3.2');
 resolved=run('0.167.1','0.167.0-alpha.3.2');
 assert.equal(resolved.path,npmPath);assert.equal(resolved.source,'npm');
 resolved=run('0.167.1','0.167.1');
 assert.equal(resolved.path,npmPath);assert.equal(resolved.source,'npm');
});

test('missing or failed candidate versions use deterministic npm fallback and diagnostics',()=>{
 const versionOf=p=>{if(p===desktopPath)throw new Error('bad probe');return '0.157.1';};
 const resolved=resolveCodexRuntime({platform:'win32',env:{APPDATA:'C:\\Users\\u\\AppData\\Roaming'},exists:p=>p===npmPath||p===desktopPath,discoverDesktop:()=>desktopLocation,versionOf});
 assert.equal(resolved.path,npmPath);assert.equal(resolved.desktop.version,null);assert.ok(resolved.diagnostics.some(line=>/版本探测失败/.test(line)));
});

test('desktop discovery only accepts an absolute OpenAI.Codex package path with app/resources/codex.exe',()=>{
 const base={platform:'win32',env:{APPDATA:'C:\\Users\\u\\AppData\\Roaming'},versionOf:()=>'0.167.0'};
 for(const location of ['relative\\OpenAI.Codex_x','C:\\tmp\\NotCodex','C:\\tmp\\OpenAI.Codex_x\\..\\..\\Windows\\System32']){
  const result=resolveCodexRuntime({...base,exists:p=>p.endsWith('codex.exe'),discoverDesktop:()=>location});
  assert.equal(result.path,npmPath);assert.equal(result.source,'npm');
  assert.equal(result.desktop.available,false);assert.ok(result.diagnostics.length>0);
 }
 const missing=resolveCodexRuntime({...base,exists:p=>p===npmPath,discoverDesktop:()=>desktopLocation});
 assert.equal(missing.desktop.available,false);assert.ok(missing.diagnostics.some(line=>/缺少 app\/resources\/codex\.exe/.test(line)));
});

test('desktop discovery uses the fixed non-interactive PowerShell query with bounded output',()=>{
 const calls=[];
 const location=discoverDesktopLocation({platform:'win32',env:{SystemRoot:'C:\\Windows'},spawnSyncFn:(command,args,options)=>{
  calls.push({command,args,options});return {status:0,stdout:`warning line\r\n${desktopLocation}\r\n`};
 }});
 assert.equal(location,desktopLocation);
 assert.equal(calls.length,1);assert.equal(calls[0].command,'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
 assert.deepEqual(calls[0].args,['-NoLogo','-NoProfile','-NonInteractive','-Command','Get-AppxPackage -Name OpenAI.Codex | Select-Object -ExpandProperty InstallLocation']);
 assert.equal(calls[0].options.timeout,5000);assert.equal(calls[0].options.maxBuffer,64*1024);
 assert.equal(calls[0].options.windowsHide,true);assert.equal(calls[0].options.shell,false);
});

test('version text parsing accepts prerelease and rejects build metadata or malformed versions',()=>{
 assert.equal(parseCodexVersion('codex-cli 0.167.0-alpha.3.2'),'0.167.0-alpha.3.2');
 assert.equal(parseCodexVersion('codex 1.2.3'),'1.2.3');
 assert.equal(parseCodexVersion('codex 1.2.3+build'),null);
 assert.equal(parseCodexVersion('codex 01.2.3'),null);
 assert.equal(parseCodexVersion('no version'),null);
});
