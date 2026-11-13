package com.codexlight.android;

import android.net.Uri;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Represents connection parameters to a Codex Light desktop server.
 */
public class ServerConfig {
    private String host;
    private int port;
    private String token;
    private long lastConnectedAt;

    public ServerConfig() {
        this.host = "192.168.1.100";
        this.port = 54321;
        this.token = "";
        this.lastConnectedAt = System.currentTimeMillis();
    }

    public ServerConfig(String host, int port, String token) {
        this.host = host != null ? host.trim() : "";
        this.port = port > 0 ? port : 80;
        this.token = token != null ? token.trim() : "";
        this.lastConnectedAt = System.currentTimeMillis();
    }

    public String getHost() { return host; }
    public void setHost(String host) { this.host = host != null ? host.trim() : ""; }

    public int getPort() { return port; }
    public void setPort(int port) { this.port = port; }

    public String getToken() { return token; }
    public void setToken(String token) { this.token = token != null ? token.trim() : ""; }

    public long getLastConnectedAt() { return lastConnectedAt; }
    public void setLastConnectedAt(long time) { this.lastConnectedAt = time; }

    /**
     * Constructs the full web URL with the #token fragment, exactly matching Codex Light LAN specs.
     */
    public String toFullUrl() {
        StringBuilder sb = new StringBuilder();
        sb.append("http://").append(host);
        if (port > 0 && port != 80) {
            sb.append(":").append(port);
        }
        sb.append("/");
        if (token != null && !token.isEmpty()) {
            sb.append("#token=").append(Uri.encode(token));
        }
        return sb.toString();
    }

    public String toDisplayAddress() {
        if (port > 0 && port != 80) {
            return host + ":" + port;
        }
        return host;
    }

    /**
     * Parses a raw URL or connection string (e.g., http://192.168.1.5:49152/#token=a9f8...).
     */
    public static ServerConfig parse(String input) {
        if (input == null || input.trim().isEmpty()) {
            return null;
        }
        String raw = input.trim();
        String host = "";
        int port = 80;
        String token = "";

        // Extract fragment token (#token=...)
        int hashIdx = raw.indexOf("#token=");
        if (hashIdx != -1) {
            token = raw.substring(hashIdx + 7);
            raw = raw.substring(0, hashIdx);
            int amp = token.indexOf("&");
            if (amp != -1) token = token.substring(0, amp);
        } else {
            // Check query token (?token=...)
            int qIdx = raw.indexOf("?token=");
            if (qIdx != -1) {
                token = raw.substring(qIdx + 7);
                raw = raw.substring(0, qIdx);
                int amp = token.indexOf("&");
                if (amp != -1) token = token.substring(0, amp);
            }
        }

        // Clean protocol prefix
        if (raw.startsWith("http://")) {
            raw = raw.substring(7);
        } else if (raw.startsWith("https://")) {
            raw = raw.substring(8);
        }

        // Strip any trailing path like /
        int slashIdx = raw.indexOf("/");
        if (slashIdx != -1) {
            raw = raw.substring(0, slashIdx);
        }

        // Check host:port
        int colonIdx = raw.lastIndexOf(":");
        if (colonIdx != -1) {
            host = raw.substring(0, colonIdx);
            try {
                port = Integer.parseInt(raw.substring(colonIdx + 1));
            } catch (Exception e) {
                port = 80;
            }
        } else {
            host = raw;
            port = 80;
        }

        if (host.isEmpty()) return null;
        return new ServerConfig(host, port, token);
    }
}
