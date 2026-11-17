package com.codexlight.android;

import android.app.Activity;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.TextView;
import android.widget.Toast;
import java.io.ByteArrayInputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.BooleanSupplier;
import org.json.JSONObject;

final class OfflineSnapshotController {
    private final Activity activity;
    private final View panel;
    private final TextView status;
    private final WebView offlineView;
    private final OfflineSnapshotStore store;
    private final Runnable onShow;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Runnable capture;
    private final Runnable tick;
    private boolean live, destroyed, saving, saveErrorReported;
    private int generation;
    private String connectionMessage = "正在连接电脑，先显示上次页面";
    private String currentKey;
    private OfflineSnapshotData displayed;

    OfflineSnapshotController(Activity activity, Runnable capture, Runnable onShow, Runnable retry, Runnable changeServer) {
        this.activity = activity; this.capture = capture; this.onShow = onShow;
        panel = activity.findViewById(R.id.offlinePanel);
        status = activity.findViewById(R.id.offlineStatus);
        offlineView = activity.findViewById(R.id.offlineWebView);
        store = new OfflineSnapshotStore(activity.getNoBackupFilesDir());
        activity.findViewById(R.id.offlineRetry).setOnClickListener(view -> retry.run());
        activity.findViewById(R.id.offlineChangeServer).setOnClickListener(view -> changeServer.run());
        WebSettings settings = offlineView.getSettings();
        settings.setJavaScriptEnabled(false); settings.setDomStorageEnabled(false); settings.setDatabaseEnabled(false);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false); settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setBlockNetworkLoads(true); settings.setBlockNetworkImage(true);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        offlineView.setBackgroundColor(0xFF181818);
        offlineView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return true; }
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) { return true; }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
            }
        });
        tick = new Runnable() { public void run() { if (destroyed) return; capture.run(); handler.postDelayed(this, 30_000L); } };
    }

    boolean showing() { return panel.getVisibility() == View.VISIBLE; }

    void beginConnection(ServerConfig config) {
        live = false; displayed = null; saving = false; panel.setVisibility(View.GONE);
        connectionMessage = "正在连接电脑，先显示上次页面";
        currentKey = config == null ? null : OfflineSnapshotData.key(config.getHost(), config.getPort());
        loadLatest();
    }

    private void loadLatest() {
        final int request = ++generation;
        if (currentKey == null || destroyed) return;
        final String key = currentKey;
        io.execute(() -> {
            OfflineSnapshotData data = null; boolean failed = false;
            try { data = store.read(key); } catch (Exception error) { failed = true; }
            final OfflineSnapshotData result = data; final boolean readFailed = failed;
            activity.runOnUiThread(() -> {
                if (destroyed || live || request != generation) return;
                if (result != null) { displayed = result; show(); }
                else if (readFailed) Toast.makeText(activity, "上次页面快照无法读取，仍可重新连接", Toast.LENGTH_LONG).show();
            });
        });
    }

    private void show() {
        if (displayed == null) return;
        status.setText(connectionMessage + "\n只读离线快照 · " + displayed.savedTime());
        offlineView.loadDataWithBaseURL(null, displayed.html(), "text/html", "UTF-8", null);
        panel.setVisibility(View.VISIBLE); onShow.run();
    }

    void connectionFailed(String detail) {
        live = false; connectionMessage = detail;
        if (displayed != null) show(); else loadLatest();
    }

    void liveReady() {
        live = true; generation++; panel.setVisibility(View.GONE); displayed = null;
        handler.removeCallbacks(tick); capture.run(); handler.postDelayed(tick, 30_000L);
    }

    void capture(WebView view, ServerConfig config, BooleanSupplier stillValid) {
        if (destroyed || saving || config == null || !stillValid.getAsBoolean()) return;
        saving = true;
        final int request = generation;
        final String key = OfflineSnapshotData.key(config.getHost(), config.getPort());
        final String token = config.getToken();
        view.evaluateJavascript("(() => { const api = window.CodexLightOfflineSnapshot; return api && typeof api.capture === 'function' ? api.capture() : null; })()", raw -> {
            saving = false;
            if (destroyed || request != generation || !stillValid.getAsBoolean() || raw == null || "null".equals(raw) || raw.length() > 700_000) return;
            final OfflineSnapshotData snapshot;
            try {
                JSONObject value = new JSONObject(raw);
                if (value.length() != 3 || !(value.get("title") instanceof String)
                        || !(value.get("page") instanceof String) || !(value.get("text") instanceof String)) return;
                snapshot = new OfflineSnapshotData(value.getString("title"), value.getString("page"), value.getString("text"), System.currentTimeMillis(), token);
            } catch (Exception invalid) { return; }
            io.execute(() -> {
                try { store.save(key, snapshot); }
                catch (Exception error) {
                    activity.runOnUiThread(() -> {
                        if (!destroyed && !saveErrorReported) {
                            saveErrorReported = true;
                            Toast.makeText(activity, "离线快照保存失败，保留上次可用页面", Toast.LENGTH_LONG).show();
                        }
                    });
                }
            });
        });
    }

    void pause() { capture.run(); handler.removeCallbacks(tick); }
    void resume() { if (live) { handler.removeCallbacks(tick); handler.postDelayed(tick, 30_000L); } }
    void destroy() { destroyed = true; generation++; handler.removeCallbacks(tick); io.shutdown(); offlineView.destroy(); }
}
