package com.codexlight.android;

import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
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
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        if (request == null || request.getUrl() == null) {
            return true;
        }
        Uri uri = request.getUrl();
        if (activity.isTrustedOrigin(uri)) {
            return false;
        }
        String scheme = uri.getScheme();
        if ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) {
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
        if (activity.isTrustedOrigin(url != null ? Uri.parse(url) : null)) {
            String token = activity.getCurrentToken();
            if (token != null && !token.isEmpty()) {
                view.evaluateJavascript("try { if (!location.hash && window.CodexLightNative && window.CodexLightNative.getToken) { location.hash = '#token=' + encodeURIComponent(window.CodexLightNative.getToken()); } } catch(e){}", null);
            }
        }
    }

    @Override
    public void onPageFinished(WebView view, String url) {
        progressBar.setVisibility(android.view.View.GONE);
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (request != null && request.isForMainFrame()) {
            activity.showConnectionError("连接断开或无法访问");
        }
    }
}
