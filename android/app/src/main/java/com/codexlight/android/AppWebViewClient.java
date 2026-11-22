package com.codexlight.android;

import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import java.io.ByteArrayInputStream;
import java.util.Collections;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ProgressBar;

public class AppWebViewClient extends WebViewClient {
    private final MainActivity activity;
    private final ProgressBar progressBar;

    public AppWebViewClient(MainActivity activity, ProgressBar progressBar) {
        this.activity = activity;
        this.progressBar = progressBar;
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        if (!activity.lanNetworkVerified() && activity.isTrustedOrigin(request.getUrl())) {
            return new WebResourceResponse("text/plain", "UTF-8", 503, "Verifying paired network",
                Collections.singletonMap("Cache-Control", "no-store"), new ByteArrayInputStream(new byte[0]));
        }
        return null;
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        if (request == null || request.getUrl() == null) {
            return true;
        }
        Uri uri = request.getUrl();
        if (activity.isTrustedOrigin(uri)) {
            return false;
        }
        String scheme = uri.getScheme();
        if (request.isForMainFrame() && request.hasGesture() && !request.isRedirect() && uri.getUserInfo() == null
                && ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))) {
            try {
                Intent extIntent = new Intent(Intent.ACTION_VIEW, uri);
                extIntent.addCategory(Intent.CATEGORY_BROWSABLE);
                activity.startActivity(extIntent);
            } catch (Exception ignored) {}
        }
        return true;
    }

    @Override
    public void onPageStarted(WebView view, String url, Bitmap favicon) {
        activity.updatePageOrigin(url);
        activity.hideConnectionError();
    }

    @Override
    public void onPageFinished(WebView view, String url) {
        progressBar.setVisibility(android.view.View.GONE);
        activity.showFinishedWorkbench(url);
        activity.deliverTaskNotificationIntent();
        activity.deliverQuestionNotificationIntent();
    }

    @Override
    public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
        if (request != null && response != null && response.getStatusCode() >= 400) {
            activity.recheckEventStream(request.getUrl());
        }
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (request != null && request.isForMainFrame()) {
            activity.showConnectionError("连接断开或无法访问");
        } else if (request != null) {
            activity.recheckEventStream(request.getUrl());
        }
    }
}
