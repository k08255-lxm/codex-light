package com.codexlight.android;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;

/** Public API 36 methods, looked up to preserve the offline API 34 build. */
final class AndroidLiveUpdates {
    private static final String SETTINGS_ACTION = "android.settings.APP_NOTIFICATION_PROMOTION_SETTINGS";
    private static final int PROMOTED_FLAG = 0x00040000;

    private AndroidLiveUpdates() {}

    static boolean isAllowed(NotificationManager manager) {
        return callBoolean(NotificationManager.class, manager, "canPostPromotedNotifications");
    }

    static boolean isEligible(Notification notification) {
        return callBoolean(Notification.class, notification, "hasPromotableCharacteristics");
    }

    static boolean isPromoted(Notification notification) { return (notification.flags & PROMOTED_FLAG) != 0; }

    private static boolean callBoolean(Class<?> type, Object target, String method) {
        try { return Boolean.TRUE.equals(type.getMethod(method).invoke(target)); }
        catch (ReflectiveOperationException | SecurityException unavailable) { return false; }
    }

    static boolean openSettings(Activity activity) {
        Intent intent = new Intent(SETTINGS_ACTION, Uri.parse("package:" + activity.getPackageName()))
            .putExtra(Settings.EXTRA_APP_PACKAGE, activity.getPackageName());
        try { activity.startActivity(intent); return true; }
        catch (ActivityNotFoundException | SecurityException unavailable) { return false; }
    }
}
