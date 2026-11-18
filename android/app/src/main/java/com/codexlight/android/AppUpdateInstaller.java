package com.codexlight.android;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.Arrays;
import java.util.HashSet;

final class AppUpdateInstaller {
    static boolean canInstall(Context context) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.getPackageManager().canRequestPackageInstalls();
    }

    static void verifyArchive(Context context, File file, String version) throws IOException, PackageManager.NameNotFoundException {
        PackageManager manager = context.getPackageManager();
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo installed = manager.getPackageInfo(context.getPackageName(), flags);
        PackageInfo update = manager.getPackageArchiveInfo(file.getAbsolutePath(), flags);
        if (update == null || !context.getPackageName().equals(update.packageName)) throw new AppUpdateTransport.Failure("APK 包名与当前应用不匹配");
        if (!version.equals(update.versionName) || AppUpdateTransport.compareVersions(version, installed.versionName) <= 0 ||
            versionCode(update) <= versionCode(installed)) throw new AppUpdateTransport.Failure("APK 版本与发布信息不匹配，或未高于当前版本");
        Signature[] current = signers(installed), downloaded = signers(update);
        if (current == null || downloaded == null || current.length == 0 || current.length != downloaded.length ||
            !new HashSet<>(Arrays.asList(current)).equals(new HashSet<>(Arrays.asList(downloaded)))) {
            throw new AppUpdateTransport.Failure("APK 签名与当前应用不一致，请使用原安装来源的更新包");
        }
    }

    private static Signature[] signers(PackageInfo info) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return info.signatures;
        return info.signingInfo == null ? null : info.signingInfo.getApkContentsSigners();
    }

    private static long versionCode(PackageInfo info) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
    }

    static int stage(Context context, File file, AppUpdateTransport.Release release) throws IOException {
        if (!canInstall(context)) throw new AppUpdateTransport.Failure("请先允许码舱安装未知应用");
        PackageInstaller installer = context.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(context.getPackageName());
        params.setSize(release.apk.size);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED);
        }
        int sessionId = installer.createSession(params);
        boolean staged = false;
        try (PackageInstaller.Session session = installer.openSession(sessionId)) {
            try (FileInputStream input = new FileInputStream(file); OutputStream output = session.openWrite("base.apk", 0, release.apk.size)) {
                // Recheck exactly the bytes sent to Android even after a successful download.
                AppUpdateTransport.copyVerified(release, input, output, ignored -> {}, () -> false);
                session.fsync(output);
            }
            staged = true;
            return sessionId;
        } finally {
            if (!staged) abandon(context, sessionId);
        }
    }

    static void commit(Context context, int sessionId, String token) throws IOException {
        Intent callback = new Intent(context, AppUpdateChecker.InstallResult.class);
        callback.putExtra(AppUpdateChecker.INSTALL_TOKEN, token);
        int flags = PendingIntent.FLAG_CANCEL_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags |= PendingIntent.FLAG_MUTABLE;
        PendingIntent pending = PendingIntent.getBroadcast(context, sessionId, callback, flags);
        try (PackageInstaller.Session session = context.getPackageManager().getPackageInstaller().openSession(sessionId)) {
            session.commit(pending.getIntentSender());
        } catch (IOException | RuntimeException error) {
            pending.cancel();
            throw error;
        }
    }

    static void abandon(Context context, int sessionId) {
        if (sessionId < 0) return;
        try { context.getPackageManager().getPackageInstaller().abandonSession(sessionId); }
        catch (SecurityException | IllegalArgumentException finished) { /* The system already closed this session. */ }
    }
}
