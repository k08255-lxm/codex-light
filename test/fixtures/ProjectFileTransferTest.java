package com.codexlight.android;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

public final class ProjectFileTransferTest {
    private static final String TOKEN = "a".repeat(64);
    private static final String BODY = "{\"threadId\":\"sample\",\"path\":\"C:/project/文件.zip\"}";
    private static final byte[] CONTENT = {0, 1, 2, (byte)255};

    private static final class Response extends HttpURLConnection {
        int status = 200;
        int fileReads = 0;
        boolean disconnected;
        long size = CONTENT.length;
        String mime = ProjectFileTransfer.MIME;
        String encoding = null;
        final ByteArrayOutputStream request = new ByteArrayOutputStream();
        Response(String url) throws IOException { super(new URL(url)); }
        public void disconnect() { disconnected = true; }
        public boolean usingProxy() { return false; }
        public void connect() {}
        public int getResponseCode() { return status; }
        public long getContentLengthLong() { return size; }
        public String getContentType() { return mime; }
        public String getContentEncoding() { return encoding; }
        public OutputStream getOutputStream() { return request; }
        public InputStream getInputStream() { fileReads++; return new ByteArrayInputStream(CONTENT); }
    }

    interface Action { void run() throws IOException; }

    private static void require(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    private static void reject(Action action, String message) throws IOException {
        try { action.run(); }
        catch (IOException expected) { require(expected.getMessage().contains(message), expected.getMessage()); return; }
        throw new AssertionError("Unexpected success");
    }

    private static ProjectFileTransfer client(Response response, int port) {
        String origin = "http://192.168.0.42" + (port == 80 ? "" : ":" + port);
        return new ProjectFileTransfer(url -> {
            require((origin + "/api/files/download").equals(url.toString()), "Unexpected endpoint");
            return response;
        });
    }

    public static void main(String[] args) throws Exception {
        Response accepted = new Response("http://192.168.0.42:57529/api/files/download");
        ByteArrayOutputStream data = new ByteArrayOutputStream();
        client(accepted, 57529).download("192.168.0.42", 57529, TOKEN, BODY, data);
        require(Arrays.equals(data.toByteArray(), CONTENT), "Changed binary file");
        require("POST".equals(accepted.getRequestMethod()), "Expected POST");
        require(("Bearer " + TOKEN).equals(accepted.getRequestProperty("Authorization")), "Missing local authentication");
        require("http://192.168.0.42:57529".equals(accepted.getRequestProperty("Origin")), "Wrong origin header");
        require(BODY.equals(accepted.request.toString(StandardCharsets.UTF_8)), "Changed UTF-8 JSON");
        require(!accepted.getInstanceFollowRedirects() && accepted.disconnected, "Connection lifecycle");

        Response refused = new Response("http://192.168.0.42/api/files/download");
        ProjectFileTransfer client = client(refused, 80);
        for (int code : new int[]{301,302,303,307,308}) {
            refused.status = code;
            reject(() -> client.download("192.168.0.42", 80, TOKEN, BODY, data), "跳转");
        }
        refused.status = 200;
        refused.mime = "text/html";
        reject(() -> client.download("192.168.0.42", 80, TOKEN, BODY, data), "文件格式");
        refused.mime = ProjectFileTransfer.MIME;
        refused.encoding = "gzip";
        reject(() -> client.download("192.168.0.42", 80, TOKEN, BODY, data), "文件格式");
        refused.encoding = null;
        refused.size = ProjectFileTransfer.MAX_BYTES + 1;
        reject(() -> client.download("192.168.0.42", 80, TOKEN, BODY, data), "64 MiB");
        require(refused.fileReads == 0, "Read a rejected response");
        reject(() -> client.download("203.0.113.1", 80, TOKEN, BODY, data), "配对");
        client.cancel();
        reject(() -> client.download("192.168.0.42", 80, TOKEN, BODY, data), "取消");

        for (long expected : new long[]{-1, CONTENT.length}) {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            ProjectFileTransfer.copy(new ByteArrayInputStream(CONTENT), output, CONTENT.length, expected, () -> false);
            require(Arrays.equals(output.toByteArray(), CONTENT), "Exact cap should be accepted");
        }
        reject(() -> ProjectFileTransfer.copy(new ByteArrayInputStream(CONTENT), data, 3, -1, () -> false), "64 MiB");
        reject(() -> ProjectFileTransfer.copy(new ByteArrayInputStream(CONTENT), data, 9, 5, () -> false), "未完整接收");
        reject(() -> ProjectFileTransfer.copy(new ByteArrayInputStream(CONTENT), data, 9, 2, () -> false), "大小");
        reject(() -> ProjectFileTransfer.copy(new ByteArrayInputStream(CONTENT), data, 9, -1, () -> true), "取消");
        require("下载文件".equals(ProjectFileTransfer.safeName("..")), "Dot name accepted");
        require(!ProjectFileTransfer.safeName("../路径\\a\r\n?.pdf").matches("(?s).*[\\\\/\\x00-\\x1f].*"), "Unsafe name accepted");
        String name = ProjectFileTransfer.safeName("报表".repeat(100) + ".pdf");
        require(name.endsWith(".pdf") && name.getBytes(StandardCharsets.UTF_8).length <= 180, "Bounded Unicode name/extension");
        System.out.println("Project file transfer checks passed");
    }
}
