import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('CodeCang display brand is consistent across desktop, web and Android',()=>{
 for(const path of ['public/index.html','public/ui/about-view.js','desktop/MainWindow.cs','desktop/StartupView.cs','desktop/CloseChoiceDialog.cs','android/app/src/main/res/values/strings.xml','android/app/src/main/assets/web/index.html']){assert.ok(read(path).includes('码舱 CodeCang'),path);assert.ok(!read(path).includes('Codex Light'),path);}
});
test('rebrand preserves installed identity and old upgrade contracts',()=>{
 const pkg=JSON.parse(read('package.json'));assert.equal(pkg.name,'codex-light-local');
 assert.match(read('desktop/CodexLight.Desktop.csproj'),/<AssemblyName>CodexLight<\/AssemblyName>/);
 assert.ok(read('desktop/velopack/build.ps1').includes('--packId CodexLightDesktop'));
 assert.ok(read('desktop/velopack/build.ps1').includes("--packTitle 'Codex Light'"));
 assert.ok(read('desktop/velopack/migration/ShortcutHandoff.cs').includes('Codex Light.lnk'));
 assert.match(read('src/rpc.mjs'),/name:'codex_light_local'/);
 assert.ok(read('android/app/src/main/AndroidManifest.xml').includes('com.codexlight.android'));
});
