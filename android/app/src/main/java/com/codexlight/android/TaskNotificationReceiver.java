package com.codexlight.android;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import java.util.LinkedHashSet;
import java.util.Set;

/** Explicit, non-exported receiver for dismissal and the user-requested Unpin action. */
public final class TaskNotificationReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !TaskNotificationController.ACTION_DISMISS.equals(intent.getAction())) return;
        String threadId = intent.getStringExtra("threadId");
        String turnId = intent.getStringExtra("turnId");
        if (!TaskNotificationState.validId(threadId) || !TaskNotificationState.validId(turnId)) return;
        suppress(context, threadId, turnId);
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.cancel(TaskNotificationController.TAG, intent.getIntExtra("notificationId", -1));
    }

    static void suppress(Context context, String threadId, String turnId) {
        SharedPreferences prefs = context.getSharedPreferences(TaskNotificationController.PREFS, Context.MODE_PRIVATE);
        Set<String> dismissed = new LinkedHashSet<>(prefs.getStringSet("dismissed", new LinkedHashSet<>()));
        dismissed.add(threadId + "\n" + turnId);
        while (dismissed.size() > 32) dismissed.remove(dismissed.iterator().next());
        prefs.edit().putStringSet("dismissed", dismissed).apply();
    }
}
