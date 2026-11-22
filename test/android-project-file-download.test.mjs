import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const source = 'android/app/src/main/java/com/codexlight/android/';
const read = name => readFileSync(source + name, 'utf8');

test('Android project-file transport pins origin, bounds bytes and rejects redirects and invalid content', t => {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const homeBin = process.env.JAVA_HOME && join(process.env.JAVA_HOME, 'bin');
  const binary = name => homeBin && existsSync(join(homeBin, name + suffix)) ? join(homeBin, name + suffix) : name;
  try { execFileSync(binary('javac'), ['-version'], {stdio:'pipe'}); }
  catch (error) {
    if (error.code === 'ENOENT') return t.skip('JDK unavailable');
    throw error;
  }
  const base = realpathSync(tmpdir());
  const output = mkdtempSync(join(base, 'codecang-file-download-'));
  try {
    execFileSync(binary('javac'), ['-encoding','UTF-8','-d',output,source+'ReconnectPolicy.java',source+'ServerConfig.java',
      source+'ProjectFileTransfer.java','test/fixtures/ProjectFileTransferTest.java'], {stdio:'pipe'});
    assert.match(execFileSync(binary('java'), ['-cp',output,'com.codexlight.android.ProjectFileTransferTest'],
      {encoding:'utf8'}), /Project file transfer checks passed/);
  } finally {
    if (dirname(realpathSync(output)) === base) rmSync(output,{recursive:true,force:true});
  }
});

test('paired native document picker is activated by the foreground workbench and obtains a scoped file after confirmation', () => {
  const activity = read('MainActivity.java'), bridge = read('CodexLightBridge.java'), picker = read('ProjectFileDownload.java');
  assert.match(bridge, /@JavascriptInterface\s+public boolean saveProjectFile\(String scopeJson, String path, String name\)/);
  assert.match(activity, /webView\.getUrl\(\)[\s\S]*isTrustedOrigin\(page\)[\s\S]*currentConfig\.eligible/);
  assert.match(picker, /window\.top === window.*document\.visibilityState/s);
  assert.match(picker, /navigator\.userActivation\.isActive/);
  assert.match(picker, /scope\.length\(\) != 1/);
  assert.match(picker, /ACTION_CREATE_DOCUMENT[\s\S]*CATEGORY_OPENABLE/);
  assert.match(picker, /\.setType\(documentMime\(request\.name\)\)[\s\S]*\.getMimeTypeFromExtension/);
  assert.match(picker, /resultCode != Activity\.RESULT_OK[\s\S]*DocumentsContract\.isDocumentUri[\s\S]*job\.download/);
  assert.match(picker, /createTempFile[\s\S]*job\.download[\s\S]*openOutputStream/);
  assert.match(picker, /job\.cancelled\(\)[\s\S]*writingDestination = true;[\s\S]*openOutputStream/);
  assert.match(picker, /!saved && writingDestination/);
  assert.doesNotMatch(picker, /deleteDocument|\.delete\(destination\)/);
  assert.match(activity, /requestCode == ProjectFileDownload\.REQUEST_CODE[\s\S]*onActivityResult\(resultCode, data\)/);
});
