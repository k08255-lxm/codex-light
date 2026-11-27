package com.codexlight.android;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;
import java.util.function.BooleanSupplier;
import java.util.function.LongConsumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

final class AppUpdateTransport {
    private static final int RELEASE_LIMIT = 30;
    private static final String API = "https://api.github.com/repos/k08255-lxm/codex-light/releases?per_page=" + RELEASE_LIMIT;
    private static final String RELEASES = "https://github.com/k08255-lxm/codex-light/releases/";
    private static final String CHECKSUMS = "SHA256SUMS.txt";
    private static final int MAX_RELEASE = 2 * 1024 * 1024;
    private static final int MAX_CHECKSUMS = 128 * 1024;
    private static final long MAX_APK = 300L * 1024 * 1024;
    private static final Pattern VERSION = Pattern.compile("(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})");
    private static final Pattern HASH = Pattern.compile("[a-fA-F0-9]{64}");
    private static final Pattern CHECKSUM_LINE = Pattern.compile("([a-fA-F0-9]{64})\\s+\\*?(.+?)\\s*");

    static final class Failure extends IOException {
        Failure(String message) { super(message); }
    }

    static final class Asset {
        final String name;
        final String url;
        final long size;
        final String digest;
        Asset(String name, String url, long size, String digest) {
            this.name = name; this.url = url; this.size = size; this.digest = digest;
        }
    }

    static final class Release {
        final String version;
        final Asset apk;
        final String sha256;
        final String notes;
        Release(String version, Asset apk, String sha256) {
            this(version, apk, sha256, "");
        }
        Release(String version, Asset apk, String sha256, String notes) {
            this.version = version; this.apk = apk; this.sha256 = sha256; this.notes = notes;
        }
        boolean matches(Release other) {
            return other != null && version.equals(other.version) && apk.size == other.apk.size && sha256.equals(other.sha256);
        }
    }

    static Release check(String current) throws IOException, JSONException {
        if (!VERSION.matcher(current == null ? "" : current).matches()) throw new Failure("应用版本格式无效");
        JSONArray releases = new JSONArray(new String(read(API, MAX_RELEASE, -1, true), StandardCharsets.UTF_8));
        if (releases.length() > RELEASE_LIMIT) throw new Failure("更新版本列表超出上限");
        String version = current;
        JSONObject selected = null;
        Asset apk = null;
        for (int i = 0; i < releases.length(); i++) {
            JSONObject document = releases.getJSONObject(i);
            String tag = document.optString("tag_name");
            if (!tag.startsWith("v") || document.optBoolean("draft") || document.optBoolean("prerelease")) continue;
            String candidate = tag.substring(1);
            if (!VERSION.matcher(candidate).matches() || compareVersions(candidate, version) <= 0) continue;
            // Only the standard APK name opts in to Android update notifications.
            // A desktop-only release must not hide a previous eligible Android update.
            Asset candidateApk = findAsset(document.getJSONArray("assets"), tag, "codex-light-" + candidate + ".apk", MAX_APK);
            if (candidateApk == null) continue;
            version = candidate;
            selected = document;
            apk = candidateApk;
        }
        if (selected == null) return null;
        Asset checksums = findAsset(selected.getJSONArray("assets"), "v" + version, CHECKSUMS, MAX_CHECKSUMS);
        if (checksums == null) throw new Failure("发布版本缺少 SHA256 校验文件");
        byte[] bytes = read(checksums.url, MAX_CHECKSUMS, checksums.size, false);
        String sha256 = publishedHash(new String(bytes, StandardCharsets.UTF_8), apk.name);
        if (apk.digest != null && !apk.digest.equals("sha256:" + sha256)) {
            throw new Failure("GitHub 摘要与发布校验文件不一致");
        }
        String notes = selected.optString("body","").trim();
        return new Release(version, apk, sha256, notes.length() > 8000 ? notes.substring(0,8000) + "…" : notes);
    }

    static int compareVersions(String candidate, String installed) throws IOException {
        Matcher left = VERSION.matcher(candidate == null ? "" : candidate);
        Matcher right = VERSION.matcher(installed == null ? "" : installed);
        if (!left.matches() || !right.matches()) throw new Failure("应用版本格式无效");
        for (int group = 1; group <= 3; group++) {
            int order = Integer.compare(Integer.parseInt(left.group(group)), Integer.parseInt(right.group(group)));
            if (order != 0) return order;
        }
        return 0;
    }

    static Asset findAsset(JSONArray assets, String tag, String name, long limit) throws IOException, JSONException {
        Asset found = null;
        for (int i = 0; i < assets.length(); i++) {
            JSONObject asset = assets.getJSONObject(i);
            if (!name.equals(asset.optString("name"))) continue;
            String url = RELEASES + "download/" + tag + "/" + name;
            Object sizeValue = asset.get("size");
            if (found != null || !url.equals(asset.optString("browser_download_url")) ||
                !(sizeValue instanceof Integer || sizeValue instanceof Long)) throw new Failure("发布资产元数据无效");
            long size = ((Number) sizeValue).longValue();
            if (size < 1 || size > limit) throw new Failure("发布资产大小无效");
            String digest = asset.isNull("digest") ? null : asset.getString("digest");
            if (digest != null && (!digest.startsWith("sha256:") || !HASH.matcher(digest.substring(7)).matches())) {
                throw new Failure("GitHub 发布资产摘要无效");
            }
            found = new Asset(name, url, size, digest == null ? null : digest.toLowerCase(Locale.ROOT));
        }
        return found;
    }

    static String publishedHash(String checksums, String name) throws IOException {
        String result = null;
        if (checksums.startsWith("\uFEFF")) checksums = checksums.substring(1);
        for (String line : checksums.split("\\r?\\n")) {
            Matcher match = CHECKSUM_LINE.matcher(line);
            if (!match.matches() || !name.equals(match.group(2))) continue;
            if (result != null) throw new Failure("发布校验文件有重复的 APK 条目");
            result = match.group(1).toLowerCase(Locale.ROOT);
        }
        if (result == null) throw new Failure("发布校验文件没有对应的 APK SHA256");
        return result;
    }

    static void download(Release release, File destination, LongConsumer progress, BooleanSupplier cancelled) throws IOException {
        Asset apk = release.apk;
        HttpsURLConnection connection = open(apk.url, false);
        try {
            checkDeclaredSize(connection, apk.size, apk.size);
            try (InputStream from = connection.getInputStream(); FileOutputStream to = new FileOutputStream(destination)) {
                copyVerified(release, from, to, progress, cancelled);
            }
        } finally {
            connection.disconnect();
        }
    }

    static void copyVerified(Release release, InputStream from, OutputStream to, LongConsumer progress, BooleanSupplier cancelled) throws IOException {
        long expected = release.apk.size;
        MessageDigest sha256 = sha256();
        long deadline = System.nanoTime() + 15L * 60 * 1_000_000_000;
        long received = 0;
        byte[] buffer = new byte[65536];
        while (received < expected) {
            if (cancelled.getAsBoolean()) throw new Failure("已取消复制 APK");
            if (System.nanoTime() - deadline >= 0) throw new Failure("读取 APK 超时");
            int read = from.read(buffer, 0, (int) Math.min(buffer.length, expected - received));
            if (read < 0) throw new Failure("APK 大小小于发布声明");
            to.write(buffer, 0, read);
            sha256.update(buffer, 0, read);
            received += read;
            progress.accept(received);
        }
        if (from.read() != -1) throw new Failure("APK 大小超出发布声明");
        if (!release.sha256.equals(hex(sha256.digest()))) throw new Failure("APK 的 SHA256 与发布摘要不一致");
    }

    private static byte[] read(String url, int max, long exact, boolean api) throws IOException {
        HttpsURLConnection connection = open(url, api);
        try {
            checkDeclaredSize(connection, max, exact);
            try (InputStream stream = connection.getInputStream(); ByteArrayOutputStream buffer = new ByteArrayOutputStream()) {
                byte[] chunk = new byte[4096];
                long deadline = System.nanoTime() + 30L * 1_000_000_000;
                int length;
                while ((length = stream.read(chunk)) != -1) {
                    if (buffer.size() + length > max) throw new Failure("更新响应过大");
                    if (System.nanoTime() - deadline >= 0) throw new Failure("读取更新信息超时");
                    buffer.write(chunk, 0, length);
                }
                if (buffer.size() == 0 || (exact >= 0 && buffer.size() != exact)) throw new Failure("更新响应大小不匹配");
                return buffer.toByteArray();
            }
        } finally {
            connection.disconnect();
        }
    }

    private static void checkDeclaredSize(HttpsURLConnection connection, long max, long exact) throws IOException {
        long size = connection.getContentLengthLong();
        if (size > max || (size >= 0 && exact >= 0 && size != exact)) throw new Failure("更新响应大小不匹配");
    }

    static URL trustedRedirect(URL from, String location) throws IOException {
        if (location == null || location.isEmpty()) throw new Failure("发布资产重定向缺少目标");
        URL next = new URL(from, location);
        requireHttps(next);
        String host = next.getHost();
        if (!"release-assets.githubusercontent.com".equals(host) && !"objects.githubusercontent.com".equals(host) &&
            !"github-releases.githubusercontent.com".equals(host)) throw new Failure("发布资产重定向超出 GitHub 下载来源");
        return next;
    }

    private static void requireHttps(URL url) throws IOException {
        if (!"https".equals(url.getProtocol()) || url.getUserInfo() != null || url.getPort() != -1 || url.getRef() != null) {
            throw new Failure("更新仅允许可信 HTTPS 地址");
        }
    }

    private static HttpsURLConnection open(String source, boolean api) throws IOException {
        if (api ? !API.equals(source) : !source.startsWith(RELEASES + "download/")) throw new Failure("更新来源不匹配");
        URL url = new URL(source);
        requireHttps(url);
        for (int redirects = 0; redirects <= 4; redirects++) {
            HttpsURLConnection connection = (HttpsURLConnection) url.openConnection();
            boolean accepted = false;
            try {
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(10000);
                connection.setReadTimeout(15000);
                connection.setRequestProperty("Accept", api ? "application/vnd.github+json" : "application/octet-stream");
                connection.setRequestProperty("Accept-Encoding", "identity");
                connection.setRequestProperty("User-Agent", "CodeCang-Android");
                int code = connection.getResponseCode();
                if (code == 200) { accepted = true; return connection; }
                if (!api && (code == 301 || code == 302 || code == 303 || code == 307 || code == 308)) {
                    url = trustedRedirect(url, connection.getHeaderField("Location"));
                } else {
                    throw new Failure("更新请求失败（HTTP " + code + "）");
                }
            } finally {
                if (!accepted) connection.disconnect();
            }
        }
        throw new Failure("发布资产重定向次数过多");
    }

    static MessageDigest sha256() {
        try { return MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException unavailable) { throw new AssertionError(unavailable); }
    }

    static String hex(byte[] bytes) {
        char[] output = new char[bytes.length * 2];
        String alphabet = "0123456789abcdef";
        for (int i = 0; i < bytes.length; i++) {
            output[2 * i] = alphabet.charAt((bytes[i] & 0xff) >>> 4);
            output[2 * i + 1] = alphabet.charAt(bytes[i] & 0xf);
        }
        return new String(output);
    }
}
