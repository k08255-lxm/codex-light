package com.codexlight.android;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Build;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.webkit.JavascriptInterface;
import android.widget.Toast;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

public class CodexLightBridge {
    private final Activity activity;

    public CodexLightBridge(Activity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public void showToast(final String message) {
        if (message == null || activity == null) return;
        activity.runOnUiThread(() -> Toast.makeText(activity, message, Toast.LENGTH_SHORT).show());
    }

    @JavascriptInterface
    public void vibrate(final long milliseconds) {
        if (activity == null) return;
        try {
            Vibrator v = (Vibrator) activity.getSystemService(Context.VIBRATOR_SERVICE);
            if (v != null && v.hasVibrator()) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    v.vibrate(VibrationEffect.createOneShot(Math.max(10, milliseconds), VibrationEffect.DEFAULT_AMPLITUDE));
                } else {
                    v.vibrate(Math.max(10, milliseconds));
                }
            }
        } catch (Exception ignored) {}
    }

    @JavascriptInterface
    public String getPreferredTheme() {
        return activity instanceof MainActivity && ((MainActivity)activity).trustedTaskNotificationPage()
            ? DeviceAppearance.theme(activity) : "";
    }

    @JavascriptInterface
    public void setPreferredTheme(String theme) {
        if (activity instanceof MainActivity && ((MainActivity)activity).trustedTaskNotificationPage())
            DeviceAppearance.save(activity,theme);
    }

    @JavascriptInterface
    public void openServerManager() {
        if (activity instanceof MainActivity) {
            activity.runOnUiThread(() -> ((MainActivity) activity).openWorkbenchServerManager());
        }
    }

    @JavascriptInterface
    public void openApplicationSettings() {
        if (activity instanceof MainActivity) {
            activity.runOnUiThread(() -> ((MainActivity) activity).openApplicationSettings());
        }
    }

    @JavascriptInterface
    public void setToolbarIntegrated(final boolean integrated) {
        if (activity instanceof MainActivity) {
            activity.runOnUiThread(() -> ((MainActivity) activity).setToolbarIntegrated(integrated));
        }
    }

    @JavascriptInterface
    public String getTaskNotificationStatus() {
        return activity instanceof MainActivity
            ? ((MainActivity) activity).getTaskNotificationStatus() : "{\"supported\":false}";
    }

    @JavascriptInterface
    public void setTaskNotificationsEnabled(final boolean enabled) {
        if (activity instanceof MainActivity && ((MainActivity) activity).trustedTaskNotificationPage()) {
            activity.runOnUiThread(() -> ((MainActivity) activity).setTaskNotificationsEnabled(enabled));
        }
    }

    @JavascriptInterface
    public void setRealtimeNotifications(boolean enabled, boolean questionsEnabled) {
        if (activity instanceof MainActivity) activity.runOnUiThread(
            () -> ((MainActivity) activity).setRealtimeNotifications(enabled, questionsEnabled));
    }

    @JavascriptInterface
    public void openTaskNotificationSettings() {
        if (activity instanceof MainActivity && ((MainActivity) activity).trustedTaskNotificationPage()) {
            activity.runOnUiThread(() -> ((MainActivity) activity).openTaskNotificationSettings());
        }
    }

    @JavascriptInterface
    public void openLiveUpdateSettings() {
        if (activity instanceof MainActivity) activity.runOnUiThread(() -> ((MainActivity) activity).openLiveUpdateSettings());
    }

    @JavascriptInterface
    public void setBackgroundNotifications(boolean enabled, boolean questionsEnabled) {
        if (activity instanceof MainActivity) activity.runOnUiThread(() -> ((MainActivity) activity).setBackgroundNotifications(enabled,questionsEnabled));
    }

    @JavascriptInterface
    public void setBackgroundQuestionAlerts(boolean enabled) {
        if (activity instanceof MainActivity) activity.runOnUiThread(() -> ((MainActivity) activity).setBackgroundQuestionAlerts(enabled));
    }

    @JavascriptInterface
    public void updateTaskNotification(final String json) {
        if (activity instanceof MainActivity && ((MainActivity) activity).trustedTaskNotificationPage()
                && json != null && json.length() <= 4096) {
            activity.runOnUiThread(() -> ((MainActivity) activity).updateTaskNotification(json));
        }
    }

    @JavascriptInterface
    public void taskNotificationOpened(final String threadId) {
        if (activity instanceof MainActivity && ((MainActivity) activity).trustedTaskNotificationPage()
                && TaskNotificationState.validId(threadId)) {
            activity.runOnUiThread(() -> ((MainActivity) activity).taskNotificationOpened(threadId));
        }
    }

    @JavascriptInterface
    public String getQuestionNotificationStatus() {
        return activity instanceof MainActivity
            ? ((MainActivity) activity).getQuestionNotificationStatus() : "unsupported";
    }

    @JavascriptInterface
    public void requestQuestionNotificationPermission() {
        if (activity instanceof MainActivity && ((MainActivity) activity).trustedTaskNotificationPage()) {
            activity.runOnUiThread(() -> ((MainActivity) activity).requestQuestionNotificationPermission());
        }
    }

    @JavascriptInterface
    public void updateQuestionNotification(final String json) {
        if (activity instanceof MainActivity && ((MainActivity) activity).trustedTaskNotificationPage()
                && json != null && json.length() <= 4096) {
            activity.runOnUiThread(() -> ((MainActivity) activity).updateQuestionNotification(json));
        }
    }

    @JavascriptInterface
    public void offlineSnapshotReady() {
        if (activity instanceof MainActivity && ((MainActivity) activity).trustedTaskNotificationPage()) {
            activity.runOnUiThread(() -> ((MainActivity) activity).offlineSnapshotReady());
        }
    }

    @JavascriptInterface
    public boolean saveProjectFile(String scopeJson, String path, String name) {
        return activity instanceof MainActivity && ((MainActivity) activity).saveProjectFile(scopeJson, path, name);
    }

    @JavascriptInterface
    public boolean copyToClipboard(final String text) {
        if (activity == null || text == null || activity.isFinishing() || activity.isDestroyed()) {
            return false;
        }
        final AtomicBoolean copied = new AtomicBoolean(false);
        final Runnable task = () -> {
            try {
                ClipboardManager clipboard = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
                if (clipboard == null) {
                    return;
                }
                ClipData clip = ClipData.newPlainText("码舱 CodeCang", text);
                clipboard.setPrimaryClip(clip);
                copied.set(true);
            } catch (Exception ignored) {
                copied.set(false);
            }
        };

        if (Looper.myLooper() == Looper.getMainLooper()) {
            task.run();
            return copied.get();
        }

        final CountDownLatch latch = new CountDownLatch(1);
        activity.runOnUiThread(() -> {
            try {
                task.run();
            } finally {
                latch.countDown();
            }
        });
        try {
            if (!latch.await(2, TimeUnit.SECONDS)) {
                return false;
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
        return copied.get();
    }

    @JavascriptInterface
    public void checkForUpdates() {
        if (activity instanceof MainActivity) {
            MainActivity window = (MainActivity) activity;
            window.runOnUiThread(() -> {
                if (window.trustedTaskNotificationPage()) AppUpdateChecker.checkNow(window);
            });
        }
    }

    @JavascriptInterface
    public String getAppUpdateStatus() {
        return activity instanceof MainActivity && ((MainActivity) activity).trustedTaskNotificationPage()
            ? AppUpdateChecker.webStatus() : "{\"phase\":\"idle\"}";
    }

    @JavascriptInterface
    public void openAppUpdate() {
        if (!(activity instanceof MainActivity)) return;
        MainActivity window = (MainActivity) activity;
        window.runOnUiThread(() -> {
            if (window.trustedTaskNotificationPage() && window.hasWindowFocus()) AppUpdateChecker.showCurrent(window);
        });
    }

    @JavascriptInterface
    public String getAppVersion() {
        return "0.4.23";
    }

    @JavascriptInterface
    public boolean isNativeApp() {
        return true;
    }

    @JavascriptInterface
    public String getToken() {
        if (activity instanceof MainActivity) {
            return ((MainActivity) activity).getCurrentToken();
        }
        return "";
    }
}
