package com.codexlight.android;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.text.DateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Inert, bounded text only: no URL, script, DOM, input draft or authentication metadata. */
final class OfflineSnapshotData {
    static final int MAX_TEXT = 100_000;
    static final int MAX_BYTES = 512 * 1024;
    final String title, page, text;
    final long savedAt;

    OfflineSnapshotData(String title, String page, String text, long savedAt, String token) {
        if (title == null || page == null || text == null || title.length() > 160 || page.length() > 160
                || text.trim().isEmpty() || text.length() > MAX_TEXT || savedAt <= 0) {
            throw new IllegalArgumentException("Invalid offline snapshot");
        }
        this.title = boundedRedacted(title, token, 160);
        this.page = boundedRedacted(page, token, 160);
        this.text = boundedRedacted(text, token, MAX_TEXT);
        this.savedAt = savedAt;
    }

    static String key(String scheme, String host, int port, String remoteHostId) {
        if (host == null || host.isEmpty() || port < 1 || port > 65535) throw new IllegalArgumentException("Invalid server");
        try {
            // Preserve the keys used by existing HTTP snapshots after upgrade.
            String prefix = "http".equals(scheme) ? "" : scheme + "://";
            String identity = prefix + host.toLowerCase(Locale.ROOT) + ":" + port;
            if (!remoteHostId.isEmpty()) identity += "#" + remoteHostId;
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(identity.getBytes(StandardCharsets.UTF_8));
            StringBuilder key = new StringBuilder();
            for (byte value : digest) key.append(String.format(Locale.ROOT, "%02x", value & 255));
            return key.toString();
        } catch (NoSuchAlgorithmException impossible) { throw new AssertionError(impossible); }
    }

    private static String redact(String value, String token) {
        String result = token == null || token.isEmpty() ? value : value.replace(token, "[访问令牌已隐藏]");
        return result.replaceAll("(?i)([?&#](?:token|pair)=)[^\\s]+", "$1[已隐藏]")
            .replaceAll("(?i)Bearer\\s+[A-Za-z0-9._~+/-]+=*", "Bearer [已隐藏]");
    }

    private static String boundedRedacted(String value, String token, int limit) {
        String clean = redact(value, token);
        if (clean.length() <= limit) return clean;
        int end = limit;
        if (Character.isHighSurrogate(clean.charAt(end - 1)) && Character.isLowSurrogate(clean.charAt(end))) end--;
        return clean.substring(0, end);
    }

    static List<String> staleSnapshotKeys(Map<String, Long> modified, String currentKey) {
        List<String> identities = new ArrayList<>(modified.keySet());
        identities.sort((left, right) -> {
            if (left.equals(right)) return 0;
            if (left.equals(currentKey)) return -1;
            if (right.equals(currentKey)) return 1;
            return Long.compare(modified.get(right), modified.get(left));
        });
        return identities.subList(Math.min(8, identities.size()), identities.size());
    }

    byte[] encode() throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (DataOutputStream out = new DataOutputStream(bytes)) {
            out.writeInt(0x43434f31);
            out.writeLong(savedAt);
            write(out, title); write(out, page); write(out, text);
        }
        if (bytes.size() > MAX_BYTES) throw new IOException("Offline snapshot is too large");
        return bytes.toByteArray();
    }

    static OfflineSnapshotData decode(byte[] bytes) throws IOException {
        if (bytes == null || bytes.length > MAX_BYTES) throw new IOException("Invalid offline snapshot size");
        try (DataInputStream in = new DataInputStream(new ByteArrayInputStream(bytes))) {
            if (in.readInt() != 0x43434f31) throw new IOException("Unknown offline snapshot format");
            long savedAt = in.readLong();
            OfflineSnapshotData result = new OfflineSnapshotData(read(in, 160), read(in, 160), read(in, MAX_TEXT), savedAt, null);
            if (in.available() != 0) throw new IOException("Unexpected offline snapshot content");
            return result;
        } catch (IllegalArgumentException invalid) { throw new IOException("Invalid offline snapshot", invalid); }
    }

    private static void write(DataOutputStream out, String text) throws IOException {
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        out.writeInt(bytes.length); out.write(bytes);
    }

    private static String read(DataInputStream in, int maxCharacters) throws IOException {
        int size = in.readInt();
        if (size < 0 || size > maxCharacters * 4 || size > in.available()) throw new IOException("Invalid text length");
        byte[] bytes = new byte[size]; in.readFully(bytes);
        String text = new String(bytes, StandardCharsets.UTF_8);
        if (text.length() > maxCharacters) throw new IOException("Text is too long");
        return text;
    }

    static String escape(String value) {
        return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace("\"", "&quot;").replace("'", "&#39;");
    }

    String savedTime() { return DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(new Date(savedAt)); }

    String html() {
        return "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
            + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
            + "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\">"
            + "<style>body{margin:0;padding:20px;background:#181818;color:#ddd;font:15px/1.7 sans-serif;overflow-wrap:anywhere}"
            + "h1{font-size:18px;line-height:1.5;margin:0 0 6px}p{color:#aaa;font-size:12px;margin:0 0 20px}pre{font:inherit;white-space:pre-wrap;margin:0}</style>"
            + "</head><body><h1>" + escape(title) + "</h1><p>" + escape(page)
            + " · 保存于 " + escape(savedTime()) + " · 仅供离线查看</p><pre>" + escape(text) + "</pre></body></html>";
    }
}
