package com.codexlight.android;

import java.util.ArrayList;
import java.util.List;

final class ConnectionHistory {
    static List<ServerConfig> record(ServerConfig connected, List<ServerConfig> previous) {
        List<ServerConfig> result = new ArrayList<>();
        result.add(connected);
        for (ServerConfig old : previous) {
            if (connected.origin().equals(old.origin())) {
                String oldId = old.getRemoteHostId();
                // An older entry has no desktop ID. Upgrade it only when the same credential was verified.
                if (!oldId.isEmpty() && oldId.equals(connected.getRemoteHostId())) continue;
                if (oldId.isEmpty() && old.getToken().equals(connected.getToken())) continue;
            }
            result.add(old);
            if (result.size() == 8) break;
        }
        return result;
    }

    static String deviceLabel(ServerConfig selected, List<ServerConfig> history) {
        String id = selected.getRemoteHostId();
        if (id.isEmpty()) return "旧连接 · 未记录电脑 ID";
        String prefix = id.substring(0, 8);
        for (ServerConfig other : history) {
            if (other.origin().equals(selected.origin()) && !other.getRemoteHostId().equals(id)
                    && other.getRemoteHostId().startsWith(prefix)) return "电脑 ID " + id;
        }
        return "电脑 ID " + prefix;
    }
}
