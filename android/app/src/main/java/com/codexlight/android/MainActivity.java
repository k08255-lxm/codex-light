package com.codexlight.android;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.webkit.ValueCallback;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

public class MainActivity extends Activity {
    public static final int FILE_CHOOSER_REQUEST_CODE = 1001;

    private WebView webView;
    private ProgressBar progressBar;
    private LinearLayout topBar;
    private TextView tvServerTitle;
    private TextView tvModeBadge;
    private View statusDot;
    private LinearLayout errorOverlay;
    private TextView tvErrorMessage;
    private Button btnErrorRetry;
    private Button btnErrorChangeServer;

    private ServerConfig currentConfig;
    private boolean isDemoMode = false;
    private LanConnectionClient connectionAttempt;
    private int connectionGeneration;
    private boolean connectionFailed;
    private boolean authorizationFailed;
    private String authorizedNetwork = "";
    private int networkLease;
    private volatile boolean currentPageTrusted = false;
    private long lastBackPressTime = 0;
    private boolean backRequestPending = false;
    private int backRequestSerial = 0;
    private int navigationGeneration = 0;
    private android.window.OnBackInvokedCallback systemBackCallback;
    private ValueCallback<Uri[]> fileUploadCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        initViews();
        resolveIntent();
        setupWebView();
        if (Build.VERSION.SDK_INT >= 33) {
            systemBackCallback = this::handleSystemBack;
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, systemBackCallback);
        }
        if (!isFinishing()) loadTargetUrl();
    }

    private void initViews() {
        webView = findViewById(R.id.webView);
        progressBar = findViewById(R.id.progressBar);
        topBar = findViewById(R.id.topBar);
        tvServerTitle = findViewById(R.id.tvServerTitle);
        tvModeBadge = findViewById(R.id.tvModeBadge);
        statusDot = findViewById(R.id.statusDot);
        errorOverlay = findViewById(R.id.errorOverlay);
        tvErrorMessage = findViewById(R.id.tvErrorMessage);
        btnErrorRetry = findViewById(R.id.btnErrorRetry);
        btnErrorChangeServer = findViewById(R.id.btnErrorChangeServer);

        View capsule = findViewById(R.id.serverCapsule);
        if (capsule != null) {
            capsule.setOnClickListener(v -> openServerManager());
        }

        findViewById(R.id.btnRefresh).setOnClickListener(v -> {
            errorOverlay.setVisibility(View.GONE);
            loadTargetUrl();
        });

        findViewById(R.id.btnSettings).setOnClickListener(v -> openServerManager());

        btnErrorRetry.setOnClickListener(v -> {
            errorOverlay.setVisibility(View.GONE);
            loadTargetUrl();
        });

        btnErrorChangeServer.setOnClickListener(v -> openServerManager());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        resolveIntent();
        loadTargetUrl();
    }

    private void resolveIntent() {
        Intent intent = getIntent();
        isDemoMode = intent.getBooleanExtra("demo", false);

        if (!isDemoMode) {
            ServerConfigManager saved = new ServerConfigManager(this);
            authorizedNetwork = intent.getStringExtra("authorizedNetwork");
            String host = intent.getStringExtra("host");
            int port = intent.getIntExtra("port", 0);
            String token = intent.getStringExtra("token");

            if (host != null && !host.isEmpty()) {
                currentConfig = new ServerConfig(host, port, token);
                // Save only after authenticated contact with the paired server.
            } else {
                ServerConfigManager mgr = new ServerConfigManager(this);
                currentConfig = mgr.getCurrent();
            }

            if (currentConfig == null) {
                openServerManager();
                finish();
            }
        }
    }

    public boolean isDemoMode() {
        return isDemoMode;
    }

    public boolean isTrustedOrigin(Uri uri) {
        if (uri == null) return false;
        String scheme = uri.getScheme();
        if (isDemoMode) {
            String path = uri.getPath();
            return "file".equalsIgnoreCase(scheme) && path != null && path.startsWith("/android_asset/");
        }
        if (currentConfig == null || !"http".equalsIgnoreCase(scheme)) {
            return false;
        }
        String host = uri.getHost();
        int port = uri.getPort();
        int effectivePort = port > 0 ? port : 80;
        return host != null
            && host.equalsIgnoreCase(currentConfig.getHost())
            && effectivePort == currentConfig.getPort();
    }

    public void updatePageOrigin(String url) {
        navigationGeneration++;
        backRequestPending = false;
        lastBackPressTime = 0;
        if (url == null || url.isEmpty()) {
            currentPageTrusted = false;
            return;
        }
        try {
            currentPageTrusted = isTrustedOrigin(Uri.parse(url));
        } catch (Exception e) {
            currentPageTrusted = false;
        }
    }

    public String getCurrentToken() {
        if (isDemoMode || !currentPageTrusted || currentConfig == null) {
            return "";
        }
        return currentConfig.getToken();
    }

    private void setupWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(false);
        settings.setAllowFileAccess(isDemoMode);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setSupportZoom(true);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        String defaultUa = settings.getUserAgentString();
        settings.setUserAgentString(defaultUa + " CodexLightMobile/0.4.4");

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(false);
        }

        webView.setBackgroundColor(0xFF181818);
        webView.addJavascriptInterface(new CodexLightBridge(this), "CodexLightNative");
        webView.setWebChromeClient(new AppWebChromeClient(this, progressBar));
        webView.setWebViewClient(new AppWebViewClient(this, progressBar));
    }

    private void loadTargetUrl() {
        cancelConnectionAttempt();
        if (webView != null) webView.stopLoading();
        connectionFailed = false;
        authorizationFailed = false;
        navigationGeneration++;
        backRequestPending = false;
        lastBackPressTime = 0;
        if (isDemoMode) {
            currentPageTrusted = false;
            tvServerTitle.setText("离线界面预览");
            if (tvModeBadge != null) tvModeBadge.setText("DEMO");
            statusDot.setBackgroundTintList(getColorStateList(R.color.status_warning));
            webView.loadUrl("file:///android_asset/web/index.html");
        } else if (currentConfig != null) {
            String network = NetworkBinding.current(this);
            if (!NetworkBinding.matches(authorizedNetwork, network)) {
                authorizationFailed = true;
                showConnectionError("网络已变化或无法确认。为避免把令牌发给同地址的其他设备，自动连接已暂停。请返回连接页，确认可信网络和电脑地址后再连接。");
                return;
            }
            networkLease = NetworkBinding.bind(this, authorizedNetwork);
            if (networkLease == 0) {
                authorizationFailed = true;
                showConnectionError("无法安全绑定已确认的网络，请返回连接页重试。");
                return;
            }
            currentPageTrusted = false;
            tvServerTitle.setText(currentConfig.toDisplayAddress());
            if (tvModeBadge != null) tvModeBadge.setText("LAN");
            statusDot.setBackgroundTintList(getColorStateList(R.color.status_warning));
            tvModeBadge.setText("连接中");
            progressBar.setVisibility(View.VISIBLE);
            final int attemptId = connectionGeneration;
            final ServerConfig target = currentConfig;
            final String expectedNetwork = authorizedNetwork;
            final LanConnectionClient attempt = new LanConnectionClient(url -> NetworkBinding.open(this, expectedNetwork, url));
            connectionAttempt = attempt;
            new Thread(() -> {
                LanConnectionClient.Result result = attempt.check(target);
                runOnUiThread(() -> {
                    if (attemptId != connectionGeneration || isFinishing() || isDestroyed()) return;
                    connectionAttempt = null;
                    progressBar.setVisibility(View.GONE);
                    if (result == LanConnectionClient.Result.READY) {
                        ServerConfigManager manager = new ServerConfigManager(this);
                        // The network may have changed while the request was in flight.
                        if (!NetworkBinding.matches(authorizedNetwork, NetworkBinding.current(this))) {
                            authorizationFailed = true;
                            showConnectionError("连接期间网络变化，请重新确认当前网络。");
                            return;
                        }
                        manager.saveCurrent(target, authorizedNetwork);
                        if (manager.hasStorageError()) Toast.makeText(this,
                            "本次已连接，但无法安全保存凭据；下次可能需要重新配对。", Toast.LENGTH_LONG).show();
                        currentPageTrusted = true;
                        tvModeBadge.setText("LAN");
                        webView.loadUrl(target.toFullUrl());
                    } else {
                        authorizationFailed = result == LanConnectionClient.Result.UNAUTHORIZED || result == LanConnectionClient.Result.INVALID;
                        showConnectionError(authorizationFailed ? "配对已失效，请在电脑生成新二维码并重新配对。" : "暂时无法连接电脑。请确认电脑远控已开启，手机和电脑位于同一可信网络。若电脑地址变化，请重新配对。");
                    }
                });
            }, "lan-reconnect").start();
        }
    }

    private void cancelConnectionAttempt() {
        connectionGeneration++;
        if (connectionAttempt != null) { connectionAttempt.cancel(); connectionAttempt = null; }
    }

    public void hideConnectionError() {
        if (errorOverlay != null) {
            errorOverlay.setVisibility(View.GONE);
        }
        if (statusDot != null) {
            statusDot.setBackgroundTintList(getColorStateList(isDemoMode ? R.color.status_warning : R.color.status_connected));
        }
    }

    public void showConnectionError(String detail) {
        connectionFailed = true;
        currentPageTrusted = false;
        progressBar.setVisibility(View.GONE);
        if (tvModeBadge != null) tvModeBadge.setText(authorizationFailed ? "需配对" : "离线");
        if (errorOverlay == null) return;
        errorOverlay.setVisibility(View.VISIBLE);
        if (statusDot != null) {
            statusDot.setBackgroundTintList(getColorStateList(R.color.status_error));
        }
        tvErrorMessage.setText(detail + (currentConfig == null ? "" : "\n\n目标地址：" + currentConfig.toDisplayAddress()));
        btnErrorRetry.setVisibility(authorizationFailed ? View.GONE : View.VISIBLE);
        btnErrorChangeServer.setText(authorizationFailed ? "重新配对" : "取消重连 / 更换电脑");
    }

    public void setFileUploadCallback(ValueCallback<Uri[]> callback) {
        cancelPendingFileUpload();
        this.fileUploadCallback = callback;
    }

    public void cancelPendingFileUpload() {
        ValueCallback<Uri[]> pending = this.fileUploadCallback;
        this.fileUploadCallback = null;
        if (pending != null) {
            pending.onReceiveValue(null);
        }
    }

    private void openServerManager() {
        cancelConnectionAttempt();
        if (webView != null) { webView.stopLoading(); webView.loadUrl("about:blank"); }
        currentPageTrusted = false;
        Intent intent = new Intent(this, ServerConnectActivity.class);
        intent.putExtra("manual", true);
        startActivity(intent);
        finish();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER_REQUEST_CODE) {
            ValueCallback<Uri[]> callback = fileUploadCallback;
            fileUploadCallback = null;
            if (callback == null) return;
            Uri[] results = null;
            if (resultCode == Activity.RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    results = new Uri[count];
                    for (int i = 0; i < count; i++) {
                        results[i] = data.getClipData().getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    results = new Uri[]{data.getData()};
                }
            }
            callback.onReceiveValue(results);
        }
    }

    @Override
    public void onBackPressed() {
        handleSystemBack();
    }

    private void handleSystemBack() {
        if (errorOverlay.getVisibility() == View.VISIBLE) {
            openServerManager();
            return;
        }
        if (backRequestPending) return;
        if (webView == null || !currentPageTrusted) { finishBackNavigation(); return; }
        backRequestPending = true;
        final int generation = navigationGeneration;
        final int request = ++backRequestSerial;
        webView.postDelayed(() -> {
            if (generation == navigationGeneration && request == backRequestSerial && backRequestPending) {
                backRequestPending = false;
                backRequestSerial++; // Ignore a late result rather than unexpectedly leaving the page.
            }
        }, 2000);
        // Let the web UI dismiss its modal/drawer/page before navigating away.
        webView.evaluateJavascript(
            "(() => { const nav = window.CodexLightNavigation; return nav && typeof nav.back === 'function' ? nav.back() === true : false; })()",
            result -> {
                if (generation != navigationGeneration || request != backRequestSerial || isFinishing() || isDestroyed()) return;
                backRequestPending = false;
                if ("true".equals(result)) { lastBackPressTime = 0; return; }
                // JS errors must not turn an attempted dismiss into an accidental exit.
                if ("false".equals(result)) finishBackNavigation();
            });
    }

    private void finishBackNavigation() {
        if (webView != null && webView.canGoBack()) {
            lastBackPressTime = 0;
            webView.goBack();
            return;
        }
        long now = android.os.SystemClock.elapsedRealtime();
        if (lastBackPressTime != 0 && now - lastBackPressTime < 2000) {
            finish();
        } else {
            lastBackPressTime = now;
            Toast.makeText(this, R.string.press_again_exit, Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        AppUpdateChecker.start(this);
        if (webView != null) webView.onResume();
        if (connectionFailed && !authorizationFailed && new ServerConfigManager(this).isAutoConnectEnabled()) {
            errorOverlay.setVisibility(View.GONE);
            loadTargetUrl();
        }
    }

    @Override
    protected void onPause() {
        AppUpdateChecker.stop(this);
        if (connectionAttempt != null) {
            cancelConnectionAttempt();
            showConnectionError("连接已暂停。返回后可重试，或更换电脑。");
        }
        super.onPause();
        if (webView != null) webView.onPause();
    }

    @Override
    protected void onDestroy() {
        cancelConnectionAttempt();
        navigationGeneration++;
        if (Build.VERSION.SDK_INT >= 33 && systemBackCallback != null) {
            getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(systemBackCallback);
        }
        cancelPendingFileUpload();
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
        }
        NetworkBinding.release(this, networkLease);
        super.onDestroy();
    }
}
