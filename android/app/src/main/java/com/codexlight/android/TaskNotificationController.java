package com.codexlight.android;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.widget.Toast;
import org.json.JSONException;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.Set;

/** Posts verified task states using public Android notification APIs. */
final class TaskNotificationController {
    static final String PREFS = "task_notifications";
    static final String ACTION_OPEN = "com.codexlight.android.OPEN_TASK";
    static final String ACTION_DISMISS = "com.codexlight.android.DISMISS_TASK";
    static final String TAG = "monitored_task";
    static final int PERMISSION_REQUEST = 1002;
    private static final String CHANNEL = "monitored_tasks";
    private static TaskNotificationController instance;
    private final Context context;
    private final NotificationManager manager;
    private final SharedPreferences prefs;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final TaskNotificationState tasks = new TaskNotificationState();
    private final Runnable expire = this::expireTasks;

    static TaskNotificationController get(Context context) {
        if (instance == null) instance = new TaskNotificationController(context.getApplicationContext());
        return instance;
    }

    private TaskNotificationController(Context context) {
        this.context = context;
        manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (Build.VERSION.SDK_INT >= 26 && manager != null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "任务状态", NotificationManager.IMPORTANCE_DEFAULT);
            channel.setDescription("你主动开启的运行任务监控，以及任务完成、失败和等待回答提醒");
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }
    }

    String status() {
        boolean enabled = prefs.getBoolean("enabled", false);
        boolean permission = permissionGranted();
        int importance = channelImportance();
        String reason = !enabled ? "disabled" : !permission ? "permission_required"
            : importance == NotificationManager.IMPORTANCE_NONE ? "channel_blocked" : "ready";
        try {
            return new JSONObject().put("supported", manager != null).put("enabled", enabled).put("supportsTaskPhase", true)
                .put("permissionGranted", permission).put("promotedCandidate", Build.VERSION.SDK_INT >= 36)
                .put("promotion", promotionStatus(reason, importance))
                .put("background", MobileNotificationService.status()).put("reason", reason).toString();
        } catch (JSONException impossible) { return "{\"supported\":false}"; }
    }

    private int channelImportance() {
        if (Build.VERSION.SDK_INT < 26 || manager == null) return NotificationManager.IMPORTANCE_DEFAULT;
        NotificationChannel channel = manager.getNotificationChannel(CHANNEL);
        return channel == null ? NotificationManager.IMPORTANCE_NONE : channel.getImportance();
    }

    boolean permissionGranted() {
        return manager != null && manager.areNotificationsEnabled()
            && (Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED);
    }

    void setEnabled(boolean enabled, Activity activity) {
        prefs.edit().putBoolean("enabled", enabled).apply();
        if (!enabled) { clear(); return; }
        if (Build.VERSION.SDK_INT >= 33 && activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            activity.requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, PERMISSION_REQUEST);
        } else if (!permissionGranted()) {
            Toast.makeText(activity, "请在系统通知设置中允许任务通知", Toast.LENGTH_LONG).show();
        }
    }

    void openSettings(Activity activity) {
        Intent intent;
        if (Build.VERSION.SDK_INT >= 26) {
            boolean channelSettings = permissionGranted() && channelImportance() <= NotificationManager.IMPORTANCE_MIN;
            intent = new Intent(channelSettings ? Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS : Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, activity.getPackageName());
            if (channelSettings) intent.putExtra(Settings.EXTRA_CHANNEL_ID, CHANNEL);
        } else {
            intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:" + activity.getPackageName()));
        }
        try { activity.startActivity(intent); }
        catch (ActivityNotFoundException | SecurityException unavailable) {
            Toast.makeText(activity,"无法打开系统通知设置",Toast.LENGTH_SHORT).show();
        }
    }

    void openPromotionSettings(Activity activity) {
        if (Build.VERSION.SDK_INT >= 36 && AndroidLiveUpdates.openSettings(activity)) return;
        Toast.makeText(activity, "此系统没有独立的实时通知设置，正在打开应用通知设置", Toast.LENGTH_LONG).show();
        openSettings(activity);
    }

    private String promotionStatus(String reason, int importance) {
        if (manager == null || Build.VERSION.SDK_INT < 36) return "unsupported";
        if (!"ready".equals(reason)) return reason;
        if (importance == NotificationManager.IMPORTANCE_MIN) return "channel_min";
        if (!AndroidLiveUpdates.isAllowed(manager)) return "blocked";
        String status = "ready";
        for (android.service.notification.StatusBarNotification posted : manager.getActiveNotifications()) {
            Notification notification = posted.getNotification();
            if (!TAG.equals(posted.getTag()) || (notification.flags & Notification.FLAG_ONGOING_EVENT) == 0) continue;
            if (AndroidLiveUpdates.isPromoted(notification)) return "promoted";
            if (AndroidLiveUpdates.isEligible(notification)) status = "standard";
            else if ("ready".equals(status)) status = "ineligible";
        }
        return status;
    }

    void update(String json) {
        if (!prefs.getBoolean("enabled", false) || !permissionGranted() || json == null || json.length() > 4096) return;
        try {
            JSONObject data = new JSONObject(json);
            if (data.length() > 5) return;
            Iterator<String> keys = data.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                if (!"threadId".equals(key) && !"turnId".equals(key) && !"title".equals(key)
                        && !"state".equals(key) && !"phase".equals(key)) return;
                if (!(data.get(key) instanceof String)) return;
            }
            String threadId = data.optString("threadId", "");
            String state = data.optString("state", "");
            String phase = data.optString("phase", null);
            if (!TaskNotificationState.validId(threadId) || !TaskNotificationState.validState(state)
                    || !TaskNotificationState.validPhase(state, phase)) return;
            if ("idle".equals(state)) {
                TaskNotificationState.Entry removed = tasks.entries.remove(threadId);
                if (removed != null) manager.cancel(TAG, removed.notificationId);
                return;
            }
            String turnId = data.optString("turnId", "");
            String title = data.optString("title", "");
            if (!TaskNotificationState.validId(turnId) || !TaskNotificationState.validTitle(title)) return;
            if (prefs.getStringSet("dismissed", Collections.emptySet()).contains(threadId + "\n" + turnId)) return;
            // Expire old entries before enforcing the three-task cap.
            expireTasks();
            TaskNotificationState.Entry old = tasks.entries.get(threadId);
            if (old == null && tasks.entries.size() >= TaskNotificationState.MAX_TASKS) {
                for (TaskNotificationState.Entry entry : new ArrayList<>(tasks.entries.values())) {
                    if (!entry.active()) { tasks.entries.remove(entry.threadId); manager.cancel(TAG, entry.notificationId); break; }
                }
            }
            long now = SystemClock.elapsedRealtime();
            TaskNotificationState.Entry entry = tasks.update(threadId, turnId, title, state, phase, now);
            if (entry != null && entry.needsPost(now)) post(entry);
            scheduleExpiry();
        } catch (JSONException invalid) {
            android.util.Log.w("TaskNotifications", "Rejected invalid task notification JSON");
        }
    }

    void updateFromFeed(JSONObject task) {
        String threadId = task.optString("threadId");
        String turnId = task.optString("turnId");
        String state = task.optString("state");
        if (!TaskNotificationState.validId(threadId) || !TaskNotificationState.validId(turnId)
                || !TaskNotificationState.validState(state)) return;
        TaskNotificationState.Entry previous = tasks.entries.get(threadId);
        String title = previous == null ? "Codex 任务" : previous.title;
        try {
            update(new JSONObject().put("threadId",threadId).put("turnId",turnId)
                .put("state",state).put("phase",task.opt("phase")).put("title",title).toString());
        } catch (JSONException impossible) { throw new IllegalStateException(impossible); }
    }

    private void post(TaskNotificationState.Entry entry) {
        if (!permissionGranted() || prefs.getStringSet("dismissed", Collections.emptySet()).contains(entry.key())) return;
        boolean running = "running".equals(entry.state);
        // API 24-25 cannot expire notifications after process death. Never pin live state there.
        if (running && Build.VERSION.SDK_INT < 26) return;
        Intent open = new Intent(context, MainActivity.class).setAction(ACTION_OPEN)
            .setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra("threadId", entry.threadId).putExtra("turnId", entry.turnId);
        Intent dismiss = new Intent(context, TaskNotificationReceiver.class).setAction(ACTION_DISMISS)
            .putExtra("threadId", entry.threadId).putExtra("turnId", entry.turnId)
            .putExtra("notificationId", entry.notificationId);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent contentIntent = PendingIntent.getActivity(context, entry.notificationId, open, flags);
        PendingIntent deleteIntent = PendingIntent.getBroadcast(context, entry.notificationId, dismiss, flags);
        String text = message(entry);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(context, CHANNEL) : new Notification.Builder(context);
        builder.setSmallIcon(R.drawable.ic_task_notification)
            .setContentTitle(entry.title).setContentText(text)
            .setStyle(new Notification.BigTextStyle().bigText(text))
            .setCategory(running ? Notification.CATEGORY_PROGRESS : Notification.CATEGORY_STATUS)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setOnlyAlertOnce(true).setShowWhen(false).setOngoing(running).setAutoCancel(!running)
            .setContentIntent(contentIntent).setDeleteIntent(deleteIntent);
        if (running) builder.addAction(new Notification.Action.Builder(
            android.graphics.drawable.Icon.createWithResource(context, R.drawable.ic_launcher_foreground),
            "取消固定", deleteIntent).build());
        if (Build.VERSION.SDK_INT >= 26) {
            builder.setTimeoutAfter(entry.active() ? TaskNotificationState.STALE_AFTER_MS + TaskNotificationState.RENEW_AFTER_MS + 15_000L
                : TaskNotificationState.FINISHED_AFTER_MS);
        }
        Notification notification = Build.VERSION.SDK_INT >= 36 && running
            ? AndroidLiveUpdates.buildRunning(builder, entry.phaseLabel()) : builder.build();
        try {
            manager.notify(TAG, entry.notificationId, notification);
            entry.postedAt = SystemClock.elapsedRealtime();
        }
        catch (SecurityException denied) {
            android.util.Log.w("TaskNotifications", "Notification permission was revoked");
        }
    }

    private static String message(TaskNotificationState.Entry entry) {
        switch (entry.state) {
            case "running": return entry.phaseLabel() + " · 点击返回对话";
            case "waiting": return entry.phaseLabel() + " · 点击继续";
            case "completed": return "本轮任务已完成 · 点击查看回答";
            case "failed": return "本轮任务失败 · 点击查看原因";
            case "interrupted": return "本轮任务已停止";
            default: return "任务状态暂未同步 · 返回应用重新连接";
        }
    }

    void disconnected() {
        for (TaskNotificationState.Entry entry : tasks.entries.values()) {
            if (entry.active()) {
                entry.disconnect(SystemClock.elapsedRealtime());
                post(entry);
            }
        }
        scheduleExpiry();
    }

    void reconcile(Set<String> activeThreads) {
        for (TaskNotificationState.Entry entry : tasks.entries.values()) {
            if (entry.active() && !activeThreads.contains(entry.threadId)) {
                entry.disconnect(SystemClock.elapsedRealtime());
                post(entry);
            }
        }
        scheduleExpiry();
    }

    private void expireTasks() {
        long now = SystemClock.elapsedRealtime();
        for (TaskNotificationState.Entry entry : new ArrayList<>(tasks.entries.values())) {
            if (prefs.getStringSet("dismissed", Collections.emptySet()).contains(entry.key())
                    || entry.expired(now)) {
                tasks.entries.remove(entry.threadId);
                manager.cancel(TAG, entry.notificationId);
                // A temporary LAN outage may last longer than the notification lifetime.
                // Only a user dismissal is permanent for this turn.
            } else if (entry.stale(now)) {
                entry.disconnect(now);
                post(entry);
            }
        }
        scheduleExpiry();
    }

    private void scheduleExpiry() {
        handler.removeCallbacks(expire);
        if (!tasks.entries.isEmpty()) handler.postDelayed(expire, 15_000L);
    }

    void clear() {
        handler.removeCallbacks(expire);
        if (manager != null) {
            for (android.service.notification.StatusBarNotification notification : manager.getActiveNotifications()) {
                if (TAG.equals(notification.getTag())) manager.cancel(TAG, notification.getId());
            }
        }
        tasks.clear();
    }

}
