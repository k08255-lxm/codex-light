package com.codexlight.android;

import java.net.URI;
import java.util.Locale;

/** A paired desktop is identified by its canonical scheme, host and effective port. */
public final class ServerConfig {
    private final String scheme, host, token, remoteHostId;
    private final int port;
    private long lastConnectedAt = System.currentTimeMillis();

    public ServerConfig(String scheme, String host, int port, String token) {
        this(scheme, host, port, token, "");
    }

    public ServerConfig(String scheme, String host, int port, String token, String remoteHostId) {
        this.scheme = scheme == null ? "" : scheme.toLowerCase(Locale.ROOT);
        this.host = host == null ? "" : host.toLowerCase(Locale.ROOT);
        this.port = port;
        this.token = token == null ? "" : token;
        this.remoteHostId = validHostId(remoteHostId) ? remoteHostId : "";
    }

    public String getScheme() { return scheme; }
    public String getHost() { return host; }
    public int getPort() { return port; }
    public String getToken() { return token; }
    public String getRemoteHostId() { return remoteHostId; }
    String sourceKey() { return remoteHostId.isEmpty() ? origin() : origin() + "#" + remoteHostId; }
    static boolean validHostId(String value) { return value != null && value.matches("[a-f0-9]{32}"); }
    ServerConfig identified(String id) { return new ServerConfig(scheme, host, port, token, id); }
    public long getLastConnectedAt() { return lastConnectedAt; }
    public void setLastConnectedAt(long time) { lastConnectedAt = time; }

    public String origin() {
        return scheme + "://" + host + (port == defaultPort(scheme) ? "" : ":" + port);
    }

    boolean validOrigin() {
        if (port < 1 || port > 65535) return false;
        if ("http".equals(scheme)) return ReconnectPolicy.privateIpv4(host);
        if (!"https".equals(scheme) || host.length() > 253 || host.endsWith(".localhost")
                || host.equals("trycloudflare.com") || host.endsWith(".trycloudflare.com")) return false;
        // Canonical fixed DNS names have at least two labels and an alphabetic top-level suffix.
        return host.matches("(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]");
    }

    boolean identifiedLan() { return "http".equals(scheme) && !remoteHostId.isEmpty(); }

    boolean eligible() {
        return validOrigin() && token.matches("[a-f0-9]{64}");
    }

    boolean matchesOrigin(String url) {
        try {
            ServerConfig other = fromUri(URI.create(url), "");
            return other != null && origin().equals(other.origin());
        } catch (IllegalArgumentException invalid) { return false; }
    }

    private static int defaultPort(String scheme) { return "https".equalsIgnoreCase(scheme) ? 443 : 80; }

    private static ServerConfig fromUri(URI uri, String token) {
        String host = uri.getHost(), authority = uri.getRawAuthority();
        if (uri.getRawUserInfo() != null || host == null || authority == null || authority.endsWith(":")) return null;
        int port = uri.getPort() == -1 ? defaultPort(uri.getScheme()) : uri.getPort();
        ServerConfig config = new ServerConfig(uri.getScheme(), host, port, token);
        return config.validOrigin() ? config : null;
    }

    static ServerConfig fromFields(String address, String port, String token) {
        try {
            URI uri = URI.create(address.contains("://") ? address : "http://" + address);
            if (!rootOnly(uri) || uri.getRawFragment() != null) return null;
            ServerConfig config = fromUri(uri, token);
            if (config == null || port.isEmpty()) return config;
            if (!port.matches("[0-9]{1,5}")) return null;
            int requested = Integer.parseInt(port);
            if (uri.getPort() != -1 && uri.getPort() != requested) return null;
            ServerConfig result = new ServerConfig(config.scheme, config.host, requested, token);
            return result.validOrigin() ? result : null;
        } catch (IllegalArgumentException invalid) { return null; }
    }

    private static boolean rootOnly(URI uri) {
        return uri.getRawQuery() == null && ("".equals(uri.getRawPath()) || "/".equals(uri.getRawPath()));
    }

    static URI link(String input, String parameter) {
        if (input == null) return null;
        try {
            URI uri = URI.create(input.trim());
            if (!rootOnly(uri) || fromUri(uri, "") == null || uri.getRawFragment() == null
                    || !uri.getRawFragment().matches(parameter + "=[a-f0-9]{64}")) return null;
            return uri;
        } catch (IllegalArgumentException invalid) { return null; }
    }

    static ServerConfig parse(String input) {
        URI uri = link(input, "token");
        return uri == null ? null : fromUri(uri, uri.getRawFragment().substring(6));
    }

    static ServerConfig pairingTarget(URI link) { return fromUri(link, ""); }
}
