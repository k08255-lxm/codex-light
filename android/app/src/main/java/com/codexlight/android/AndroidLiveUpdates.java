package com.codexlight.android;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.os.Build;
import android.provider.Settings;

/** Only called on API 36 and above. */
final class AndroidLiveUpdates {
    private AndroidLiveUpdates() {}

    static boolean isAllowed(NotificationManager manager) {
        return manager.canPostPromotedNotifications();
    }

    static boolean isEligible(Notification notification) {
        return notification.hasPromotableCharacteristics();
    }

    static boolean isPromoted(Notification notification) {
        return (notification.flags & Notification.FLAG_PROMOTED_ONGOING) != 0;
    }

    static Notification buildRunning(Notification.Builder builder, TaskNotificationState.Entry entry) {
        if (entry.total > 0) {
            Notification.ProgressStyle progress = new Notification.ProgressStyle()
                .addProgressSegment(new Notification.ProgressStyle.Segment(entry.total)).setProgress(entry.done);
            builder.setStyle(progress);
        } else if ("running".equals(entry.state)) {
            builder.setStyle(new Notification.ProgressStyle().setProgressIndeterminate(true));
        }
        builder.setShortCriticalText(entry.phaseLabel());
        // The public extra was named in SDK 36.1. It can also be supplied on 36.0.
        builder.getExtras().putBoolean("android.requestPromotedOngoing", true);
        Notification notification = builder.build();
        if (Build.VERSION.SDK_INT == 36 && !isEligible(notification)) {
            // Android 16's initial release required colorization. Later builds reject it.
            // Use the legacy version only when this device's eligibility check accepts it.
            Notification legacy = notification.clone();
            legacy.extras.putBoolean(Notification.EXTRA_COLORIZED, true);
            if (isEligible(legacy)) return legacy;
        }
        return notification;
    }

    static boolean openSettings(Activity activity) {
        Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_PROMOTION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, activity.getPackageName());
        try { activity.startActivity(intent); return true; }
        catch (ActivityNotFoundException | SecurityException unavailable) { return false; }
    }
}
