import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const path='android/app/src/main/java/com/codexlight/android/';
const read=name=>readFileSync(path+name,'utf8');

test('paired route selection proves LAN ownership before authorizing and keeps credentials pinned during fallback', t => {
 const tool = name => {
   const file = process.env.JAVA_HOME && join(process.env.JAVA_HOME,'bin',name + (process.platform === 'win32' ? '.exe' : ''));
   return file && existsSync(file) ? file : name;
 };
 try { execFileSync(tool('javac'), ['-version'], {stdio:'pipe'}); }
 catch (error) { if (error.code === 'ENOENT') return t.skip('JDK unavailable'); throw error; }
 const out = mkdtempSync(join(tmpdir(),'codecang-paired-routes-'));
 try {
   execFileSync(tool('javac'), ['-encoding','UTF-8','-d',out,path+'ServerConfig.java',path+'ReconnectPolicy.java',
     path+'ConnectionHistory.java',path+'LanConnectionClient.java','test/android-reconnect/ReconnectTests.java'], {stdio:'pipe'});
   const result = execFileSync(tool('java'), ['-cp',out,'com.codexlight.android.ReconnectTests'], {encoding:'utf8'});
   assert.match(result,/assertions passed/);
 } finally { rmSync(out,{recursive:true,force:true}); }
});

test('Android launcher avoids reconnect loop when user opens connection management',()=>{
 const s=read('ServerConnectActivity.java'); assert.match(s,/savedInstanceState == null/); assert.match(s,/getBooleanExtra\("manual", false\)/); assert.match(s,/isAutoConnectEnabled\(\)/);
 assert.match(read('MainActivity.java'),/putExtra\("manual", true\)/);
});
test('Android connection results are generation and lifecycle guarded, unauthorized resume does not retry',()=>{
 const s=read('MainActivity.java'); assert.match(s,/attemptId != connectionGeneration \|\| isFinishing\(\) \|\| isDestroyed\(\)/);
 assert.match(s,/connectionFailed && !authorizationFailed/); assert.match(s,/connectionAttempt.cancel\(\)/);
 assert.ok(s.indexOf('Result.READY') < s.indexOf('manager.saveCurrent(target, "")'));
});
test('Android secrets are encrypted without plaintext fallback and history loss',()=>{
 const s=read('ServerConfigManager.java'); assert.match(s,/CredentialCipher.seal/); assert.match(s,/remove\(KEY_CURRENT_TOKEN\)/); assert.match(s,/remove\(KEY_HISTORY_JSON\)/);
 assert.match(s,/if \(storageError\) return/); assert.doesNotMatch(s,/putString\(KEY_CURRENT_TOKEN,/);
 assert.match(s,/prefs\.getString\(KEY_CURRENT_SCHEME, "http"\)/);
 assert.match(s,/obj\.optString\("scheme", "http"\)/);
 assert.match(s,/ConnectionHistory\.record\(newCfg, current\)/);
 const c=read('CredentialCipher.java'); assert.match(c,/AndroidKeyStore/); assert.match(c,/AES\/GCM\/NoPadding/); assert.match(c,/key\(false\)/);
});

test('Android LAN connections follow default routing without VPN rejection or forced binding',()=>{
 const m=read('MainActivity.java'),p=read('PairingClient.java'),c=read('ServerConnectActivity.java');
 for (const source of [m,p,c]) assert.doesNotMatch(source,/NetworkBinding|TRANSPORT_VPN|bindProcessToNetwork/);
 assert.match(read('PairedNetwork.java'),/url.openConnection\(\)/);
 assert.match(p,/new URL\(target\.origin\(\) \+ "\/api\/pairing\/redeem"/);
 assert.match(p,/setInstanceFollowRedirects\(false\)/);
 assert.match(c,/ServerConfig\.link\(text, "pair"\)/);
 assert.match(c,/setMessage\(origin/);
 assert.match(m,/webView\.loadUrl\(target\.origin\(\) \+ "\/"\)/);
 assert.match(read('AppWebViewClient.java'),/request\.hasGesture\(\) && !request\.isRedirect\(\)/);
 assert.match(read('AppWebViewClient.java'),/shouldInterceptRequest[\s\S]*!activity\.lanNetworkVerified\(\)/);
 assert.match(read('MobileNotificationService.java'),/verifyPeer\(config, 1500\)/);
 assert.match(read('ProjectFileDownload.java'),/verifyPeer\(server, 1500\)/);
 assert.match(read('AppWebViewClient.java'),/onReceivedError[\s\S]*recheckEventStream\(request\.getUrl\(\)\)/);
 assert.match(m,/!"\/api\/events"\.equals\(uri\.getPath\(\)\)/);
 const monitor=m.slice(m.indexOf('private void checkCurrentRoute('),m.indexOf('private void cancelNetworkProbe('));
 assert.doesNotMatch(monitor.slice(0,monitor.indexOf('if (connectionFailed)')),/isAutoConnectEnabled/);
 assert.match(m,/if \(changedOrigin && workbenchLoaded\)[\s\S]*startActivity\(next\);[\s\S]*finish\(\);/);
});

test('Storage failures are reported and background cancellation exits spinner',()=>{
 const s=read('ServerConfigManager.java'); const m=read('MainActivity.java');
 assert.match(s,/commit\(\)/); assert.match(m,/manager.hasStorageError\(\)/);
 assert.match(m,/showConnectionError\("连接已暂停/);
});
