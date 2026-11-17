import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('CodeCang display brand is consistent across desktop, web and Android',()=>{
 for(const path of ['public/index.html','public/ui/about-view.js','desktop/MainWindow.cs','desktop/StartupView.cs','desktop/CloseChoiceDialog.cs','android/app/src/main/res/values/strings.xml','android/app/src/main/assets/web/index.html']){assert.ok(read(path).includes('码舱 CodeCang'),path);assert.ok(!read(path).includes('Codex Light'),path);}
});
test('rebrand preserves installed identity and old upgrade contracts',()=>{
 const pkg=JSON.parse(read('package.json'));assert.equal(pkg.name,'codex-light-local');
 assert.match(read('desktop/CodexLight.Desktop.csproj'),/<AssemblyName>CodexLight<\/AssemblyName>/);
 assert.ok(read('desktop/velopack/build.ps1').includes('--packId CodexLightDesktop'));
 const packaging=read('desktop/velopack/build.ps1');
 assert.ok(packaging.includes("$packTitle=if($MigrationStage){'Codex Light'}else{$productTitle}"));
 assert.ok(packaging.includes('--packTitle $packTitle'));
 assert.ok(read('desktop/ShortcutBrandMigration.cs').includes('velopack.CodexLightDesktop'));

 assert.ok(read('desktop/velopack/migration/ShortcutHandoff.cs').includes('Codex Light.lnk'));
 assert.match(read('src/rpc.mjs'),/name:'codex_light_local'/);
 assert.ok(read('android/app/src/main/AndroidManifest.xml').includes('com.codexlight.android'));
});

test('Windows PowerShell reads the public package title as UTF-8 and retains the legacy migration title',{skip:process.platform!=='win32'},()=>{
 const source=read('desktop/velopack/build.ps1');
 const titleScript=source.slice(source.indexOf('$productProject='),source.indexOf('& $tool pack'));
 assert.ok(titleScript.includes('-Encoding utf8'));
 for(const [migration,title] of [[false,'码舱 CodeCang'],[true,'Codex Light']]){
  const script='[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$repo=(Get-Location).Path;$MigrationStage=$'+migration+';\n'+titleScript+'\nWrite-Output $packTitle';
  const result=spawnSync(process.env.SystemRoot+'\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{cwd:new URL('../',import.meta.url),encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),title);
 }
});

test('release scripts parse in Windows PowerShell with their on-disk encoding',{skip:process.platform!=='win32'},()=>{
 const script="$files=@('desktop/velopack/build.ps1','desktop/velopack/setup-wrapper/build.ps1','desktop/velopack/compat-router/build.ps1');foreach($file in $files){$tokens=$null;$errors=$null;[Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) $file),[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){Write-Output ($errors|Out-String);exit 1}}";
 const result=spawnSync(process.env.SystemRoot+'\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{cwd:new URL('../',import.meta.url),encoding:'utf8',windowsHide:true,timeout:15000});
 assert.equal(result.status,0,result.stdout+result.stderr);
});
