package com.codexlight.android;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import java.util.Collections;
import java.util.Set;

/** Dismissing a single turn never interrupts the task on its host. */
public final class TaskNotificationReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !TaskNotificationController.ACTION_DISMISS.equals(intent.getAction())) return;
        String threadId = intent.getStringExtra("threadId");
        String turnId = intent.getStringExtra("turnId");
        if (!TaskNotificationState.validId(threadId) || !TaskNotificationState.validId(turnId)) return;
        String origin = intent.getStringExtra("origin");
        if (origin == null || !origin.equals(TaskNotificationController.get(context).origin())) return;
        TaskNotificationController.get(context).dismiss(threadId, turnId, intent.getIntExtra("notificationId", -1));
    }

    static void suppress(Context context, String origin, String threadId, String turnId) {
        SharedPreferences prefs = context.getSharedPreferences(TaskNotificationController.PREFS, Context.MODE_PRIVATE);
        Set<String> dismissed = TaskNotificationState.ignoring(prefs.getStringSet("dismissed", Collections.emptySet()),origin,threadId,turnId);
        prefs.edit().putStringSet("dismissed", dismissed).apply();
    }
}
