package com.codexlight.android;

import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.function.BooleanSupplier;

/** Receives one explicit download from the paired desktop, without following redirects. */
final class ProjectFileTransfer {
    static final long MAX_BYTES = 64L * 1024 * 1024;
    static final String MIME = "application/octet-stream";
    private static final String ENDPOINT = "/api/files/download";
    private static final String TOO_LARGE = "文件超过 64 MiB，无法在手机保存。";
    interface ConnectionFactory { HttpURLConnection open(URL url) throws IOException; }
    private final ConnectionFactory connections;
    private volatile HttpURLConnection active;
    private volatile boolean cancelled;

    ProjectFileTransfer() {
        this(url -> (HttpURLConnection) url.openConnection());
    }

    ProjectFileTransfer(ConnectionFactory connections) {
        this.connections = connections;
    }

    static final class Failure extends IOException {
        Failure(String message) { super(message); }
    }

    boolean cancelled() { return cancelled; }

    void cancel() {
        cancelled = true;
        HttpURLConnection connection = active;
        if (connection != null) connection.disconnect();
    }

    void download(ServerConfig server, String body, OutputStream output) throws IOException {
        if (!server.eligible()) throw new Failure("请先配对电脑。");
        checkCancelled(this::cancelled);
        String origin = server.origin();
        HttpURLConnection connection = null;
        try {
            connection = connections.open(new URL(origin + ENDPOINT));
            active = connection;
            checkCancelled(this::cancelled);
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setConnectTimeout(10_000);
            connection.setReadTimeout(15_000);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setRequestProperty("Authorization", "Bearer " + server.getToken());
            connection.setRequestProperty("Origin", origin);
            connection.setRequestProperty("Accept", MIME);
            connection.setRequestProperty("Accept-Encoding", "identity");
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            byte[] request = body.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(request.length);
            try (OutputStream out = connection.getOutputStream()) { out.write(request); }
            int status = connection.getResponseCode();
            if (status != 200) throw failureForResponse(status);
            String contentType = connection.getContentType();
            String coding = connection.getContentEncoding();
            if (contentType == null || !MIME.equalsIgnoreCase(contentType.split(";", 2)[0].trim())
                    || (coding != null && !"identity".equalsIgnoreCase(coding))) {
                throw new Failure("电脑返回的文件格式无效。");
            }
            long expected = connection.getContentLengthLong();
            if (expected > MAX_BYTES) throw new Failure(TOO_LARGE);
            try (InputStream input = connection.getInputStream()) {
                copy(input, output, MAX_BYTES, expected, this::cancelled);
            }
        } finally {
            active = null;
            if (connection != null) connection.disconnect();
        }
    }

    static void copy(InputStream from, OutputStream to, long limit, long expected, BooleanSupplier cancelled) throws IOException {
        long deadline = System.nanoTime() + 300_000_000_000L;
        byte[] buffer = new byte[64 * 1024];
        long total = 0;
        while (true) {
            checkCancelled(cancelled);
            if (System.nanoTime() - deadline >= 0) throw new Failure("保存文件超时，请重试。");
            int count = from.read(buffer);
            if (count < 0) break;
            if (count > limit - total) throw new Failure(TOO_LARGE);
            if (expected >= 0 && count > expected - total) throw new Failure("文件大小与电脑的响应不一致。");
            to.write(buffer, 0, count);
            total += count;
        }
        checkCancelled(cancelled);
        if (expected >= 0 && total != expected) throw new Failure("文件未完整接收，请重试。");
    }

    static String safeName(String value) {
        String name = value == null ? "" : value.replaceAll("[\\\\/:*?\"<>|\\p{Cc}\\p{Cf}]", "_").trim();
        name = name.replaceAll("^\\.+|[. ]+$", "");
        if (name.isEmpty()) return "下载文件";
        if (name.getBytes(StandardCharsets.UTF_8).length <= 180) return name;
        int dot = name.lastIndexOf('.');
        String suffix = dot > 0 && name.length() - dot <= 16 ? name.substring(dot) : "";
        int remaining = 180 - suffix.getBytes(StandardCharsets.UTF_8).length;
        int end = 0;
        while (end < name.length()) {
            int codePoint = name.codePointAt(end);
            int bytes = codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
            if (bytes > remaining) break;
            remaining -= bytes;
            end += Character.charCount(codePoint);
        }
        return name.substring(0, end) + suffix;
    }

    private static void checkCancelled(BooleanSupplier cancelled) throws InterruptedIOException {
        if (cancelled.getAsBoolean()) throw new InterruptedIOException("保存已取消。");
    }

    private static Failure failureForResponse(int status) {
        if (status == 401) return new Failure("配对已失效，请重新配对电脑。");
        if (status == 403) return new Failure("电脑拒绝访问该文件。");
        if (status == 404) return new Failure("找不到文件，或电脑客户端需要更新。");
        if (status == 413) return new Failure(TOO_LARGE);
        if (status >= 300 && status < 400) return new Failure("电脑返回了跳转，文件未保存。");
        return new Failure("电脑未能提供文件（HTTP " + status + "）。");
    }
}
