package com.codexlight.android;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** A user-started session with the paired desktop, independent of WebView timers. */
public final class MobileNotificationService extends Service {
    private static final String STOP = "com.codexlight.android.STOP_MOBILE_MONITOR";
    private static final String CHANNEL = "lan_notification_sync";
    private static final int NOTICE = 1870;
    private static final long SESSION_MS = 6 * 60 * 60_000L;
    private static volatile String state = "off";
    private static boolean started;
    private static MobileNotificationService currentService;
    private static String targetOrigin, targetToken;
    private static boolean backgroundQuestions = true;

    static String status() { return state; }
    static boolean ownsNotifications() { return started && "active".equals(state); }
    static void setQuestionAlerts(boolean enabled) { backgroundQuestions = enabled; }

    // WebView events wake the authoritative feed while the app is visible. After the
    // WebView pauses, the same service continues polling without relying on JS timers.
    static void refreshFromWeb() {
        MobileNotificationService service = currentService;
        if (service == null || !ownsNotifications()) return;
        if (service.polling) service.refreshPending = true;
        else if (!service.expedited) {
            service.expedited = true;
            service.handler.removeCallbacks(service.nextPoll);
            service.handler.postDelayed(service.nextPoll, 100L);
        }
    }

    static void stopIfTargetChanged(Context context, ServerConfig config) {
        if (targetOrigin != null && (config == null || !targetOrigin.equals(config.sourceKey()) || !targetToken.equals(config.getToken()))) {
            setEnabled(context,null,false);
            TaskNotificationController.get(context).clear();
            QuestionNotificationController.get(context).clearAll();
        }
    }

    static void setEnabled(Context context, ServerConfig config, boolean enabled) {
        Intent intent = new Intent(context, MobileNotificationService.class);
        if (!enabled) {
            if (currentService != null) {
                currentService.generation++;
                currentService.handler.removeCallbacksAndMessages(null);
            }
            targetOrigin = null; targetToken = null;
            context.stopService(intent);
            state = "off";
            return;
        }
        if (config == null || !config.eligible()) return;
        targetOrigin = config.sourceKey(); targetToken = config.getToken();
        intent.putExtra("remoteHostId",config.getRemoteHostId()).putExtra("scheme",config.getScheme()).putExtra("host",config.getHost()).putExtra("port",config.getPort()).putExtra("token",config.getToken());
        state = "connecting";
        try {
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent);
            else context.startService(intent);
        } catch (IllegalStateException | SecurityException unavailable) {
            state = "unavailable";
        }
    }

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Set<String> knownFinished = new LinkedHashSet<>();
    private final Runnable nextPoll = this::poll;
    private boolean polling, refreshPending, expedited;
    private ServerConfig target;
    private ServerConfig verifiedTarget;
    private android.net.Network verifiedNetwork;
    private String serverInstance;
    private TaskNotificationController tasks;
    private QuestionNotificationController questions;
    private volatile HttpURLConnection active;
    private volatile int generation;
    private long retryMs = 5_000L;
    private long deadline;

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || STOP.equals(intent.getAction())) {
            state = "off";
            stopSelf();
            return START_NOT_STICKY;
        }
        int port = intent.getIntExtra("port",0);
        String host = intent.getStringExtra("host"), token = intent.getStringExtra("token");
        ServerConfig requested = new ServerConfig(intent.getStringExtra("scheme"), host, port, token, intent.getStringExtra("remoteHostId"));
        if (!requested.eligible()) { state = "off"; stopSelf(); return START_NOT_STICKY; }
        questions = QuestionNotificationController.get(this);
        tasks = TaskNotificationController.get(this);
        try {
            Notification notice = serviceNotice();
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTICE,notice,ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            else startForeground(NOTICE,notice);
        } catch (IllegalStateException | SecurityException unavailable) {
            state = "unavailable";
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!tasks.permissionGranted()) { state = "permission_required"; stopSelf(); return START_NOT_STICKY; }
        started = true;
        currentService = this;
        target = requested;
        generation++;
        polling = false; refreshPending = false;
        handler.removeCallbacksAndMessages(null);
        serverInstance = null;
        retryMs = 5_000L;
        deadline = SystemClock.elapsedRealtime() + SESSION_MS;
        poll();
        handler.postDelayed(this::expireSession,SESSION_MS);
        return START_NOT_STICKY;
    }

    private Notification serviceNotice() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26 && manager != null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL,"后台通知同步",NotificationManager.IMPORTANCE_LOW);
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent open = PendingIntent.getActivity(this,NOTICE,new Intent(this,MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP),flags);
        PendingIntent stop = PendingIntent.getService(this,NOTICE,new Intent(this,MobileNotificationService.class).setAction(STOP),flags);
        Notification.Builder notification = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this,CHANNEL) : new Notification.Builder(this);
        return notification.setSmallIcon(R.drawable.ic_launcher_foreground).setContentTitle("正在同步配对电脑的通知")
            .setContentText("接收任务状态和等待处理请求").setOngoing(true).setOnlyAlertOnce(true)
            .setVisibility(Notification.VISIBILITY_PRIVATE).setContentIntent(open)
            .addAction(new Notification.Action.Builder(android.graphics.drawable.Icon.createWithResource(this,R.drawable.ic_launcher_foreground),"停止同步",stop).build()).build();
    }

    private void poll() {
        if (SystemClock.elapsedRealtime() >= deadline) { expireSession(); return; }
        expedited = false;
        polling = true;
        final int session = generation;
        final ServerConfig config = target;
        worker.execute(() -> {
            JSONObject snapshot = null;
            String outcome = "network_error";
            try {
                if (config.identifiedLan()) {
                    android.net.Network network = PairedNetwork.current(this);
                    if (verifiedTarget != config || verifiedNetwork == null || !verifiedNetwork.equals(network)) {
                        if (!PairedNetwork.client(this, network).verifyPeer(config, 1500)) throw new IOException("Peer unverified");
                        verifiedNetwork = network;
                        verifiedTarget = config;
                    }
                    if (!PairedNetwork.unchanged(this, network)) throw new IOException("Route changed");
                }
                HttpURLConnection connection = (HttpURLConnection) new URL(config.origin() + "/api/mobile/notification-state").openConnection();
                active = connection;
                if (session != generation) { connection.disconnect(); return; }
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(5_000);
                connection.setReadTimeout(5_000);
                connection.setUseCaches(false);
                connection.setRequestProperty("Authorization","Bearer " + config.getToken());
                int code = connection.getResponseCode();
                if (code == 200) snapshot = readSnapshot(connection);
                else if (code == 401 || code == 403) outcome = "unauthorized";
                else if (code == 404 || code == 405) outcome = "incompatible";
            } catch (IOException | JSONException failure) {
                // Retry transient LAN errors without recording credentials or notification data.
            } finally {
                HttpURLConnection connection = active;
                active = null;
                if (connection != null) connection.disconnect();
            }
            final JSONObject current = snapshot;
            final String failure = outcome;
            handler.post(() -> { if (session == generation) receive(current,failure); });
        });
    }

    private static JSONObject readSnapshot(HttpURLConnection connection) throws IOException, JSONException {
        try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] chunk = new byte[4096];
            int count;
            while ((count = input.read(chunk)) != -1) {
                if (output.size() + count > 256 * 1024) throw new IOException("notification feed too large");
                output.write(chunk,0,count);
            }
            JSONObject data = new JSONObject(new String(output.toByteArray(),StandardCharsets.UTF_8));
            if (data.optString("serverInstance").isEmpty() || !(data.opt("connected") instanceof Boolean)
                    || data.getJSONArray("running").length() > 32 || data.getJSONArray("finished").length() > 128
                    || data.getJSONArray("pending").length() > 128) throw new JSONException("invalid notification snapshot");
            return data;
        }
    }

    private void receive(JSONObject data, String error) {
        polling = false;
        boolean refresh = refreshPending;
        refreshPending = false;
        if (SystemClock.elapsedRealtime() >= deadline) { expireSession(); return; }
        if (!tasks.permissionGranted()) { state = "permission_required"; stopSelf(); return; }
        if (data == null || !data.optBoolean("connected")) {
            if ("active".equals(state)) tasks.disconnected();
            state = data == null ? error : "engine_offline";
            if (data == null && ("unauthorized".equals(error) || "incompatible".equals(error))) {
                if ("unauthorized".equals(error)) { tasks.clear(); questions.clearAll(); }
                stopSelf();
                return;
            }
            handler.postDelayed(nextPoll,retryMs);
            retryMs = Math.min(retryMs * 2,60_000L);
            return;
        }
        state = "active";
        retryMs = 5_000L;
        String instance = data.optString("serverInstance");
        boolean baseline = !instance.equals(serverInstance);
        if (baseline) {
            if (serverInstance != null) { tasks.clear(); questions.clearAll(); }
            serverInstance = instance;
            knownFinished.clear();
        }
        JSONArray incoming = data.optJSONArray("pending"), running = data.optJSONArray("running"), finished = data.optJSONArray("finished");
        Set<String> current = new HashSet<>();
        for (int i = 0; i < incoming.length(); i++) {
            JSONObject notice = incoming.optJSONObject(i);
            if (notice == null) continue;
            String id = notice.optString("id");
            if (!QuestionNotificationController.validId(id)) continue;
            current.add(id);
            if (backgroundQuestions) questions.show(id,notice.optString("threadId"),notice.optString("kind"));
        }
        questions.reconcile(current);
        Set<String> currentThreads = new HashSet<>();
        for (int i = 0; i < running.length(); i++) {
            JSONObject task = running.optJSONObject(i);
            if (task == null) continue;
            currentThreads.add(task.optString("threadId"));
            tasks.updateFromFeed(task);
        }
        for (int i = 0; i < finished.length(); i++) {
            JSONObject task = finished.optJSONObject(i);
            if (task == null) continue;
            String key = task.optString("threadId") + "\n" + task.optString("turnId");
            if (remember(knownFinished,key) && !baseline && !currentThreads.contains(task.optString("threadId"))) tasks.updateFromFeed(task);
        }
        tasks.reconcile(currentThreads);
        handler.postDelayed(nextPoll,refresh ? 100L : 5_000L);
    }

    private static boolean remember(Set<String> seen, String key) {
        if (!seen.add(key)) return false;
        if (seen.size() > 2048) seen.remove(seen.iterator().next());
        return true;
    }

    private void expireSession() { state = "expired"; stopSelf(); }

    @Override public void onDestroy() {
        generation++;
        started = false;
        currentService = null;
        targetOrigin = null; targetToken = null;
        if ("active".equals(state) || "connecting".equals(state) || "network_error".equals(state) || "engine_offline".equals(state)) state = "off";
        handler.removeCallbacksAndMessages(null);
        HttpURLConnection connection = active;
        if (connection != null) connection.disconnect();
        worker.shutdownNow();
        if (tasks != null) tasks.disconnected();
        super.onDestroy();
    }
}
