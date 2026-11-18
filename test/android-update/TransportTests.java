package com.codexlight.android;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.security.cert.Certificate;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import javax.net.ssl.HttpsURLConnection;

public final class TransportTests {
    private static final String APK_URL = "https://github.com/k08255-lxm/codex-light/releases/download/v0.4.9/codex-light-0.4.9.apk";
    private static final String CDN = "https://release-assets.githubusercontent.com/candidate";
    private static final String APK = "codex-light-0.4.9.apk";
    private static final String HASH = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    private static final Map<String, Response> RESPONSES = new HashMap<>();
    private static final byte[] PAYLOAD = {'a', 'b', 'c'};

    public static void main(String[] args) throws Exception {
        if (args.length > 0 && "--live".equals(args[0])) {
            AppUpdateTransport.Release release = AppUpdateTransport.check(args[1]);
            require(release != null, "No notifying newer Android release");
            java.io.File target = new java.io.File(args[2]);
            AppUpdateTransport.download(release, target, bytes -> {}, () -> false);
            System.out.println("Verified " + release.apk.name + " (" + release.apk.size + " bytes) against GitHub release SHA256=" + release.sha256);
            return;
        }
        versionsAndHashes();
        streamedVerification();
        liveProtocolFixture(args.length > 0 && "--json".equals(args[0]));
        System.out.println("PASS: Android update version, checksum, stream, progress, cancellation and GitHub redirect policy");
    }

    private static void versionsAndHashes() throws Exception {
        require(AppUpdateTransport.compareVersions("0.4.10", "0.4.9") > 0, "Semantic version order");
        require(AppUpdateTransport.compareVersions("0.4.9", "0.4.9") == 0, "Equal version");
        require(AppUpdateTransport.compareVersions("0.4.8", "0.4.9") < 0, "Downgrade version");
        rejects(() -> AppUpdateTransport.compareVersions("0.04.9", "0.4.8"), "Noncanonical version");
        rejects(() -> AppUpdateTransport.compareVersions("0.4.9-rc1", "0.4.8"), "Prerelease version");
        String line = HASH + "  " + APK;
        require(HASH.equals(AppUpdateTransport.publishedHash("\uFEFF" + line + "\r\n", APK)), "Published checksum parsing");
        require(HASH.equals(AppUpdateTransport.publishedHash(HASH.toUpperCase() + " *" + APK, APK)), "Binary checksum format");
        rejects(() -> AppUpdateTransport.publishedHash(line + "\n" + line, APK), "Duplicate APK checksum");
        rejects(() -> AppUpdateTransport.publishedHash(line.replace("light-", "light-android-"), APK), "Silent APK checksum mismatch");
    }

    private static void streamedVerification() throws Exception {
        var release = new AppUpdateTransport.Release("0.4.9", new AppUpdateTransport.Asset(APK, APK_URL, 3, null), HASH);
        long[] progress = {0};
        var out = new ByteArrayOutputStream();
        AppUpdateTransport.copyVerified(release, new ByteArrayInputStream(PAYLOAD), out, value -> progress[0] = value, () -> false);
        require(Arrays.equals(PAYLOAD, out.toByteArray()) && progress[0] == PAYLOAD.length, "Verified bytes and progress");
        rejects(() -> copy(release, new byte[]{'a', 'b'}, false), "Truncated APK");
        rejects(() -> copy(release, new byte[]{'a', 'b', 'c', 'd'}, false), "Oversized APK");
        rejects(() -> copy(release, new byte[]{'x', 'y', 'z'}, false), "Tampered APK");
        rejects(() -> copy(release, PAYLOAD, true), "Cancelled download");
        require(AppUpdateTransport.trustedRedirect(new URL(APK_URL), CDN).toString().equals(CDN), "Official CDN redirect");
        rejects(() -> AppUpdateTransport.trustedRedirect(new URL(APK_URL), "http://release-assets.githubusercontent.com/x"), "HTTP downgraded redirect");
        rejects(() -> AppUpdateTransport.trustedRedirect(new URL(APK_URL), "https://release-assets.githubusercontent.com.example.net/x"), "Imposter redirect host");
        rejects(() -> AppUpdateTransport.trustedRedirect(new URL(APK_URL), "https://foo@release-assets.githubusercontent.com/x"), "Userinfo in redirect");
        rejects(() -> AppUpdateTransport.trustedRedirect(new URL(APK_URL), "https://release-assets.githubusercontent.com:443/x"), "Explicit noncanonical port");
    }

    private static void liveProtocolFixture(boolean json) throws Exception {
        URL.setURLStreamHandlerFactory(protocol -> !"https".equals(protocol) ? null : new java.net.URLStreamHandler() {
            @Override protected HttpsURLConnection openConnection(URL url) { return new Connection(url, RESPONSES.get(url.toString())); }
        });
        var release = new AppUpdateTransport.Release("0.4.9", new AppUpdateTransport.Asset(APK, APK_URL, 3, null), HASH);
        java.io.File target = java.io.File.createTempFile("update-test-", ".apk", new java.io.File(System.getProperty("java.io.tmpdir")));
        try {
            RESPONSES.put(APK_URL, new Response(302, CDN, null));
            RESPONSES.put(CDN, new Response(200, null, PAYLOAD));
            AppUpdateTransport.download(release, target, ignored -> {}, () -> false);
            require(Arrays.equals(java.nio.file.Files.readAllBytes(target.toPath()), PAYLOAD), "Redirected download writes expected bytes");
            RESPONSES.put(CDN, new Response(200, null, new byte[]{'a', 'b'}));
            rejects(() -> AppUpdateTransport.download(release, target, ignored -> {}, () -> false), "Content-Length mismatch");
            RESPONSES.put(APK_URL, new Response(302, "https://other.example.net/apk", null));
            rejects(() -> AppUpdateTransport.download(release, target, ignored -> {}, () -> false), "Unsafe redirect");
        } finally { target.delete(); }
        if (json) jsonMetadata();
    }

    private static void jsonMetadata() throws Exception {
        String api = "https://api.github.com/repos/k08255-lxm/codex-light/releases/latest";
        String sums = APK_URL.replace(APK, "SHA256SUMS.txt");
        String line = HASH + "  " + APK + "\n";
        RESPONSES.put(sums, new Response(200, null, line.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        String apk = "{\"name\":\"" + APK + "\",\"size\":3,\"digest\":\"sha256:" + HASH + "\",\"browser_download_url\":\"" + APK_URL + "\"}";
        String hashes = "{\"name\":\"SHA256SUMS.txt\",\"size\":" + line.length() + ",\"browser_download_url\":\"" + sums + "\"}";
        String prefix = "{\"tag_name\":\"v0.4.9\",\"draft\":false,\"prerelease\":false,\"assets\":[";
        fixtureJson(api, prefix + apk + "," + hashes + "]}");
        var release = AppUpdateTransport.check("0.4.8");
        require(release != null && release.version.equals("0.4.9") && release.sha256.equals(HASH), "Matched release and checksum");
        require(AppUpdateTransport.check("0.4.9") == null, "No update for same version");
        fixtureJson(api, prefix + apk.replace(APK, "codex-light-android-0.4.9.apk") + "," + hashes + "]}");
        require(AppUpdateTransport.check("0.4.8") == null, "Silent release is not offered");
        fixtureJson(api, prefix + apk + "," + apk + "," + hashes + "]}");
        rejects(() -> AppUpdateTransport.check("0.4.8"), "Duplicate APK asset");
        fixtureJson(api, prefix + apk.replace(HASH, "0".repeat(64)) + "," + hashes + "]}");
        rejects(() -> AppUpdateTransport.check("0.4.8"), "Inconsistent GitHub digest");
        System.out.println("PASS: complete GitHub metadata and release checksum fixtures");
    }

    private static void fixtureJson(String url, String json) {
        RESPONSES.put(url, new Response(200, null, json.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
    }

    private static void copy(AppUpdateTransport.Release release, byte[] bytes, boolean cancel) throws IOException {
        AppUpdateTransport.copyVerified(release, new ByteArrayInputStream(bytes), new ByteArrayOutputStream(), ignored -> {}, () -> cancel);
    }

    @FunctionalInterface interface Operation { void run() throws Exception; }
    private static void rejects(Operation action, String scenario) throws Exception {
        try { action.run(); } catch (AppUpdateTransport.Failure expected) { return; }
        throw new AssertionError("Accepted invalid update: " + scenario);
    }
    private static void require(boolean condition, String scenario) { if (!condition) throw new AssertionError(scenario); }

    private static final class Response {
        final int code;
        final String location;
        final byte[] body;
        Response(int code, String location, byte[] body) { this.code = code; this.location = location; this.body = body; }
    }

    private static final class Connection extends HttpsURLConnection {
        final Response response;
        Connection(URL url, Response response) { super(url); this.response = response; }
        @Override public int getResponseCode() {
            require(!getInstanceFollowRedirects(), "Reject automatic HTTP redirects");
            require(response != null, "Unexpected HTTPS request: " + getURL());
            return response.code;
        }
        @Override public String getHeaderField(String name) { return "Location".equalsIgnoreCase(name) ? response.location : null; }
        @Override public long getContentLengthLong() { return response.body == null ? -1 : response.body.length; }
        @Override public InputStream getInputStream() { return new ByteArrayInputStream(response.body); }
        @Override public void disconnect() {}
        @Override public boolean usingProxy() { return false; }
        @Override public void connect() {}
        @Override public String getCipherSuite() { return ""; }
        @Override public Certificate[] getLocalCertificates() { return null; }
        @Override public Certificate[] getServerCertificates() { return null; }
    }
}
