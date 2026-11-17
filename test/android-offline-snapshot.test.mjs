import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const source='android/app/src/main/java/com/codexlight/android/';
const read=name=>readFileSync(source+name,'utf8');

test('Android offline text snapshots bound, redact, escape and roundtrip on the JVM',t=>{
  const suffix=process.platform==='win32'?'.exe':'';
  const homeBin=process.env.JAVA_HOME&&join(process.env.JAVA_HOME,'bin');
  const binary=name=>homeBin&&existsSync(join(homeBin,name+suffix))?join(homeBin,name+suffix):name;
  try{execFileSync(binary('javac'),['-version'],{stdio:'pipe'});}catch(error){if(error.code==='ENOENT')return t.skip('JDK unavailable');throw error;}
  const output=mkdtempSync(join(tmpdir(),'codex-light-offline-snapshot-'));
  try{
    execFileSync(binary('javac'),['-encoding','UTF-8','-d',output,source+'OfflineSnapshotData.java','test/fixtures/OfflineSnapshotDataTest.java'],{stdio:'pipe'});
    assert.match(execFileSync(binary('java'),['-cp',output,'com.codexlight.android.OfflineSnapshotDataTest'],{encoding:'utf8'}),/data checks passed/);
  }finally{rmSync(output,{recursive:true,force:true});}
});

test('Android offline viewer has no script, bridge, file access or network and preserves atomic bounded history',()=>{
  const controller=read('OfflineSnapshotController.java'),store=read('OfflineSnapshotStore.java'),main=read('MainActivity.java');
  for(const setting of ['JavaScriptEnabled','DomStorageEnabled','AllowFileAccess','AllowContentAccess'])assert.ok(controller.includes(`set${setting}(false)`));
  assert.ok(controller.includes('setBlockNetworkLoads(true)'));
  assert.ok(controller.includes('setBlockNetworkImage(true)'));
  assert.doesNotMatch(controller,/addJavascriptInterface|saveWebArchive|loadUrl\(/);
  assert.match(controller,/shouldOverrideUrlLoading[^\n]*return true/);
  assert.match(controller,/getNoBackupFilesDir\(\)/);
  assert.match(store,/file\.startWrite\(\)/);assert.match(store,/file\.finishWrite\(out\)/);assert.match(store,/file\.failWrite\(out\)/);
  assert.match(store,/OfflineSnapshotData\.staleSnapshotKeys\(modified, key\)/);
  assert.match(controller,/"null"\.equals\(raw\)/);
  assert.match(controller,/request != generation \|\| !stillValid\.getAsBoolean\(\)/);
  assert.match(main,/snapshotPageReady && target == currentConfig && trustedTaskNotificationPage\(\)/);
  assert.match(main,/offlineSnapshots\.pause\(\)/);
});
