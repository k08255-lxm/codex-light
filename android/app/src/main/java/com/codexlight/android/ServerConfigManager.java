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

    private final SharedPreferences prefs;

    public ServerConfigManager(Context context) {
        this.prefs = context.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    public void saveCurrent(ServerConfig config) {
        if (config == null) return;
        prefs.edit()
            .putString(KEY_CURRENT_HOST, config.getHost())
            .putInt(KEY_CURRENT_PORT, config.getPort())
            .putString(KEY_CURRENT_TOKEN, config.getToken())
            .apply();
        addToHistory(config);
    }

    public ServerConfig getCurrent() {
        String host = prefs.getString(KEY_CURRENT_HOST, "");
        int port = prefs.getInt(KEY_CURRENT_PORT, 0);
        String token = prefs.getString(KEY_CURRENT_TOKEN, "");
        if (host.isEmpty()) return null;
        return new ServerConfig(host, port, token);
    }

    public List<ServerConfig> getHistory() {
        List<ServerConfig> list = new ArrayList<>();
        String jsonStr = prefs.getString(KEY_HISTORY_JSON, "[]");
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
        } catch (Exception ignored) {}
        return list;
    }

    public void addToHistory(ServerConfig newCfg) {
        if (newCfg == null || newCfg.getHost().isEmpty()) return;
        List<ServerConfig> current = getHistory();
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
            prefs.edit().putString(KEY_HISTORY_JSON, arr.toString()).apply();
        } catch (Exception ignored) {}
    }

    public void clearHistory() {
        prefs.edit().remove(KEY_HISTORY_JSON).apply();
    }
}
