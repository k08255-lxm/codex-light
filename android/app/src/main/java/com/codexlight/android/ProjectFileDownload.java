package com.codexlight.android;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.webkit.MimeTypeMap;
import android.webkit.WebView;
import android.widget.Toast;
import org.json.JSONException;
import org.json.JSONObject;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.SocketTimeoutException;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.IntSupplier;
import java.util.function.Supplier;

/** Keeps the native document picker and one bounded transfer tied to their paired page. */
final class ProjectFileDownload {
    static final int REQUEST_CODE = 1004;
    private static final String ACTIVATED_PAGE = "window.top === window && document.visibilityState === 'visible'"
        + " && !!(navigator.userActivation && navigator.userActivation.isActive)";
    private final Activity activity;
    private final WebView webView;
    private final Supplier<ServerConfig> trustedPage;
    private final IntSupplier pageGeneration;
    private final AtomicBoolean busy = new AtomicBoolean();
    private volatile boolean closed;
    private Pending authorizing;
    private Pending pending;
    private ProjectFileTransfer transfer;

    ProjectFileDownload(Activity activity, WebView webView, Supplier<ServerConfig> trustedPage, IntSupplier pageGeneration) {
        this.activity = activity;
        this.webView = webView;
        this.trustedPage = trustedPage;
        this.pageGeneration = pageGeneration;
    }

    private static final class Request {
        final String body;
        final String name;
        Request(String scopeJson, String path, String name) throws JSONException {
            if (scopeJson == null || scopeJson.length() > 2048 || path == null || path.length() > 4096
                    || path.trim().isEmpty() || path.matches("(?s).*[\\x00-\\x1f\\x7f].*")
                    || (name != null && name.length() > 4096)) throw new JSONException("Invalid file reference");
            JSONObject scope = new JSONObject(scopeJson);
            String key = scope.has("threadId") ? "threadId" : "projectId";
            Object id = scope.opt(key);
            if (scope.length() != 1 || !(id instanceof String)
                    || !((String) id).matches("[^\\x00-\\x20\\x7f]{1,256}")) throw new JSONException("Invalid file scope");
            this.body = new JSONObject().put(key, id).put("path", path).toString();
            this.name = ProjectFileTransfer.safeName(name);
        }
    }

    private static final class Pending {
        final Request request;
        final ServerConfig server;
        final int generation;
        Pending(Request request, ServerConfig server, int generation) {
            this.request = request;
            this.server = server;
            this.generation = generation;
        }
    }

    boolean request(String scopeJson, String path, String name) {
        final Request request;
        try { request = new Request(scopeJson, path, name); }
        catch (JSONException invalid) { return false; }
        if (closed || !busy.compareAndSet(false, true)) return false;
        activity.runOnUiThread(() -> begin(request));
        return true;
    }

    private void begin(Request request) {
        ServerConfig server = trustedPage.get();
        if (closed || server == null || !activity.hasWindowFocus()) {
            finish("请在已配对的工作台中保存文件。");
            return;
        }
        Pending operation = new Pending(request, server, pageGeneration.getAsInt());
        authorizing = operation;
        webView.postDelayed(() -> {
            if (authorizing != operation) return;
            authorizing = null;
            finish("无法确认页面操作，请重新点按「保存文件」。");
        }, 2000);
        webView.evaluateJavascript(ACTIVATED_PAGE, active -> {
            if (authorizing != operation) return;
            authorizing = null;
            if (!"true".equals(active) || !stillTrusted(operation) || !activity.hasWindowFocus()) {
                finish("请点按「保存文件」后重试。");
                return;
            }
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType(documentMime(request.name))
                .putExtra(Intent.EXTRA_TITLE, request.name);
            pending = operation;
            try { activity.startActivityForResult(intent, REQUEST_CODE); }
            catch (RuntimeException unavailable) {
                pending = null;
                finish("无法打开系统文件保存对话框。");
            }
        });
    }

    private static String documentMime(String name) {
        int dot = name.lastIndexOf('.');
        String mime = dot < 0 ? null : MimeTypeMap.getSingleton()
            .getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase(Locale.ROOT));
        return mime == null ? ProjectFileTransfer.MIME : mime;
    }

    private boolean stillTrusted(Pending operation) {
        return !closed && trustedPage.get() == operation.server && pageGeneration.getAsInt() == operation.generation;
    }

    void onActivityResult(int resultCode, Intent data) {
        Pending operation = pending;
        pending = null;
        if (operation == null) return;
        if (resultCode != Activity.RESULT_OK) {
            finish("已取消保存文件。");
            return;
        }
        Uri destination = data == null ? null : data.getData();
        if (destination == null || !"content".equals(destination.getScheme())
                || !DocumentsContract.isDocumentUri(activity, destination)) {
            finish("未取得有效的文件保存位置。");
            return;
        }
        ProjectFileTransfer job = new ProjectFileTransfer();
        if (!stillTrusted(operation)) job.cancel();
        transfer = job;
        new Thread(() -> save(operation, destination, job), "codex-light-project-download").start();
    }

    private void save(Pending operation, Uri destination, ProjectFileTransfer job) {
        File temporary = null;
        boolean saved = false;
        boolean writingDestination = false;
        String feedback;
        try {
            if (job.cancelled()) throw new ProjectFileTransfer.Failure("工作台已切换，请重新发起保存。");
            temporary = File.createTempFile("project-download-", ".part", activity.getCacheDir());
            ServerConfig server = operation.server;
            try (OutputStream output = new FileOutputStream(temporary)) {
                job.download(server.getHost(), server.getPort(), server.getToken(), operation.request.body, output);
            }
            try (InputStream input = new FileInputStream(temporary)) {
                if (job.cancelled()) throw new ProjectFileTransfer.Failure("保存已取消。");
                writingDestination = true;
                try (OutputStream output = activity.getContentResolver().openOutputStream(destination, "wt")) {
                    if (output == null) throw new ProjectFileTransfer.Failure("无法写入选定的保存位置。");
                    ProjectFileTransfer.copy(input, output, ProjectFileTransfer.MAX_BYTES, temporary.length(), job::cancelled);
                }
            }
            saved = true;
            feedback = "文件已保存。";
        } catch (SocketTimeoutException timeout) {
            feedback = "保存文件超时，请重试。";
        } catch (ProjectFileTransfer.Failure failure) {
            feedback = failure.getMessage();
        } catch (IOException | SecurityException failure) {
            feedback = "保存文件失败，请检查连接和保存位置后重试。";
        } finally {
            if (temporary != null) temporary.delete();
        }
        if (!saved && writingDestination) feedback += " 请在保存位置检查文件是否完整。";
        final String message = feedback;
        activity.runOnUiThread(() -> {
            transfer = null;
            finish(message);
        });
    }

    private void finish(String message) {
        busy.set(false);
        if (!closed && !activity.isFinishing() && !activity.isDestroyed()) {
            Toast.makeText(activity, message, Toast.LENGTH_LONG).show();
        }
    }

    void close() {
        closed = true;
        authorizing = null;
        pending = null;
        if (transfer != null) transfer.cancel();
    }
}
