package com.codexlight.android;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.List;
import java.util.Locale;
import java.util.function.BooleanSupplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

final class LanConnectionClient {
    enum Result { READY, UNAUTHORIZED, UNAVAILABLE, INVALID, UNEXPECTED, WRONG_DEVICE, UNPROVEN }
    static final class Selection {
        final Result result;
        final ServerConfig target;
        Selection(Result result, ServerConfig target) { this.result = result; this.target = target; }
    }

    interface ConnectionFactory { HttpURLConnection open(URL url) throws IOException; }
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final Pattern PROOF = Pattern.compile("\\s*\\{\\s*\"proof\"\\s*:\\s*\"([0-9a-f]{64})\"\\s*\\}\\s*");
    private final ConnectionFactory connections;
    private final BooleanSupplier networkUnchanged;
    private volatile HttpURLConnection active;
    private volatile boolean cancelled;

    LanConnectionClient(ConnectionFactory connections) { this(connections, () -> true); }
    LanConnectionClient(ConnectionFactory connections, BooleanSupplier networkUnchanged) {
        this.connections = connections;
        this.networkUnchanged = networkUnchanged;
    }

    void cancel() {
        cancelled = true;
        HttpURLConnection c = active;
        if (c != null) c.disconnect();
    }

    Selection select(ServerConfig selected, List<ServerConfig> history, boolean preferLan) {
        if (!selected.eligible()) return new Selection(Result.INVALID, selected);
        ServerConfig other = null;
        if (preferLan && !selected.getRemoteHostId().isEmpty()) {
            for (ServerConfig known : history) {
                if (known.eligible() && known.getRemoteHostId().equals(selected.getRemoteHostId())
                        && !known.getScheme().equals(selected.getScheme())) { other = known; break; }
            }
        }
        ServerConfig first = other != null && "http".equals(other.getScheme()) ? other : selected;
        Selection result = probe(first, other != null ? 1500 : 5000);
        if (other == null || cancelled || (result.result != Result.UNAVAILABLE && result.result != Result.UNPROVEN)) {
            return result;
        }
        return probe(first == selected ? other : selected, 5000);
    }

    private HttpURLConnection open(ServerConfig target, String path, int timeout) throws IOException {
        if (cancelled || (target.identifiedLan() && !networkUnchanged.getAsBoolean())) throw new IOException("Route changed");
        HttpURLConnection c = connections.open(new URL(target.origin() + path));
        active = c;
        if (cancelled) throw new IOException("Cancelled");
        c.setInstanceFollowRedirects(false);
        c.setConnectTimeout(timeout);
        c.setReadTimeout(timeout);
        c.setUseCaches(false);
        return c;
    }

    private void close() {
        HttpURLConnection c = active;
        active = null;
        if (c != null) c.disconnect();
    }

    private Selection probe(ServerConfig target, int timeout) {
        try {
            if (!verifyPeer(target, timeout)) return new Selection(Result.UNPROVEN, target);
            HttpURLConnection c = open(target, "/api/status", timeout);
            c.setRequestProperty("Authorization", "Bearer " + target.getToken());
            int status = c.getResponseCode();
            if (cancelled) return new Selection(Result.UNAVAILABLE, target);
            if (ReconnectPolicy.unauthorized(status)) return new Selection(Result.UNAUTHORIZED, target);
            if (status != 200 || !isJson(c)) return new Selection(Result.UNEXPECTED, target);
            String id = c.getHeaderField("X-CodeCang-Remote-Host-Id");
            if (!target.getRemoteHostId().isEmpty() && !target.getRemoteHostId().equals(id)) {
                return new Selection(Result.WRONG_DEVICE, target);
            }
            if (id != null && !ServerConfig.validHostId(id)) return new Selection(Result.UNEXPECTED, target);
            return new Selection(Result.READY, target.identified(id));
        } catch (IOException unavailable) { return new Selection(Result.UNAVAILABLE, target); }
        finally { close(); }
    }

    private static boolean isJson(HttpURLConnection c) {
        String type = c.getContentType();
        return type != null && "application/json".equalsIgnoreCase(type.split(";", 2)[0].trim());
    }

    boolean verifyPeer(ServerConfig target, int timeout) throws IOException {
        if (!target.identifiedLan()) return true;
        byte[] random = new byte[16];
        RANDOM.nextBytes(random);
        String nonce = hex(random);
        HttpURLConnection c = open(target, "/api/pairing/prove", timeout);
        try {
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            byte[] body = ("{\"nonce\":\"" + nonce + "\"}").getBytes(StandardCharsets.UTF_8);
            c.setFixedLengthStreamingMode(body.length);
            try (OutputStream out = c.getOutputStream()) { out.write(body); }
            if (c.getResponseCode() != 200 || !isJson(c)) return false;
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            try (InputStream in = c.getInputStream()) {
                byte[] buffer = new byte[256];
                int count;
                while ((count = in.read(buffer)) != -1) {
                    if (bytes.size() + count > 512) return false;
                    bytes.write(buffer, 0, count);
                }
            }
            Matcher proof = PROOF.matcher(bytes.toString("UTF-8"));
            if (!proof.matches()) return false;
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(target.getToken().getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            String expected = hex(mac.doFinal(("codecang-lan-v1:" + nonce).getBytes(StandardCharsets.UTF_8)));
            return networkUnchanged.getAsBoolean() && MessageDigest.isEqual(expected.getBytes(StandardCharsets.US_ASCII),
                proof.group(1).getBytes(StandardCharsets.US_ASCII));
        } catch (GeneralSecurityException unsupported) {
            throw new IOException("HMAC unavailable", unsupported);
        } finally { close(); }
    }

    private static String hex(byte[] bytes) {
        StringBuilder text = new StringBuilder(2 * bytes.length);
        for (byte value : bytes) text.append(String.format(Locale.ROOT, "%02x", value & 255));
        return text.toString();
    }
}
