package com.codexlight.android;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import java.io.File;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/** Foreground checks and user-initiated download and install, independent of the paired computer. */
public final class AppUpdateChecker {
    static final String INSTALL_TOKEN = "com.codexlight.android.UPDATE_INSTALL_TOKEN";
    private static final long CHECK_INTERVAL = 6 * 60 * 60 * 1000L;
    private static final long TICK_INTERVAL = 10 * 60 * 1000L;
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final ExecutorService WORKER = Executors.newSingleThreadExecutor(task -> new Thread(task, "app-update"));
    private enum Phase { IDLE, CHECKING, AVAILABLE, UP_TO_DATE, DOWNLOADING, VERIFYING, READY, FAILED, AUTHORIZING, STAGING, CONFIRM, INSTALLING, INSTALLED }
    private static Phase phase = Phase.IDLE;
    private static Activity active;
    private static AlertDialog dialog;
    private static ProgressBar progress;
    private static TextView progressLabel;
    private static boolean present;
    private static boolean manualCheck;
    private static volatile int generation;
    private static AppUpdateTransport.Release release;
    private static File prepared;
    private static long received;
    private static String problem;
    private static String installToken;
    private static int installSession = -1;
    private static Intent systemConfirmation;
    private static volatile String webStatus = "{\"phase\":\"idle\"}";

    private static final Runnable TICK = new Runnable() {
        @Override public void run() {
            if (!foreground()) return;
            check(active, false);
            MAIN.postDelayed(this, TICK_INTERVAL);
        }
    };

    public static void start(Activity activity) {
        active = activity;
        MAIN.removeCallbacks(TICK);
        if (phase == Phase.AUTHORIZING) {
            phase = Phase.READY;
            if (AppUpdateInstaller.canInstall(activity)) {
                stageInstall(activity);
            } else {
                problem = "尚未允许码舱安装未知应用。你可以稍后再授权。";
                present = true;
            }
        }
        render();
        MAIN.post(TICK);
    }

    public static void stop(Activity activity) {
        if (active != activity) return;
        active = null;
        MAIN.removeCallbacks(TICK);
        dismiss();
    }

    public static void checkNow(Activity activity) {
        check(activity, true);
    }

    static String webStatus() { return webStatus; }

    static void showCurrent(Activity activity) {
        if (active != activity || !foreground() || !hasAvailableRelease()) return;
        present = true;
        render();
    }

    private static boolean hasAvailableRelease() {
        return release != null && phase != Phase.INSTALLED && phase != Phase.UP_TO_DATE;
    }

    private static void publishWebStatus() {
        String change = "{\"phase\":" + JSONObject.quote(phase.name().toLowerCase(Locale.ROOT))
            + (hasAvailableRelease() ? ",\"version\":" + JSONObject.quote(release.version) : "") + "}";
        if (change.equals(webStatus)) return;
        webStatus = change;
        if (active instanceof MainActivity) ((MainActivity) active).notifyAppUpdateStatus();
    }

    private static void check(Activity activity, boolean manual) {
        if (active != activity || !foreground()) return;
        if (busy()) {
            if (manual) {
                if (phase == Phase.CHECKING) manualCheck = true;
                present = true;
                render();
            }
            return;
        }
        if (!manual && (present || phase == Phase.CONFIRM)) return;
        if (phase == Phase.CONFIRM) { present = true; render(); return; }
        Context context = activity.getApplicationContext();
        SharedPreferences prefs = prefs(context);
        long since = System.currentTimeMillis() - prefs.getLong("checked", 0);
        // On process restart, regain the validated release details for a previously advertised APK.
        boolean restoreAvailable = phase == Phase.IDLE && prefs.getBoolean("had_available_release", false);
        if (!manual && !restoreAvailable && since >= 0 && since < CHECK_INTERVAL) return;
        Phase previous = phase;
        manualCheck = manual;
        present = manual;
        phase = Phase.CHECKING;
        problem = null;
        render();
        WORKER.execute(() -> {
            try {
                String current = context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
                AppUpdateTransport.Release latest = AppUpdateTransport.check(current);
                MAIN.post(() -> checked(prefs, latest));
            } catch (Exception error) {
                MAIN.post(() -> {
                    phase = manualCheck ? Phase.FAILED : previous;
                    if (manualCheck) problem = reason(error, "无法获取 Android 更新信息，请检查网络后重试。");
                    render();
                });
            }
        });
    }

    private static void checked(SharedPreferences prefs, AppUpdateTransport.Release latest) {
        if (latest == null || !latest.matches(release) || (prepared != null && !prepared.isFile())) discardPrepared();
        release = latest;
        prefs.edit().putLong("checked", System.currentTimeMillis()).putBoolean("had_available_release",latest != null).apply();
        phase = latest == null ? Phase.UP_TO_DATE : prepared == null ? Phase.AVAILABLE : Phase.READY;
        if (!manualCheck) present = latest != null && !latest.version.equals(prefs.getString("notified", ""));
        render();
    }

    private static boolean busy() {
        return phase == Phase.CHECKING || phase == Phase.DOWNLOADING || phase == Phase.VERIFYING ||
            phase == Phase.AUTHORIZING || phase == Phase.STAGING || phase == Phase.INSTALLING;
    }

    private static void beginDownload() {
        if (!foreground() || phase != Phase.AVAILABLE || release == null) return;
        Context context = active.getApplicationContext();
        AppUpdateTransport.Release selected = release;
        discardPrepared();
        int ticket = ++generation;
        received = 0;
        problem = null;
        phase = Phase.DOWNLOADING;
        present = true;
        render();
        WORKER.execute(() -> {
            File candidate = null;
            try {
                File folder = new File(context.getCacheDir(), "app-updates");
                if (!folder.isDirectory() && !folder.mkdir()) throw new AppUpdateTransport.Failure("无法建立 APK 缓存目录");
                File[] stale = folder.listFiles((directory, name) -> name.startsWith("update-") && name.endsWith(".apk"));
                if (stale != null) for (File file : stale) file.delete();
                if (folder.getUsableSpace() < selected.apk.size) throw new AppUpdateTransport.Failure("可用存储空间不足");
                candidate = File.createTempFile("update-", ".apk", folder);
                long[] nextProgress = {0};
                AppUpdateTransport.download(selected, candidate, bytes -> {
                    long now = SystemClock.elapsedRealtime();
                    if (bytes != selected.apk.size && now < nextProgress[0]) return;
                    nextProgress[0] = now + 120;
                    MAIN.post(() -> {
                        if (generation != ticket || phase != Phase.DOWNLOADING) return;
                        received = bytes;
                        renderProgress();
                    });
                }, () -> generation != ticket);
                if (generation != ticket) return;
                MAIN.post(() -> {
                    if (generation != ticket) return;
                    phase = Phase.VERIFYING;
                    render();
                });
                AppUpdateInstaller.verifyArchive(context, candidate, selected.version);
                File verified = candidate;
                candidate = null;
                MAIN.post(() -> {
                    if (generation != ticket) { verified.delete(); return; }
                    prepared = verified;
                    phase = Phase.READY;
                    render();
                });
            } catch (Exception error) {
                MAIN.post(() -> {
                    if (generation != ticket) return;
                    phase = Phase.AVAILABLE;
                    problem = reason(error, "下载或核验 APK 失败，请重试。");
                    render();
                });
            } finally {
                if (candidate != null) candidate.delete();
            }
        });
    }

    private static void cancelDownload() {
        generation++;
        phase = Phase.AVAILABLE;
        problem = "已取消下载。";
        render();
    }

    private static void discardPrepared() {
        if (prepared != null) prepared.delete();
        prepared = null;
    }

    private static void requestInstall() {
        if (!foreground() || phase != Phase.READY || prepared == null) return;
        Activity activity = active;
        if (AppUpdateInstaller.canInstall(activity)) { stageInstall(activity); return; }
        try {
            phase = Phase.AUTHORIZING;
            publishWebStatus();
            dismiss();
            activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.fromParts("package", activity.getPackageName(), null)));
        } catch (RuntimeException unavailable) {
            phase = Phase.READY;
            problem = "系统未打开安装来源设置。请在系统设置中允许码舱安装未知应用。";
            render();
        }
    }

    private static void stageInstall(Activity activity) {
        if (release == null || prepared == null) return;
        Context context = activity.getApplicationContext();
        File file = prepared;
        AppUpdateTransport.Release selected = release;
        String token = UUID.randomUUID().toString();
        installToken = token;
        phase = Phase.STAGING;
        present = true;
        problem = null;
        render();
        WORKER.execute(() -> {
            try {
                int sessionId = AppUpdateInstaller.stage(context, file, selected);
                MAIN.post(() -> {
                    installSession = sessionId;
                    openInstaller(context, sessionId, token);
                });
            } catch (Exception error) {
                MAIN.post(() -> installFailed(context, reason(error, "系统无法准备安装，请重新下载后重试。"), true));
            }
        });
    }

    private static void openInstaller(Context context, int sessionId, String token) {
        WORKER.execute(() -> {
            try {
                AppUpdateInstaller.commit(context, sessionId, token);
                MAIN.postDelayed(() -> {
                    if (phase == Phase.STAGING && token.equals(installToken)) {
                        installFailed(context, "系统安装器未响应。请重试。", false);
                    }
                }, 30000);
            } catch (Exception error) {
                MAIN.post(() -> installFailed(context, "系统未接收安装请求，请重试。", false));
            }
        });
    }

    public static final class InstallResult extends BroadcastReceiver {
        @Override public void onReceive(Context context, Intent result) {
            if (installToken == null || !installToken.equals(result.getStringExtra(INSTALL_TOKEN)) ||
                installSession != result.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1)) return;
            int status = result.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
            if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                if (phase != Phase.STAGING) return;
                systemConfirmation = Build.VERSION.SDK_INT >= 33 ? result.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class)
                    : result.getParcelableExtra(Intent.EXTRA_INTENT);
                if (systemConfirmation == null) { installFailed(context, "系统未提供安装确认界面。", false); return; }
                phase = Phase.CONFIRM;
                if (foreground()) confirmInSystem();
            } else if (status == PackageInstaller.STATUS_SUCCESS) {
                resetInstall();
                discardPrepared();
                phase = Phase.INSTALLED;
                present = true;
                render();
            } else if (status == PackageInstaller.STATUS_FAILURE_ABORTED) {
                installFailed(context, "已取消安装。安装包仍可使用。", false);
            } else if (status == PackageInstaller.STATUS_FAILURE_BLOCKED) {
                installFailed(context, "Android 阻止了安装。请检查此应用的安装来源授权或设备限制。", false);
            } else {
                installFailed(context, "Android 未能安装更新（状态 " + status + "）。", false);
            }
        }
    }

    private static void confirmInSystem() {
        if (!foreground() || phase != Phase.CONFIRM || systemConfirmation == null) return;
        Intent confirmation = systemConfirmation;
        systemConfirmation = null;
        phase = Phase.INSTALLING;
        publishWebStatus();
        present = false;
        dismiss();
        try { active.startActivity(confirmation); }
        catch (RuntimeException unavailable) { installFailed(active, "无法打开系统安装确认界面。", false); }
    }

    private static void installFailed(Context context, String message, boolean removePackage) {
        AppUpdateInstaller.abandon(context, installSession);
        resetInstall();
        if (removePackage) discardPrepared();
        phase = prepared == null ? Phase.AVAILABLE : Phase.READY;
        problem = message;
        present = true;
        render();
    }

    private static void resetInstall() {
        installSession = -1;
        installToken = null;
        systemConfirmation = null;
    }

    private static void dismiss() {
        if (dialog != null) dialog.dismiss();
        dialog = null;
        progress = null;
        progressLabel = null;
    }

    private static void render() {
        publishWebStatus();
        dismiss();
        if (!foreground() || !present) return;
        Activity activity = active;
        AlertDialog.Builder builder = new AlertDialog.Builder(activity);
        switch (phase) {
            case CHECKING:
                builder.setTitle("检查更新").setMessage("正在检查 Android 更新…").setNegativeButton("隐藏", (d, w) -> present = false);
                break;
            case AVAILABLE:
                prefs(activity).edit().putString("notified", release.version).apply();
                builder.setTitle("码舱 CodeCang v" + release.version + " 可用")
                    .setMessage(problem != null ? problem : "点击下载更新。完成校验后可通过 Android 系统安装器安装。")
                    .setNegativeButton("稍后", (d, w) -> present = false).setPositiveButton("下载更新", (d, w) -> beginDownload());
                break;
            case UP_TO_DATE:
                builder.setTitle("检查更新").setMessage("暂无可用的 Android 新版本。")
                    .setPositiveButton("知道了", (d, w) -> present = false);
                break;
            case DOWNLOADING:
                builder.setTitle("正在下载 v" + release.version).setView(downloadView(activity)).setCancelable(false)
                    .setNegativeButton("取消下载", (d, w) -> cancelDownload());
                break;
            case VERIFYING:
                builder.setTitle("正在校验安装包").setMessage("正在核验 APK 的签名、包名和版本。")
                    .setNegativeButton("隐藏", (d, w) -> present = false);
                break;
            case READY:
                builder.setTitle("更新已下载并校验").setMessage(problem != null ? problem : "v" + release.version + " 已就绪。继续后在 Android 系统中确认安装。")
                    .setNegativeButton("稍后", (d, w) -> present = false).setPositiveButton("打开系统安装器", (d, w) -> requestInstall());
                break;
            case STAGING:
                builder.setTitle("正在准备安装").setMessage("正在把已经校验的 APK 交给 Android 系统安装器。")
                    .setNegativeButton("隐藏", (d, w) -> present = false);
                break;
            case CONFIRM:
                builder.setTitle("确认安装更新").setMessage("更新已交给 Android 系统安装器。")
                    .setNegativeButton("稍后", (d, w) -> present = false).setPositiveButton("继续", (d, w) -> confirmInSystem());
                break;
            case INSTALLING:
                builder.setTitle("等待系统安装").setMessage("请在 Android 系统安装界面确认或取消。")
                    .setPositiveButton("知道了", (d, w) -> present = false);
                break;
            case INSTALLED:
                builder.setTitle("更新已安装").setPositiveButton("知道了", (d, w) -> present = false);
                break;
            case FAILED:
                builder.setTitle("检查更新失败").setMessage(problem).setNegativeButton("知道了", (d, w) -> present = false)
                    .setPositiveButton("重试", (d, w) -> checkNow(activity));
                break;
            default: return;
        }
        dialog = builder.setOnCancelListener(d -> present = false).show();
        renderProgress();
    }

    private static LinearLayout downloadView(Activity activity) {
        LinearLayout panel = new LinearLayout(activity);
        panel.setOrientation(LinearLayout.VERTICAL);
        int inset = (int) (24 * activity.getResources().getDisplayMetrics().density + .5f);
        panel.setPadding(inset, inset / 2, inset, inset / 2);
        progress = new ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        progress.setContentDescription("安装包下载进度");
        progressLabel = new TextView(activity);
        panel.addView(progress, new LinearLayout.LayoutParams(-1, -2));
        panel.addView(progressLabel, new LinearLayout.LayoutParams(-1, -2));
        return panel;
    }

    private static void renderProgress() {
        if (progress == null || release == null) return;
        progress.setProgress((int) (100 * received / release.apk.size));
        progressLabel.setText(String.format(Locale.getDefault(), "%.1f / %.1f MB", received / 1048576.0, release.apk.size / 1048576.0));
    }

    private static boolean foreground() { return active != null && !active.isFinishing() && !active.isDestroyed(); }
    private static SharedPreferences prefs(Context context) { return context.getSharedPreferences("app_updates", Context.MODE_PRIVATE); }
    private static String reason(Exception error, String fallback) { return error instanceof AppUpdateTransport.Failure ? error.getMessage() : fallback; }
}
