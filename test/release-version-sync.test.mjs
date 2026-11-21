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
test('public download instructions match the release asset/version contract', () => {
  const version = JSON.parse(read('package.json')).version;
  const readme = read('README.md');
  const android = read('android/README.md');
  const versionCode = read('android/app/src/main/AndroidManifest.xml').match(/android:versionCode="(\d+)"/)[1];
  // Only current download examples are synchronized. Historical migration and
  // scoped verification versions must remain unchanged, not globally replaced.
  const setupExamples = [...readme.matchAll(/CodexLight-Setup-(\d+\.\d+\.\d+)-x64\.exe/g)];
  assert.ok(setupExamples.length > 0, 'README needs an exact current Setup example');
  for (const match of setupExamples) assert.equal(match[1], version);
  const installStart = android.indexOf('### 安装与升级');
  const installEnd = android.indexOf('### 连接电脑', installStart);
  assert.ok(installStart >= 0 && installEnd > installStart, 'Android download section must be identifiable');
  const apkExamples = [...android.slice(installStart, installEnd).matchAll(/codex-light-(?:android-)?(\d+\.\d+\.\d+)\.apk/g)];
  assert.ok(apkExamples.length > 0, 'Android download instructions need an exact APK example');
  for (const match of apkExamples) assert.equal(match[1], version);
  const releaseApks = read(`releases/${version}.md`).match(/codex-light-(?:android-)?\d+\.\d+\.\d+\.apk/g) || [];
  const apkNames = [...new Set(apkExamples.map(match => match[0]))];
  assert.equal(apkNames.length, 1, 'Current Android installation instructions must name one APK');
  assert.deepEqual([...new Set(releaseApks)], apkNames, 'Release notes and Android instructions must name the same APK');
  if (version === '0.4.12') assert.equal(apkNames[0], 'codex-light-android-0.4.12.apk');
  assert.ok(android.includes(`versionCode 为 ${versionCode}`));
  assert.ok(readme.includes('SHA256SUMS.txt'));
  assert.ok(android.includes('SHA256SUMS.txt'));
  assert.ok(readme.includes('desktop/velopack/BUILD.md'));
  assert.ok(readme.includes('desktop/velopack/compat-router/README.md'));
});

test('the 0.4.11 client can reach the current Windows installer from the latest release notes', () => {
  const version = JSON.parse(read('package.json')).version;
  const notes = read(`releases/${version}.md`).slice(0, 12000); // The shipped client truncates release bodies here.
  const installer = `https://github.com/k08255-lxm/codex-light/releases/download/v${version}/CodexLight-Setup-${version}-x64.exe`;
  assert.ok(notes.includes('0.4.11') && notes.includes(`](${installer})`));
});

// Historical entries are immutable release evidence, not current-version examples.
test('Android historical release versionCode remains pinned', () => {
  const android = read('android/README.md');
  const historical = [...android.matchAll(/v(0\.4\.6)[^\n]*?versionCode[^\d\n]*(\d+)/g)];
  assert.equal(historical.length, 1);
  assert.equal(historical[0][2], '406', 'v0.4.6 AndroidManifest.xml records 406, not the current versionCode');
});


test('0.4.7 functional Android update contract is documented and guarded', () => {
  const version = JSON.parse(read('package.json')).version;
  if (version !== '0.4.7') return; // One-release policy, not a permanent suppression.
  for (const file of ['android/README.md', 'AGENTS.md']) {
    assert.ok(read(file).includes('codex-light-0.4.7.apk'), file);
    assert.ok(read(file).includes('--android-unchanged'), file);
  }
  assert.ok(read('scripts/assemble-release.mjs').includes('androidNotify?apkInputName:'));
});
