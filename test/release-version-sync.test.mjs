import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
test('desktop and Android release versions stay synchronized', () => {
  const version = JSON.parse(read('package.json')).version;
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  assert.ok(manifest.includes(`android:versionName="${version}"`));
  assert.ok(Number(manifest.match(/android:versionCode="(\d+)"/)[1]) > 100);
  assert.ok(read('desktop/CodexLight.Desktop.csproj').includes(`<Version>${version}</Version>`));
  // The legacy MSI bridge stays pinned; current Velopack wrappers receive the product version at build time.
  const setup = read('desktop/setup/CodexLight.Setup.csproj');
  for (const tag of ['AssemblyVersion', 'FileVersion']) assert.ok(setup.includes(`<${tag}>0.4.4.0</${tag}>`));
  assert.ok(setup.includes('<Version>0.4.4</Version>'));
  assert.ok(read('desktop/velopack/compat-router/Policy.cs').includes('BridgeVersion="0.4.4"'));
  for(const file of ['desktop/velopack/compat-router/build.ps1','desktop/velopack/setup-wrapper/build.ps1'])assert.ok(read(file).includes('-p:Version=$Version'));
  assert.ok(read('desktop/velopack/build.ps1').includes("'package.json'"));
  assert.ok(read('android/app/src/main/java/com/codexlight/android/CodexLightBridge.java').includes(`return "${version}";`));
  assert.ok(read('android/app/src/main/java/com/codexlight/android/MainActivity.java').includes(`CodexLightMobile/${version}`));
  assert.ok(read('android/app/src/main/res/layout/activity_connect.xml').includes(`android:text="${version}"`));
});