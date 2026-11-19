package com.codexlight.android;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import org.json.JSONException;
import org.json.JSONObject;

/** Live question reminders are independent of opt-in task monitoring. */
final class QuestionNotificationController {
    static final int PERMISSION_REQUEST = 1003;
    static final String ACTION_OPEN = "com.codexlight.android.OPEN_QUESTION";
    private static final String CHANNEL = "question_reminders";
    private static final String TAG = "question_reminder";
    private static QuestionNotificationController instance;
    private final Context context;
    private final NotificationManager manager;
    private final Map<String, Entry> pending = new HashMap<>();
    private int nextId;

    static QuestionNotificationController get(Context context) {
        if (instance == null) instance = new QuestionNotificationController(context.getApplicationContext());
        return instance;
    }

    private QuestionNotificationController(Context context) {
        this.context = context;
        manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null && Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "提问与审批", NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("收到等待你回答或审批的新请求时提醒");
            manager.createNotificationChannel(channel);
        }
    }

    String status(Activity activity) {
        if (manager == null) return "unsupported";
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            boolean denied = context.getSharedPreferences(TaskNotificationController.PREFS, Context.MODE_PRIVATE)
                .getBoolean("questionNotificationDenied", false);
            return denied && (activity == null || !activity.shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS))
                ? "blocked" : "permission_required";
        }
        if (!manager.areNotificationsEnabled()) return "blocked";
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = manager.getNotificationChannel(CHANNEL);
            if (channel == null || channel.getImportance() == NotificationManager.IMPORTANCE_NONE) return "blocked";
        }
        return "ready";
    }

    void requestPermission(Activity activity) {
        if (Build.VERSION.SDK_INT >= 33 && "permission_required".equals(status(activity))) {
            activity.requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, PERMISSION_REQUEST);
        }
    }

    void permissionResult(int[] results) {
        if (results.length != 0) context.getSharedPreferences(TaskNotificationController.PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean("questionNotificationDenied", results[0] != PackageManager.PERMISSION_GRANTED).apply();
    }

    void update(String json) {
        try {
            JSONObject data = new JSONObject(json);
            String operation = data.getString("operation");
            if ("clearAll".equals(operation) && data.length() == 1) {
                clearAll();
                return;
            }
            String id = data.getString("id");
            if (!validId(id)) return;
            if ("clear".equals(operation) && data.length() == 2) {
                clear(id);
                return;
            }
            if (!"show".equals(operation) || data.length() != 4) return;
            if (!(data.get("id") instanceof String) || !(data.get("threadId") instanceof String)
                    || !(data.get("kind") instanceof String)) return;
            show(id, data.getString("threadId"), data.getString("kind"));
        } catch (JSONException invalid) {
            android.util.Log.w("QuestionNotifications", "Rejected invalid question notification JSON");
        }
    }

    static boolean validId(String id) {
        return id != null && id.matches("(?:request-[a-f0-9]{16}|question-[0-9]{1,10}|async-[A-Za-z0-9._:/-]{1,200}\\|[A-Za-z0-9._:/-]{1,200})");
    }

    void show(String id, String threadId, String kind) {
        if (pending.containsKey(id) || pending.size() >= 128 || !validId(id) || !"ready".equals(status(null)) || (!threadId.isEmpty() && !TaskNotificationState.validId(threadId))
                || (!"question".equals(kind) && !"approval".equals(kind))) return;
        try {
            Entry entry = new Entry(id, threadId, ++nextId);
            post(entry, "question".equals(kind) ? "Codex 等待你的回答" : "Codex 等待你的审批");
            pending.put(id, entry);
        } catch (SecurityException revoked) {
            android.util.Log.w("QuestionNotifications", "Notification permission was revoked");
        }
    }

    private void post(Entry entry, String title) {
        Intent intent = new Intent(context, MainActivity.class).setAction(ACTION_OPEN)
            .setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra("questionId", entry.id).putExtra("threadId", entry.threadId)
            .putExtra("notificationId", entry.notificationId);
        PendingIntent open = PendingIntent.getActivity(context, entry.notificationId, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder notification = Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(context, CHANNEL) : new Notification.Builder(context);
        notification.setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(title).setContentText("打开通知，回到对应请求。")
            .setVisibility(Notification.VISIBILITY_PRIVATE).setCategory(Notification.CATEGORY_MESSAGE)
            .setOnlyAlertOnce(true).setShowWhen(false).setAutoCancel(true).setContentIntent(open);
        if (Build.VERSION.SDK_INT < 26) notification.setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL);
        manager.notify(TAG, entry.notificationId, notification.build());
    }

    Entry consume(Intent intent) {
        String id = intent.getStringExtra("questionId");
        String threadId = intent.getStringExtra("threadId");
        if (!validId(id) || threadId == null || (!threadId.isEmpty() && !TaskNotificationState.validId(threadId))) return null;
        Entry entry = pending.get(id);
        int notificationId = intent.getIntExtra("notificationId", 0);
        if (entry != null) {
            if (notificationId != entry.notificationId || !threadId.equals(entry.threadId)) return null;
            // A tap dismisses the system notification. Keep its identity until the
            // desktop resolves it so the next background snapshot cannot repost it.
            manager.cancel(TAG, entry.notificationId);
            return entry;
        }
        // The non-exported activity also receives immutable notification intents after process death.
        return notificationId > 0 ? new Entry(id, threadId, notificationId) : null;
    }

    void clear(String id) {
        Entry entry = pending.remove(id);
        if (entry != null) manager.cancel(TAG, entry.notificationId);
    }

    void reconcile(Set<String> current) {
        for (String id : new ArrayList<>(pending.keySet())) if (!current.contains(id)) clear(id);
    }

    void clearAll() {
        pending.clear();
        if (manager == null) return;
        for (android.service.notification.StatusBarNotification notification : manager.getActiveNotifications()) {
            if (TAG.equals(notification.getTag())) manager.cancel(TAG, notification.getId());
        }
    }

    static final class Entry {
        final String id, threadId;
        final int notificationId;
        Entry(String id, String threadId, int notificationId) {
            this.id = id;
            this.threadId = threadId;
            this.notificationId = notificationId;
        }
    }
}
