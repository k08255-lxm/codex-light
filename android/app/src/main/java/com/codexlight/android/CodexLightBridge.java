package com.codexlight.android;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
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
    public void openServerManager() {
        if (activity == null) return;
        activity.runOnUiThread(() -> {
            Intent intent = new Intent(activity, ServerConnectActivity.class);
            activity.startActivity(intent);
            activity.finish();
        });
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
    public String getAppVersion() {
        return "0.4.4";
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
