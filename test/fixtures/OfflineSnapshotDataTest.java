package com.codexlight.android;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public final class OfflineSnapshotDataTest {
    private static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
    private static void rejected(Runnable action, String message) {
        try { action.run(); } catch (IllegalArgumentException expected) { return; }
        throw new AssertionError(message);
    }

    public static void main(String[] args) throws Exception {
        String token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        String hostile = "</pre><script>alert('x')</script><img src='https://evil.test'>\n";
        OfflineSnapshotData original = new OfflineSnapshotData("项目 <A>", "对话", hostile
            + "当前文字\n" + token + "\nhttp://192.168.1.2/#token=other-secret\nBearer abc.secret", 1700000000000L, token);
        byte[] encoded = original.encode();
        String stored = new String(encoded, StandardCharsets.UTF_8);
        check(!stored.contains(token) && !stored.contains("other-secret") && !stored.contains("abc.secret"), "credentials redacted before disk encoding");
        OfflineSnapshotData decoded = OfflineSnapshotData.decode(encoded);
        check(decoded.text.equals(original.text) && decoded.title.equals(original.title), "text roundtrip");
        check(decoded.savedAt == 1700000000000L, "snapshot time preserved");
        StringBuilder repeated = new StringBuilder();
        while (repeated.length() < OfflineSnapshotData.MAX_TEXT) repeated.append("Bearer a ");
        String expanded = repeated.substring(0, OfflineSnapshotData.MAX_TEXT);
        OfflineSnapshotData bounded = new OfflineSnapshotData(expanded.substring(0, 160), expanded.substring(0, 160), expanded, 1, null);
        check(bounded.title.length() <= 160 && bounded.page.length() <= 160 && bounded.text.length() <= OfflineSnapshotData.MAX_TEXT,
            "redaction growth respects all stored field limits");
        check(OfflineSnapshotData.decode(bounded.encode()).text.equals(bounded.text), "redaction-expanded text remains readable after disk roundtrip");
        Map<String, Long> modified = new HashMap<>();
        for (int i = 1; i <= 10; i++) modified.put("server" + i, (long) i);
        List<String> stale = OfflineSnapshotData.staleSnapshotKeys(modified, "server1");
        check(stale.size() == 2 && stale.contains("server2") && stale.contains("server3") && !stale.contains("server1"),
            "clock rollback cannot evict the newly written server snapshot");
        modified.replaceAll((identity, time) -> 1L);
        check(!OfflineSnapshotData.staleSnapshotKeys(modified, "server1").contains("server1"), "equal timestamps retain the current server");
        String html = decoded.html();
        check(!html.contains("<script>") && !html.contains("<img "), "untrusted text cannot become markup");
        check(html.contains("&lt;script&gt;") && html.contains("default-src 'none'") && html.contains("仅供离线查看"), "inert readable offline document");
        check(OfflineSnapshotData.key("http", "192.168.1.2", 1234, "").matches("[a-f0-9]{64}"), "private hashed identity");
        check(!OfflineSnapshotData.key("http", "192.168.1.2", 1234, "").equals(OfflineSnapshotData.key("http", "192.168.1.3", 1234, "")), "hosts isolated");
        check(!OfflineSnapshotData.key("http", "192.168.1.2", 1234, "").equals(OfflineSnapshotData.key("http", "192.168.1.2", 1235, "")), "ports isolated");
        rejected(() -> new OfflineSnapshotData("a", "b", " ", 1, null), "empty capture cannot replace old snapshot");
        rejected(() -> new OfflineSnapshotData("a", "b", new String(new char[100001]), 1, null), "bounded text");
        rejected(() -> new OfflineSnapshotData(new String(new char[161]), "b", "content", 1, null), "bounded title");
        check(!OfflineSnapshotData.key("https", "desk.example.com", 443, "").equals(OfflineSnapshotData.key("http", "desk.example.com", 443, "")), "schemes isolated");
        check(!OfflineSnapshotData.key("http", "192.168.1.2", 1234, "a".repeat(32)).equals(OfflineSnapshotData.key("http", "192.168.1.2", 1234, "b".repeat(32))), "shared address isolated by computer");
        check(!OfflineSnapshotData.key("http", "192.168.1.2", 1234, "").equals(OfflineSnapshotData.key("http", "192.168.1.2", 1234, "a".repeat(32))), "legacy snapshot is not claimed by a newly identified computer");
        rejected(() -> OfflineSnapshotData.key("http", "host", -1, ""), "invalid address refused");
        try { OfflineSnapshotData.decode(Arrays.copyOf(encoded, encoded.length - 1)); throw new AssertionError("truncated record accepted"); }
        catch (IOException expected) {}
        byte[] extra = Arrays.copyOf(encoded, encoded.length + 1);
        try { OfflineSnapshotData.decode(extra); throw new AssertionError("trailing payload accepted"); }
        catch (IOException expected) {}
        byte[] malformed = encoded.clone(); malformed[0] = 0;
        try { OfflineSnapshotData.decode(malformed); throw new AssertionError("wrong format accepted"); }
        catch (IOException expected) {}
        System.out.println("Offline snapshot data checks passed");
    }
}
