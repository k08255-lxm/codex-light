package com.codexlight.android;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.view.View;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.widget.ProgressBar;
import android.widget.Toast;

public class AppWebChromeClient extends WebChromeClient {
    private final MainActivity activity;
    private final ProgressBar progressBar;

    public AppWebChromeClient(MainActivity activity, ProgressBar progressBar) {
        this.activity = activity;
        this.progressBar = progressBar;
    }

    @Override
    public void onProgressChanged(WebView view, int newProgress) {
        if (progressBar == null) return;
        if (newProgress < 100) {
            progressBar.setVisibility(View.VISIBLE);
            progressBar.setProgress(newProgress);
        } else {
            progressBar.setVisibility(View.GONE);
        }
    }

    @Override
    public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
        // Settle any previous unclosed callback before starting a new picker request.
        activity.cancelPendingFileUpload();

        Intent intent = null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP && fileChooserParams != null) {
            try {
                intent = fileChooserParams.createIntent();
            } catch (Exception ignored) {}
        }
        if (intent == null) {
            intent = new Intent(Intent.ACTION_GET_CONTENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("*/*");
        }
        try {
            activity.startActivityForResult(Intent.createChooser(intent, "选择附件"), MainActivity.FILE_CHOOSER_REQUEST_CODE);
            activity.setFileUploadCallback(filePathCallback);
            return true;
        } catch (Exception e) {
            // Return true after cancelling filePathCallback once so WebView never performs a second internal cancel.
            if (filePathCallback != null) {
                filePathCallback.onReceiveValue(null);
            }
            Toast.makeText(activity, "无法启动文件选择器", Toast.LENGTH_SHORT).show();
            return true;
        }
    }
}
