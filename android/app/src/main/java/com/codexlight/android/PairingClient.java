package com.codexlight.android;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

final class PairingClient {
    static boolean isPairing(String text) { return ServerConfig.link(text, "pair") != null; }

    static ServerConfig redeem(URI link) throws Exception {
        ServerConfig target = ServerConfig.pairingTarget(link);
        HttpURLConnection connection = (HttpURLConnection) new URL(target.origin() + "/api/pairing/redeem").openConnection();
        try {
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(8000);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            byte[] request = new JSONObject().put("ticket", link.getRawFragment().substring(5))
                .toString().getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(request.length);
            try (OutputStream output = connection.getOutputStream()) { output.write(request); }
            if (connection.getResponseCode() != 200) throw new IOException("配对失败");
            ByteArrayOutputStream response = new ByteArrayOutputStream();
            try (InputStream input = connection.getInputStream()) {
                byte[] buffer = new byte[512];
                int n;
                while ((n = input.read(buffer)) != -1) {
                    if (response.size() + n > 2048) throw new IOException("配对响应无效");
                    response.write(buffer, 0, n);
                }
            }
            String token = new JSONObject(response.toString("UTF-8")).getString("token");
            ServerConfig config = new ServerConfig(target.getScheme(), target.getHost(), target.getPort(), token);
            if (!config.eligible()) throw new IOException("配对响应无效");
            return config;
        } finally { connection.disconnect(); }
    }
}
