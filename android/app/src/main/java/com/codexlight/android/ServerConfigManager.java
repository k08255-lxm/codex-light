package com.codexlight.android;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

public class ServerConfigManager {
    private static final String PREFS_NAME = "codex_light_prefs";
    private static final String KEY_CURRENT_HOST = "current_host";
    private static final String KEY_CURRENT_PORT = "current_port";
    private static final String KEY_CURRENT_TOKEN = "current_token";
    private static final String KEY_HISTORY_JSON = "history_json";

    private static final String KEY_SECURE_TOKEN = "current_token_encrypted_v1";
    private static final String KEY_SECURE_HISTORY = "history_encrypted_v1";
    private static final String KEY_AUTO_CONNECT = "auto_connect";
    private final SharedPreferences prefs;
    private boolean storageError;
    public String getNetworkBinding() { return prefs.getString("connection_network_v1", ""); }
    public void saveNetworkBinding(String fingerprint) {
        if (!prefs.edit().putString("connection_network_v1", fingerprint).commit()) storageError = true;
    }
    public boolean hasStorageError() { return storageError; }
    public boolean isAutoConnectEnabled() { return prefs.getBoolean(KEY_AUTO_CONNECT, true); }
    public void setAutoConnectEnabled(boolean enabled) { prefs.edit().putBoolean(KEY_AUTO_CONNECT, enabled).apply(); }
    private String readSecret(String encryptedKey, String legacyKey, String fallback) {
        try {
            if (prefs.contains(encryptedKey)) return CredentialCipher.open(prefs.getString(encryptedKey, ""));
            String legacy = prefs.getString(legacyKey, fallback);
            if (prefs.contains(legacyKey)) {
                String encrypted = CredentialCipher.seal(legacy);
                if (!prefs.edit().putString(encryptedKey, encrypted).remove(legacyKey).commit())
                    throw new IllegalStateException("Cannot save connection");
            }
            return legacy;
        } catch (Exception failure) { storageError = true; return fallback; }
    }

    public ServerConfigManager(Context context) {
        this.prefs = context.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    public void saveCurrent(ServerConfig config) { saveCurrent(config, ""); }

    public void saveCurrent(ServerConfig config, String networkBinding) {
        if (config == null) return;
        try {
        String encrypted = CredentialCipher.seal(config.getToken());
        if (!prefs.edit()
            .putString(KEY_CURRENT_HOST, config.getHost())
            .putInt(KEY_CURRENT_PORT, config.getPort())
            .putString(KEY_SECURE_TOKEN, encrypted).remove(KEY_CURRENT_TOKEN)
            .putString("connection_network_v1", networkBinding)
            .commit()) throw new IllegalStateException("Cannot save connection");
        addToHistory(config);
        } catch (Exception failure) { storageError = true; }
    }

    public ServerConfig getCurrent() {
        String host = prefs.getString(KEY_CURRENT_HOST, "");
        int port = prefs.getInt(KEY_CURRENT_PORT, 0);
        String token = readSecret(KEY_SECURE_TOKEN, KEY_CURRENT_TOKEN, "");
        if (host.isEmpty()) return null;
        return new ServerConfig(host, port, token);
    }

    public List<ServerConfig> getHistory() {
        List<ServerConfig> list = new ArrayList<>();
        String jsonStr = readSecret(KEY_SECURE_HISTORY, KEY_HISTORY_JSON, "[]");
        try {
            JSONArray arr = new JSONArray(jsonStr);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject obj = arr.getJSONObject(i);
                ServerConfig cfg = new ServerConfig(
                    obj.optString("host", ""),
                    obj.optInt("port", 80),
                    obj.optString("token", "")
                );
                cfg.setLastConnectedAt(obj.optLong("time", System.currentTimeMillis()));
                list.add(cfg);
            }
        } catch (Exception failure) { storageError = true; }
        return list;
    }

    public void addToHistory(ServerConfig newCfg) {
        if (newCfg == null || newCfg.getHost().isEmpty()) return;
        List<ServerConfig> current = getHistory();
        if (storageError) return; // Do not overwrite unreadable history.
        List<ServerConfig> updated = new ArrayList<>();
        updated.add(newCfg);
        for (ServerConfig c : current) {
            if (!c.getHost().equalsIgnoreCase(newCfg.getHost()) || c.getPort() != newCfg.getPort()) {
                updated.add(c);
            }
            if (updated.size() >= 8) break;
        }
        try {
            JSONArray arr = new JSONArray();
            for (ServerConfig c : updated) {
                JSONObject obj = new JSONObject();
                obj.put("host", c.getHost());
                obj.put("port", c.getPort());
                obj.put("token", c.getToken());
                obj.put("time", c.getLastConnectedAt());
                arr.put(obj);
            }
            String encrypted = CredentialCipher.seal(arr.toString());
            if (!prefs.edit().putString(KEY_SECURE_HISTORY, encrypted).remove(KEY_HISTORY_JSON).commit())
                throw new IllegalStateException("Cannot save connection history");
        } catch (Exception failure) { storageError = true; }
    }

    public void clearHistory() {
        prefs.edit().remove(KEY_HISTORY_JSON).remove(KEY_SECURE_HISTORY).apply();
    }
}
