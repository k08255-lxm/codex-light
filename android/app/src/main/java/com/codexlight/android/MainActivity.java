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
    @Override protected void attachBaseContext(android.content.Context base) { super.attachBaseContext(DeviceAppearance.apply(base)); }
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

    private volatile ServerConfig currentConfig;
    private volatile android.net.Network verifiedLanNetwork;
    private boolean isDemoMode = false;
    private LanConnectionClient connectionAttempt;
    private int connectionGeneration;
    private boolean connectionFailed;
    private boolean preferPairedRoutes;
    private boolean workbenchLoaded;
    private boolean allowLegacySnapshot;
    private LanConnectionClient networkProbe;
    private android.net.ConnectivityManager connectivity;
    private final android.net.ConnectivityManager.NetworkCallback networkCallback = new android.net.ConnectivityManager.NetworkCallback() {
        @Override public void onAvailable(android.net.Network network) {
            runOnUiThread(() -> checkCurrentRoute(network));
        }
    };
    private boolean authorizationFailed;
    private volatile boolean currentPageTrusted = false;
    private long lastBackPressTime = 0;
    private boolean backRequestPending = false;
    private int backRequestSerial = 0;
    private int navigationGeneration = 0;
    private android.window.OnBackInvokedCallback systemBackCallback;
    private ValueCallback<Uri[]> fileUploadCallback;
    private ProjectFileDownload projectFileDownload;
    private TaskNotificationController taskNotifications;
    private QuestionNotificationController questionNotifications;
    private String pendingNotificationThread;
    private QuestionNotificationController.Entry pendingQuestion;
    private ServerConfig backgroundPermissionTarget;
    private OfflineSnapshotController offlineSnapshots;
    private boolean snapshotPageReady;
    private boolean requestedToolbarIntegrated;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        initViews();
        taskNotifications = TaskNotificationController.get(this);
        questionNotifications = QuestionNotificationController.get(this);
        resolveIntent();
        MobileNotificationService.stopIfTargetChanged(this, isDemoMode ? null : currentConfig);
        taskNotifications.bindOrigin(isDemoMode || currentConfig == null ? "" : currentConfig.sourceKey());
        acceptTaskNotificationIntent(getIntent());
        if (QuestionNotificationController.ACTION_OPEN.equals(getIntent().getAction()) && notificationOriginMatches(getIntent())) {
            pendingQuestion = questionNotifications.consume(getIntent());
        }
        setupWebView();
        offlineSnapshots = new OfflineSnapshotController(this, this::captureOfflineSnapshot, () -> {
            errorOverlay.setVisibility(View.GONE);
            webView.setVisibility(View.INVISIBLE);
            updateToolbarVisibility();
        }, this::loadTargetUrl, this::openServerManager);
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
        findViewById(R.id.errorCheckUpdates).setOnClickListener(v -> AppUpdateChecker.checkNow(this));
        findViewById(R.id.offlineCheckUpdates).setOnClickListener(v -> AppUpdateChecker.checkNow(this));
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (QuestionNotificationController.ACTION_OPEN.equals(intent.getAction())) {
            if (notificationOriginMatches(intent)) pendingQuestion = questionNotifications.consume(intent);
            deliverQuestionNotificationIntent();
            return;
        }
        if (acceptTaskNotificationIntent(intent)) {
            deliverTaskNotificationIntent();
            return;
        }
        currentPageTrusted = false;
        setIntent(intent);
        recreate(); // Destroy the previous document and its native bridge before switching targets.
    }

    static void putConnection(Intent intent, ServerConfig config, boolean automatic) {
        intent.putExtra("automatic", automatic).putExtra("scheme", config.getScheme())
            .putExtra("host", config.getHost()).putExtra("port", config.getPort())
            .putExtra("remoteHostId", config.getRemoteHostId()).putExtra("token", config.getToken());
    }

    private void resolveIntent() {
        Intent intent = getIntent();
        isDemoMode = intent.getBooleanExtra("demo", false);

        preferPairedRoutes = intent.getBooleanExtra("automatic", !intent.hasExtra("host"))
            && !TaskNotificationController.ACTION_OPEN.equals(intent.getAction())
            && !QuestionNotificationController.ACTION_OPEN.equals(intent.getAction());

        if (!isDemoMode) {
            String scheme = intent.getStringExtra("scheme");
            String host = intent.getStringExtra("host");
            int port = intent.getIntExtra("port", 0);
            String token = intent.getStringExtra("token");

            if (host != null && !host.isEmpty()) {
                currentConfig = new ServerConfig(scheme == null ? "http" : scheme, host, port, token, intent.getStringExtra("remoteHostId"));
                // Save only after authenticated contact with the paired server.
            } else {
                ServerConfigManager mgr = new ServerConfigManager(this);
                currentConfig = mgr.getCurrent();
            }

            if (currentConfig != null && currentConfig.getRemoteHostId().isEmpty()) {
                ServerConfig previous = new ServerConfigManager(this).getCurrent();
                allowLegacySnapshot = previous != null && previous.sourceKey().equals(currentConfig.sourceKey())
                    && previous.getToken().equals(currentConfig.getToken());
            }
            if (currentConfig == null) {
                openServerManager();
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
        return currentConfig != null && currentConfig.matchesOrigin(uri.toString());
    }

    public void updatePageOrigin(String url) {
        snapshotPageReady = false;
        requestedToolbarIntegrated = false;
        webView.setVisibility(View.INVISIBLE);
        navigationGeneration++;
        if (questionNotifications != null && !MobileNotificationService.ownsNotifications()) questionNotifications.clearAll();
        backRequestPending = false;
        lastBackPressTime = 0;
        if (url == null || url.isEmpty()) {
            currentPageTrusted = false;
            if (taskNotifications != null && !MobileNotificationService.ownsNotifications()) taskNotifications.disconnected();
            updateToolbarVisibility();
            return;
        }
        try {
            currentPageTrusted = isTrustedOrigin(Uri.parse(url));
        } catch (Exception e) {
            currentPageTrusted = false;
        }
        if (!currentPageTrusted && taskNotifications != null && !MobileNotificationService.ownsNotifications()) taskNotifications.disconnected();
        updateToolbarVisibility();
    }

    boolean lanNetworkVerified() {
        ServerConfig config = currentConfig;
        return config == null || !config.identifiedLan() || PairedNetwork.unchanged(this, verifiedLanNetwork);
    }

    public String getCurrentToken() {
        if (isDemoMode || !currentPageTrusted || currentConfig == null || !lanNetworkVerified()) {
            return "";
        }
        return currentConfig.getToken();
    }

    public boolean trustedTaskNotificationPage() {
        return !isDemoMode && currentPageTrusted && currentConfig != null && lanNetworkVerified() && !isFinishing() && !isDestroyed();
    }

    public String getTaskNotificationStatus() {
        return trustedTaskNotificationPage() && taskNotifications != null
            ? taskNotifications.status() : "{\"supported\":false}";
    }

    public void setTaskNotificationsEnabled(boolean enabled) {
        if (trustedTaskNotificationPage() && taskNotifications != null) {
            if (!enabled) {
                MobileNotificationService.remember(this, currentConfig, false, false);
                backgroundPermissionTarget = null;
                MobileNotificationService.setEnabled(this, currentConfig, false);
            }
            taskNotifications.setEnabled(enabled,this);
            notifyTaskNotificationStatus();
        }
    }

    public void openTaskNotificationSettings() {
        if (trustedTaskNotificationPage() && taskNotifications != null) taskNotifications.openSettings(this);
    }

    public void setRealtimeNotifications(boolean enabled, boolean questionsEnabled) {
        if (!trustedTaskNotificationPage() || !canOpenWorkbenchSettings() || !hasWindowFocus()) return;
        if (enabled && questionsEnabled) questionNotifications.setFirstPromptDeclined(false);
        MobileNotificationService.remember(this, currentConfig, enabled, questionsEnabled);
        backgroundPermissionTarget = enabled && !taskNotifications.permissionGranted() ? currentConfig : null;
        taskNotifications.setEnabled(enabled, this);
        if (!enabled || taskNotifications.permissionGranted())
            MobileNotificationService.setEnabled(this, currentConfig, enabled);
        notifyTaskNotificationStatus();
        notifyQuestionNotificationStatus();
    }

    private void resumeSavedNotifications() {
        if (snapshotPageReady && trustedTaskNotificationPage() && hasWindowFocus()
                && taskNotifications.permissionGranted()) {
            taskNotifications.bindFirstNotificationChoice(currentConfig);
            MobileNotificationService.resumeSaved(this, currentConfig);
        }
    }

    @Override public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (focused) resumeSavedNotifications();
    }

    public void openLiveUpdateSettings() {
        if (canOpenWorkbenchSettings() && taskNotifications != null) taskNotifications.openPromotionSettings(this);
    }

    public void setBackgroundNotifications(boolean enabled, boolean questionsEnabled) {
        if (!canOpenWorkbenchSettings() || !hasWindowFocus()) return;
        if (!trustedTaskNotificationPage()) return;
        MobileNotificationService.remember(this, currentConfig, enabled, questionsEnabled);
        backgroundPermissionTarget = null;
        if (enabled && !taskNotifications.permissionGranted()) {
            backgroundPermissionTarget = currentConfig;
            if ("permission_required".equals(questionNotifications.status(this))) {
                questionNotifications.requestPermission(this);
            } else {
                taskNotifications.openSettings(this);
            }
            return;
        }
        MobileNotificationService.setEnabled(this,currentConfig,enabled);
        notifyTaskNotificationStatus();
    }

    private void continueBackgroundPermission() {
        if (backgroundPermissionTarget == null || !taskNotifications.permissionGranted()) return;
        if (backgroundPermissionTarget == currentConfig && trustedTaskNotificationPage()) {
            MobileNotificationService.setEnabled(this,currentConfig,true);
        }
        backgroundPermissionTarget = null;
    }

    public String getQuestionNotificationStatus() {
        return trustedTaskNotificationPage() && questionNotifications != null ? questionNotifications.status(this) : "unsupported";
    }

    public void requestQuestionNotificationPermission() {
        if (trustedTaskNotificationPage() && questionNotifications != null) {
            questionNotifications.requestPermission(this);
            notifyQuestionNotificationStatus();
        }
    }

    public void setBackgroundQuestionAlerts(boolean enabled) {
        if (!trustedTaskNotificationPage()) return;
        MobileNotificationService.saveQuestionAlerts(this, currentConfig, enabled);
        if (!enabled && questionNotifications != null) questionNotifications.clearAll();
    }

    public void updateQuestionNotification(String json) {
        if (!trustedTaskNotificationPage() || questionNotifications == null) return;
        if (MobileNotificationService.ownsNotifications()) MobileNotificationService.refreshFromWeb();
        else questionNotifications.update(json);
    }

    private void notifyQuestionNotificationStatus() {
        if (trustedTaskNotificationPage() && webView != null) {
            webView.evaluateJavascript("window.dispatchEvent(new Event('codexlight-question-notification-status'))", null);
        }
    }

    public void updateTaskNotification(String json) {
        if (trustedTaskNotificationPage() && taskNotifications != null) {
            taskNotifications.update(json);
            if (MobileNotificationService.ownsNotifications()) MobileNotificationService.refreshFromWeb();
            deliverTaskNotificationIntent();
        }
    }

    private boolean notificationOriginMatches(Intent intent) {
        return !isDemoMode && currentConfig != null && currentConfig.sourceKey().equals(intent.getStringExtra("origin"));
    }

    private boolean acceptTaskNotificationIntent(Intent intent) {
        if (intent == null || !TaskNotificationController.ACTION_OPEN.equals(intent.getAction())) return false;
        String threadId = intent.getStringExtra("threadId");
        String turnId = intent.getStringExtra("turnId");
        if (notificationOriginMatches(intent) && TaskNotificationState.validId(threadId) && TaskNotificationState.validId(turnId)) {
            pendingNotificationThread = threadId;
        }
        return true;
    }

    public void deliverTaskNotificationIntent() {
        if (!trustedTaskNotificationPage() || webView == null || pendingNotificationThread == null) return;
        final String thread = pendingNotificationThread;
        webView.evaluateJavascript("(() => { const api = window.CodexLightTaskNotifications; "
            + "if (api && typeof api.open === 'function') api.open("
            + org.json.JSONObject.quote(thread) + "); })()", null);
    }

    public void taskNotificationOpened(String threadId) {
        if (trustedTaskNotificationPage() && TaskNotificationState.validId(threadId)
                && threadId.equals(pendingNotificationThread)) pendingNotificationThread = null;
    }

    void deliverQuestionNotificationIntent() {
        if (!trustedTaskNotificationPage() || webView == null || pendingQuestion == null) return;
        final QuestionNotificationController.Entry entry = pendingQuestion;
        webView.evaluateJavascript("(() => { const api = window.CodexLightQuestionNotifications; return !!api?.open("
            + org.json.JSONObject.quote(entry.id) + "," + org.json.JSONObject.quote(entry.threadId) + "); })()", result -> {
                if (pendingQuestion == entry && "true".equals(result)) pendingQuestion = null;
            });
    }

    public void offlineSnapshotReady() {
        if (!trustedTaskNotificationPage() || offlineSnapshots == null) return;
        snapshotPageReady = true;
        webView.setVisibility(View.VISIBLE);
        errorOverlay.setVisibility(View.GONE);
        offlineSnapshots.liveReady();
        resumeSavedNotifications();
        updateToolbarVisibility();
        deliverQuestionNotificationIntent();
    }

    private void captureOfflineSnapshot() {
        if (offlineSnapshots == null || webView == null) return;
        final ServerConfig target = currentConfig;
        offlineSnapshots.capture(webView, target,
            () -> snapshotPageReady && target == currentConfig && trustedTaskNotificationPage());
    }

    private void notifyTaskNotificationStatus() {
        if (trustedTaskNotificationPage() && webView != null) {
            webView.evaluateJavascript("window.dispatchEvent(new Event('codexlight-task-notification-status'))", null);
        }
    }

    void notifyAppUpdateStatus() {
        if (trustedTaskNotificationPage() && webView != null) {
            webView.evaluateJavascript("window.dispatchEvent(new Event('codexlight-android-update-status'))", null);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == TaskNotificationController.PERMISSION_REQUEST || requestCode == QuestionNotificationController.PERMISSION_REQUEST) {
            if (questionNotifications != null) {
                questionNotifications.permissionResult(grantResults);
            }
            continueBackgroundPermission();
            backgroundPermissionTarget = null;
            notifyTaskNotificationStatus();
            notifyQuestionNotificationStatus();
        }
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
        settings.setUserAgentString(defaultUa + " CodexLightMobile/0.4.19");

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(false);
        }

        webView.setBackgroundColor(0xFF181818);
        projectFileDownload = new ProjectFileDownload(this, webView, this::trustedProjectFilePage, () -> navigationGeneration);
        webView.addJavascriptInterface(new CodexLightBridge(this), "CodexLightNative");
        webView.setWebChromeClient(new AppWebChromeClient(this, progressBar));
        webView.setWebViewClient(new AppWebViewClient(this, progressBar));
    }

    public void setToolbarIntegrated(boolean integrated) {
        if (isDemoMode || !currentPageTrusted) return;
        requestedToolbarIntegrated = integrated;
        updateToolbarVisibility();
    }

    public void showFinishedWorkbench(String url) {
        if (isFinishing() || isDestroyed() || !currentPageTrusted || url == null || !isTrustedOrigin(Uri.parse(url))
                || errorOverlay.getVisibility() == View.VISIBLE || (offlineSnapshots != null && offlineSnapshots.showing())) return;
        webView.setVisibility(View.VISIBLE);
        updateToolbarVisibility();
    }

    private void updateToolbarVisibility() {
        boolean snapshot = offlineSnapshots != null && offlineSnapshots.showing();
        boolean error = errorOverlay.getVisibility() == View.VISIBLE;
        boolean integrated = requestedToolbarIntegrated && currentPageTrusted && webView.getVisibility() == View.VISIBLE;
        int visibility = snapshot || error || integrated ? View.GONE : View.VISIBLE;
        topBar.setVisibility(visibility);
        findViewById(R.id.topBarDivider).setVisibility(visibility);
    }

    private void loadTargetUrl() {
        cancelNetworkProbe();
        snapshotPageReady = false;
        requestedToolbarIntegrated = false;
        webView.setVisibility(View.INVISIBLE);
        errorOverlay.setVisibility(View.GONE);
        if (offlineSnapshots != null) offlineSnapshots.beginConnection(isDemoMode || currentConfig == null
            || (currentConfig.getRemoteHostId().isEmpty() && !allowLegacySnapshot) ? null : currentConfig);
        updateToolbarVisibility();
        if (!MobileNotificationService.ownsNotifications()) {
            if (taskNotifications != null) taskNotifications.disconnected();
            if (questionNotifications != null) questionNotifications.clearAll();
        }
        cancelConnectionAttempt();
        if (webView != null) webView.stopLoading();
        connectionFailed = false;
        authorizationFailed = false;
        navigationGeneration++;
        backRequestPending = false;
        lastBackPressTime = 0;
        if (isDemoMode) {
            currentPageTrusted = false;
            webView.setVisibility(View.VISIBLE);
            tvServerTitle.setText("离线界面预览");
            if (tvModeBadge != null) tvModeBadge.setText("DEMO");
            statusDot.setBackgroundTintList(getColorStateList(R.color.status_warning));
            webView.loadUrl("file:///android_asset/web/index.html");
        } else if (currentConfig != null) {
            // Follow Android's default route, including the user's VPN LAN exclusions.
            // An identified LAN endpoint must prove knowledge of its own token before bearer authentication.
            currentPageTrusted = false;
            tvServerTitle.setText("连接电脑");
            if (tvModeBadge != null) tvModeBadge.setText("LAN");
            statusDot.setBackgroundTintList(getColorStateList(R.color.status_warning));
            tvModeBadge.setText("连接中");
            progressBar.setVisibility(View.VISIBLE);
            final int attemptId = connectionGeneration;
            final ServerConfig requested = currentConfig;
            final boolean preferLan = preferPairedRoutes;
            final android.net.Network startingNetwork = PairedNetwork.current(this);
            final LanConnectionClient attempt = PairedNetwork.client(this, startingNetwork);
            connectionAttempt = attempt;
            new Thread(() -> {
                ServerConfigManager manager = new ServerConfigManager(this);
                LanConnectionClient.Selection selection = attempt.select(requested,
                    preferLan ? manager.getHistory() : java.util.Collections.emptyList(), preferLan);
                runOnUiThread(() -> {
                    if (attemptId != connectionGeneration || isFinishing() || isDestroyed()) return;
                    connectionAttempt = null;
                    progressBar.setVisibility(View.GONE);
                    LanConnectionClient.Result result = selection.result;
                    ServerConfig target = selection.target;
                    if (result == LanConnectionClient.Result.READY) {
                        boolean changedOrigin = !target.origin().equals(requested.origin());
                        if (changedOrigin && workbenchLoaded) {
                            // The previous bridge and any pending uploads belong to the old origin.
                            Intent next = new Intent(this, MainActivity.class);
                            putConnection(next, target, false);
                            startActivity(next);
                            finish();
                            return;
                        }
                        if (!target.sourceKey().equals(requested.sourceKey()) || (!allowLegacySnapshot && target.getRemoteHostId().isEmpty())) {
                            pendingQuestion = null;
                            pendingNotificationThread = null;
                            MobileNotificationService.stopIfTargetChanged(this, target);
                            taskNotifications.bindOrigin(target.sourceKey());
                            offlineSnapshots.beginConnection(target);
                        }
                        currentConfig = target;
                        allowLegacySnapshot = true;
                        verifiedLanNetwork = target.identifiedLan() ? startingNetwork : null;
                        preferPairedRoutes = true;
                        if (!lanNetworkVerified()) {
                            showConnectionError("网络已变化，请重新连接以验证局域网电脑。");
                            return;
                        }
                        manager.saveCurrent(target, "");
                        if (manager.hasStorageError()) Toast.makeText(this,
                            "本次已连接，但无法安全保存凭据；下次可能需要重新配对。", Toast.LENGTH_LONG).show();
                        String route = "https".equals(target.getScheme()) ? "公网 HTTPS" : "局域网";
                        tvModeBadge.setText(route);
                        Toast.makeText(this, "已连接 · " + route, Toast.LENGTH_SHORT).show();
                        workbenchLoaded = true;
                        webView.loadUrl(target.origin() + "/");
                    } else {
                        reportRouteFailure(result, target);
                    }
                });
            }, "lan-reconnect").start();
        }
    }

    private void reportRouteFailure(LanConnectionClient.Result result, ServerConfig target) {
        authorizationFailed = result != LanConnectionClient.Result.UNAVAILABLE;
        String message;
        switch (result) {
            case UNAUTHORIZED: message = "此线路拒绝令牌，请重新配对。"; break;
            case WRONG_DEVICE: message = "电脑标识已改变，请核对电脑后重新配对。"; break;
            case UNPROVEN: message = "未能验证局域网电脑的身份，未发送访问令牌。"; break;
            case UNEXPECTED: message = "此线路未返回有效的码舱状态，请检查连接设置。"; break;
            case INVALID: message = "配对地址或令牌无效，请重新配对。"; break;
            default: message = "暂时无法连接电脑，请检查已配对的网络线路。";
        }
        showConnectionError(message + "\n" + target.origin());
    }

    void recheckEventStream(Uri uri) {
        if (uri == null || networkProbe != null || !"/api/events".equals(uri.getPath()) || !isTrustedOrigin(uri)) return;
        android.net.Network network = PairedNetwork.current(this);
        if (network != null) checkCurrentRoute(network);
    }

    private void checkCurrentRoute(android.net.Network network) {
        if (connectivity == null || !network.equals(connectivity.getActiveNetwork()) || isFinishing() || isDestroyed()
                || isDemoMode || !preferPairedRoutes || currentConfig == null || currentConfig.getRemoteHostId().isEmpty()
                || connectionAttempt != null) return;
        if (connectionFailed) {
            if (!authorizationFailed && new ServerConfigManager(this).isAutoConnectEnabled()) loadTargetUrl();
            return;
        }
        if (!workbenchLoaded) return;
        cancelNetworkProbe();
        final ServerConfig target = currentConfig;
        LanConnectionClient probe = PairedNetwork.client(this, network);
        networkProbe = probe;
        new Thread(() -> {
            LanConnectionClient.Selection selection = probe.select(target, java.util.Collections.emptyList(), false);
            runOnUiThread(() -> {
                if (networkProbe != probe || currentConfig != target || isFinishing() || isDestroyed()) return;
                networkProbe = null;
                switch (selection.result) {
                    case READY:
                        if (target.identifiedLan() && PairedNetwork.unchanged(this, network)) verifiedLanNetwork = network;
                        break;
                    case UNAVAILABLE:
                    case UNPROVEN:
                        loadTargetUrl();
                        break;
                    default:
                        reportRouteFailure(selection.result, target);
                }
            });
        }, "paired-route-check").start();
    }

    private void cancelNetworkProbe() {
        if (networkProbe != null) { networkProbe.cancel(); networkProbe = null; }
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
        updateToolbarVisibility();
    }

    public void showConnectionError(String detail) {
        snapshotPageReady = false;
        connectionFailed = true;
        currentPageTrusted = false;
        if (taskNotifications != null && !MobileNotificationService.ownsNotifications()) taskNotifications.disconnected();
        progressBar.setVisibility(View.GONE);
        if (tvModeBadge != null) tvModeBadge.setText(authorizationFailed ? "需配对" : "离线");
        if (errorOverlay == null) return;
        errorOverlay.setVisibility(View.VISIBLE);
        webView.setVisibility(View.INVISIBLE);
        updateToolbarVisibility();
        if (statusDot != null) {
            statusDot.setBackgroundTintList(getColorStateList(R.color.status_error));
        }
        tvErrorMessage.setText(detail);
        btnErrorRetry.setVisibility(authorizationFailed ? View.GONE : View.VISIBLE);
        btnErrorChangeServer.setText(authorizationFailed ? "重新配对" : "连接设置");
        if (offlineSnapshots != null) offlineSnapshots.connectionFailed(detail);
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

    private boolean canOpenWorkbenchSettings() {
        return !isDemoMode && currentPageTrusted && currentConfig != null && !isFinishing() && !isDestroyed()
            && webView.getVisibility() == View.VISIBLE;
    }

    boolean saveProjectFile(String scopeJson, String path, String name) {
        return trustedTaskNotificationPage() && projectFileDownload != null
            && projectFileDownload.request(scopeJson, path, name);
    }

    private ServerConfig trustedProjectFilePage() {
        if (!canOpenWorkbenchSettings() || connectionFailed || authorizationFailed) return null;
        String location = webView.getUrl();
        if (location == null) return null;
        Uri page = Uri.parse(location);
        String path = page.getPath();
        return isTrustedOrigin(page) && ("/".equals(path) || "/index.html".equals(path))
            && currentConfig.eligible()
            ? currentConfig : null;
    }

    public void openWorkbenchServerManager() {
        if (canOpenWorkbenchSettings()) openServerManager();
    }

    public void openApplicationSettings() {
        if (!canOpenWorkbenchSettings()) return;
        Intent intent = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.fromParts("package", getPackageName(), null));
        try { startActivity(intent); }
        catch (android.content.ActivityNotFoundException error) {
            Toast.makeText(this, "无法打开系统应用权限设置。", Toast.LENGTH_SHORT).show();
        }
    }

    public void openServerManager() {
        boolean returnToWorkbench = currentConfig != null || isDemoMode;
        Intent intent = new Intent(this, ServerConnectActivity.class);
        intent.putExtra("manual", true);
        intent.putExtra("returnToWorkbench", returnToWorkbench);
        startActivity(intent);
        if (!returnToWorkbench) finish();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == ProjectFileDownload.REQUEST_CODE) {
            if (projectFileDownload != null) projectFileDownload.onActivityResult(resultCode, data);
            return;
        }
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
        if ((offlineSnapshots != null && offlineSnapshots.showing()) || errorOverlay.getVisibility() == View.VISIBLE) {
            finish();
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
        connectivity = getSystemService(android.net.ConnectivityManager.class);
        if (connectivity != null) connectivity.registerDefaultNetworkCallback(networkCallback);
        continueBackgroundPermission();
        AppUpdateChecker.start(this);
        if (webView != null) webView.onResume();
        notifyTaskNotificationStatus();
        notifyQuestionNotificationStatus();
        deliverQuestionNotificationIntent();
        if (offlineSnapshots != null) offlineSnapshots.resume();
        if (connectionFailed && !authorizationFailed && new ServerConfigManager(this).isAutoConnectEnabled()) {
            errorOverlay.setVisibility(View.GONE);
            loadTargetUrl();
        }
    }

    @Override
    protected void onPause() {
        if (connectivity != null) { connectivity.unregisterNetworkCallback(networkCallback); connectivity = null; }
        cancelNetworkProbe();
        if (offlineSnapshots != null) offlineSnapshots.pause();
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
        if (offlineSnapshots != null) offlineSnapshots.destroy();
        if (taskNotifications != null && !MobileNotificationService.ownsNotifications()) taskNotifications.disconnected();
        cancelConnectionAttempt();
        navigationGeneration++;
        if (Build.VERSION.SDK_INT >= 33 && systemBackCallback != null) {
            getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(systemBackCallback);
        }
        cancelPendingFileUpload();
        if (projectFileDownload != null) projectFileDownload.close();
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
        }
        super.onDestroy();
    }
}
