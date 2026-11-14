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
 assert.ok(s.indexOf('Result.READY') < s.indexOf('manager.saveCurrent(target, authorizedNetwork)'));
});
test('Android secrets are encrypted without plaintext fallback and history loss',()=>{
 const s=read('ServerConfigManager.java'); assert.match(s,/CredentialCipher.seal/); assert.match(s,/remove\(KEY_CURRENT_TOKEN\)/); assert.match(s,/remove\(KEY_HISTORY_JSON\)/);
 assert.match(s,/if \(storageError\) return/); assert.doesNotMatch(s,/putString\(KEY_CURRENT_TOKEN,/);
 const c=read('CredentialCipher.java'); assert.match(c,/AndroidKeyStore/); assert.match(c,/AES\/GCM\/NoPadding/); assert.match(c,/key\(false\)/);
});

test('Network identity fails closed and stays pinned across Activity recreation',()=>{
 const n=read('NetworkBinding.java'); const m=read('MainActivity.java'); const c=read('ServerConnectActivity.java');
 assert.match(n,/Settings.Global.getInt\(context.getContentResolver\(\), Settings.Global.BOOT_COUNT\)/);
 assert.match(n,/catch \(Exception unavailable\) \{ return ""; \}/);
 assert.match(n,/saved != null && !saved.isEmpty\(\) && saved.equals\(current\)/);
 assert.match(n,/network.openConnection\(url\)/); assert.match(n,/bindProcessToNetwork\(network\)/);
 assert.match(c,/putExtra\("authorizedNetwork", automatic \? configManager.getNetworkBinding\(\) : NetworkBinding.current\(this\)\)/);
 assert.match(m,/authorizedNetwork = intent.getStringExtra\("authorizedNetwork"\)/);
 assert.doesNotMatch(m,/authorizedNetwork = NetworkBinding.current/);
 assert.match(m,/NetworkBinding.release\(this, networkLease\)/);
});
test('Storage failures are reported and background cancellation exits spinner',()=>{
 const s=read('ServerConfigManager.java'); const m=read('MainActivity.java');
 assert.match(s,/commit\(\)/); assert.match(m,/manager.hasStorageError\(\)/);
 assert.match(m,/showConnectionError\("连接已暂停/);
});
