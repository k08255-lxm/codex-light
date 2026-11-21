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
        acceptTaskNotificationIntent(getIntent());
        if (QuestionNotificationController.ACTION_OPEN.equals(getIntent().getAction())) pendingQuestion = questionNotifications.consume(getIntent());
        resolveIntent();
        MobileNotificationService.stopIfTargetChanged(this,isDemoMode ? null : currentConfig);
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
            pendingQuestion = questionNotifications.consume(intent);
            deliverQuestionNotificationIntent();
            return;
        }
        if (acceptTaskNotificationIntent(intent)) {
            deliverTaskNotificationIntent();
            return;
        }
        setIntent(intent);
        resolveIntent();
        MobileNotificationService.stopIfTargetChanged(this,isDemoMode ? null : currentConfig);
        loadTargetUrl();
    }

    private void resolveIntent() {
        Intent intent = getIntent();
        isDemoMode = intent.getBooleanExtra("demo", false);

        if (!isDemoMode) {
            ServerConfigManager saved = new ServerConfigManager(this);
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

    public String getCurrentToken() {
        if (isDemoMode || !currentPageTrusted || currentConfig == null) {
            return "";
        }
        return currentConfig.getToken();
    }

    public boolean trustedTaskNotificationPage() {
        return !isDemoMode && currentPageTrusted && currentConfig != null && !isFinishing() && !isDestroyed();
    }

    public String getTaskNotificationStatus() {
        return trustedTaskNotificationPage() && taskNotifications != null
            ? taskNotifications.status() : "{\"supported\":false}";
    }

    public void setTaskNotificationsEnabled(boolean enabled) {
        if (trustedTaskNotificationPage() && taskNotifications != null) {
            taskNotifications.setEnabled(enabled,this);
            notifyTaskNotificationStatus();
        }
    }

    public void openTaskNotificationSettings() {
        if (trustedTaskNotificationPage() && taskNotifications != null) taskNotifications.openSettings(this);
    }

    public void openLiveUpdateSettings() {
        if (canOpenWorkbenchSettings() && taskNotifications != null) taskNotifications.openPromotionSettings(this);
    }

    public void setBackgroundNotifications(boolean enabled, boolean questionsEnabled) {
        if (!canOpenWorkbenchSettings() || !hasWindowFocus()) return;
        MobileNotificationService.setQuestionAlerts(questionsEnabled);
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
        if (trustedTaskNotificationPage() && questionNotifications != null) questionNotifications.requestPermission(this);
    }

    public void setBackgroundQuestionAlerts(boolean enabled) {
        if (!trustedTaskNotificationPage()) return;
        MobileNotificationService.setQuestionAlerts(enabled);
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
            if (MobileNotificationService.ownsNotifications()) MobileNotificationService.refreshFromWeb();
            else taskNotifications.update(json);
            deliverTaskNotificationIntent();
        }
    }

    private boolean acceptTaskNotificationIntent(Intent intent) {
        if (intent == null || !TaskNotificationController.ACTION_OPEN.equals(intent.getAction())) return false;
        String threadId = intent.getStringExtra("threadId");
        String turnId = intent.getStringExtra("turnId");
        if (TaskNotificationState.validId(threadId) && TaskNotificationState.validId(turnId)) {
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
        settings.setUserAgentString(defaultUa + " CodexLightMobile/0.4.14");

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
        snapshotPageReady = false;
        requestedToolbarIntegrated = false;
        webView.setVisibility(View.INVISIBLE);
        errorOverlay.setVisibility(View.GONE);
        if (offlineSnapshots != null) offlineSnapshots.beginConnection(isDemoMode ? null : currentConfig);
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
            // Legacy LAN transport is HTTP and does not authenticate the desktop cryptographically.
            currentPageTrusted = false;
            tvServerTitle.setText("连接电脑");
            if (tvModeBadge != null) tvModeBadge.setText("LAN");
            statusDot.setBackgroundTintList(getColorStateList(R.color.status_warning));
            tvModeBadge.setText("连接中");
            progressBar.setVisibility(View.VISIBLE);
            final int attemptId = connectionGeneration;
            final ServerConfig target = currentConfig;
            final LanConnectionClient attempt = new LanConnectionClient(url -> (java.net.HttpURLConnection) url.openConnection());
            connectionAttempt = attempt;
            new Thread(() -> {
                LanConnectionClient.Result result = attempt.check(target);
                runOnUiThread(() -> {
                    if (attemptId != connectionGeneration || isFinishing() || isDestroyed()) return;
                    connectionAttempt = null;
                    progressBar.setVisibility(View.GONE);
                    if (result == LanConnectionClient.Result.READY) {
                        ServerConfigManager manager = new ServerConfigManager(this);
                        manager.saveCurrent(target, "");
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
        tvErrorMessage.setText(detail + (currentConfig == null ? "" : "\n\n目标地址：" + currentConfig.toDisplayAddress()));
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
            && ReconnectPolicy.eligible(currentConfig.getHost(), currentConfig.getPort(), currentConfig.getToken())
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
