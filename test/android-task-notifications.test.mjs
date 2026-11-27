import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const source = 'android/app/src/main/java/com/codexlight/android/';
const read = name => readFileSync(source + name, 'utf8');

test('Android notification state validates input and rejects stale terminal resurrection', t => {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const homeBin = process.env.JAVA_HOME && join(process.env.JAVA_HOME, 'bin');
  const binary = name => homeBin && existsSync(join(homeBin, name + suffix)) ? join(homeBin, name + suffix) : name;
  try { execFileSync(binary('javac'), ['-version'], {stdio: 'pipe'}); }
  catch (error) {
    if (error.code === 'ENOENT') return t.skip('JDK unavailable; install a JDK for Android state verification');
    throw error;
  }
  const output = mkdtempSync(join(tmpdir(), 'codex-light-task-notifications-'));
  try {
    execFileSync(binary('javac'), ['-encoding', 'UTF-8', '-d', output,
      source + 'TaskNotificationState.java', 'test/fixtures/TaskNotificationStateTest.java'], {stdio: 'pipe'});
    const result = execFileSync(binary('java'), ['-cp', output, 'com.codexlight.android.TaskNotificationStateTest'], {encoding: 'utf8'});
    assert.match(result, /state checks passed/);
  } finally { rmSync(output, {recursive: true, force: true}); }
});

test('Native notification integration guards trust, uses public Android promotion and expires snapshots', () => {
  const activity = read('MainActivity.java');
  const controller = read('TaskNotificationController.java');
  const manifest = readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8');
  assert.match(activity, /!isDemoMode && currentPageTrusted && currentConfig != null/);
  assert.match(activity, /trustedTaskNotificationPage\(\) && taskNotifications != null/);
  assert.match(controller, /json.length\(\) > 4096/);
  const live = read('AndroidLiveUpdates.java');
  assert.match(live, /"android.requestPromotedOngoing"/);
  assert.match(live, /Notification\.ProgressStyle\(\)\.setProgressIndeterminate\(true\)/);
  assert.match(live, /new Intent\(Settings\.ACTION_APP_NOTIFICATION_PROMOTION_SETTINGS\)\s*\.putExtra\(Settings\.EXTRA_APP_PACKAGE/);
  assert.match(live, /notification\.flags & Notification\.FLAG_PROMOTED_ONGOING/);
  assert.match(controller, /importance == NotificationManager\.IMPORTANCE_MIN/);
  assert.match(controller, /Build.VERSION.SDK_INT >= 36 && running/);
  assert.match(controller, /setTimeoutAfter/);
  assert.match(controller, /setDeleteIntent\(deleteIntent\)/);
  assert.match(controller, /"取消固定"/);
  assert.doesNotMatch(controller+read('QuestionNotificationController.java'),/"忽略本轮"/);
  assert.match(controller, /boolean running = entry.active\(\)/);
  assert.match(manifest, /android.permission.POST_NOTIFICATIONS/);
  assert.match(manifest, /android.permission.POST_PROMOTED_NOTIFICATIONS/);
  assert.match(manifest, /TaskNotificationReceiver" android:exported="false"/);
  assert.doesNotMatch(controller, /Class\.forName|startForeground|MEDIA_PLAYBACK|RemoteViews/);
});

test('Native notification toggles confirm persistence and clicks wait for a trusted matching web acknowledgement', () => {
  const activity = read('MainActivity.java');
  const bridge = read('CodexLightBridge.java');
  const enable = activity.slice(activity.indexOf('public void setTaskNotificationsEnabled('), activity.indexOf('public void openTaskNotificationSettings('));
  assert.match(enable, /taskNotifications\.setEnabled\(enabled,this\);\s*notifyTaskNotificationStatus\(\)/);
  const delivery = activity.slice(activity.indexOf('public void deliverTaskNotificationIntent('), activity.indexOf('public void taskNotificationOpened('));
  assert.match(delivery, /JSONObject\.quote\(thread\)/);
  assert.doesNotMatch(delivery, /pendingNotificationThread\s*=(?!=)|result\s*->/);
  const acknowledgement = activity.slice(activity.indexOf('public void taskNotificationOpened('), activity.indexOf('private void notifyTaskNotificationStatus('));
  assert.match(acknowledgement, /trustedTaskNotificationPage\(\) && TaskNotificationState\.validId\(threadId\)/);
  assert.match(acknowledgement, /threadId\.equals\(pendingNotificationThread\)\) pendingNotificationThread = null/);
  assert.match(bridge, /@JavascriptInterface\s+public void taskNotificationOpened\(final String threadId\)/);
  const bridgeAcknowledgement = bridge.slice(bridge.indexOf('public void taskNotificationOpened('), bridge.indexOf('public boolean copyToClipboard('));
  assert.match(bridgeAcknowledgement, /trustedTaskNotificationPage\(\)/);
  assert.match(bridgeAcknowledgement, /TaskNotificationState\.validId\(threadId\)/);
  assert.match(bridgeAcknowledgement, /runOnUiThread/);
});

test('background notifications use a user-started, private dataSync service and a bounded, authenticated LAN feed', () => {
  const activity = read('MainActivity.java');
  const service = read('MobileNotificationService.java');
  const manifest = readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8');
  assert.match(manifest,/MobileNotificationService" android:exported="false" android:foregroundServiceType="dataSync"/);
  assert.match(activity,/setBackgroundNotifications\(boolean enabled, boolean questionsEnabled\)[\s\S]*?if \(!canOpenWorkbenchSettings\(\) \|\| !hasWindowFocus\(\)\) return/);
  assert.match(service,/!requested\.eligible\(\)/);
  assert.match(service,/!targetOrigin\.equals\(config\.sourceKey\(\)\)/);
  assert.match(activity,/currentConfig\.sourceKey\(\)\.equals\(intent\.getStringExtra\("origin"\)\)/);
  for (const controller of ['TaskNotificationController.java','QuestionNotificationController.java']) {
    assert.match(read(controller),/putExtra\("origin",/);
  }
  assert.match(service,/\/api\/mobile\/notification-state/);
  assert.match(service,/connection\.setInstanceFollowRedirects\(false\)/);
  assert.match(service,/"Authorization","Bearer " \+ config\.getToken\(\)/);
  assert.match(service,/data\.getJSONArray\("pending"\)\.length\(\) > 128/);
  assert.match(service,/FOREGROUND_SERVICE_TYPE_DATA_SYNC/);
  assert.match(service,/"停止同步"/);
  assert.match(read('AndroidLiveUpdates.java'),/canPostPromotedNotifications|hasPromotableCharacteristics/);
});
