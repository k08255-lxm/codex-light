package com.codexlight.android;

import java.net.HttpURLConnection;
import java.net.URL;

final class LanConnectionClient {
    enum Result { READY, UNAUTHORIZED, UNAVAILABLE, INVALID }
    interface ConnectionFactory { HttpURLConnection open(URL url) throws Exception; }
    private final ConnectionFactory connections;
    LanConnectionClient() { this(url -> (HttpURLConnection) url.openConnection()); }
    LanConnectionClient(ConnectionFactory connections) { this.connections = connections; }
    private volatile HttpURLConnection active;
    private volatile boolean cancelled;
    void cancel() { cancelled = true; HttpURLConnection c = active; if (c != null) c.disconnect(); }
    Result check(ServerConfig config) {
        if (!ReconnectPolicy.eligible(config.getHost(), config.getPort(), config.getToken())) return Result.INVALID;
        try {
            HttpURLConnection c = connections.open(new URL("http://" + config.toDisplayAddress() + "/api/status"));
            active = c;
            if (cancelled) return Result.UNAVAILABLE;
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(5000); c.setReadTimeout(5000); c.setUseCaches(false);
            c.setRequestProperty("Authorization", "Bearer " + config.getToken());
            int status = c.getResponseCode();
            if (cancelled) return Result.UNAVAILABLE;
            if (ReconnectPolicy.unauthorized(status)) return Result.UNAUTHORIZED;
            return status == 200 ? Result.READY : Result.UNAVAILABLE;
        } catch (Exception failure) { return Result.UNAVAILABLE; }
        finally { HttpURLConnection c = active; active = null; if (c != null) c.disconnect(); }
    }
}
