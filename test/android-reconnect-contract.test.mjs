import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const path='android/app/src/main/java/com/codexlight/android/';
const read=name=>readFileSync(path+name,'utf8');
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
 const c=read('CredentialCipher.java'); assert.match(c,/AndroidKeyStore/); assert.match(c,/AES\/GCM\/NoPadding/); assert.match(c,/key\(false\)/);
});

test('Android LAN connections follow default routing without VPN rejection or forced binding',()=>{
 const m=read('MainActivity.java'),p=read('PairingClient.java'),c=read('ServerConnectActivity.java');
 for (const source of [m,p,c]) assert.doesNotMatch(source,/NetworkBinding|TRANSPORT_VPN|bindProcessToNetwork/);
 assert.match(m,/url.openConnection\(\)/);
 assert.match(p,/new URL\("http:\/\//);
 assert.match(p,/setInstanceFollowRedirects\(false\)/);
 assert.match(p,/!privateIp\(host\)/);
 assert.match(p,/port<1\|\|port>65535/);
 assert.match(p,/getUserInfo\(\)!=null\|\|uri.getQuery\(\)!=null/);
 assert.match(p,/pair=\[a-f0-9\]\{64\}/);
});

test('Storage failures are reported and background cancellation exits spinner',()=>{
 const s=read('ServerConfigManager.java'); const m=read('MainActivity.java');
 assert.match(s,/commit\(\)/); assert.match(m,/manager.hasStorageError\(\)/);
 assert.match(m,/showConnectionError\("连接已暂停/);
});
