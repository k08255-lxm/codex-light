package com.codexlight.android;

import java.util.LinkedHashMap;
import java.util.Map;

/** Bounded task state, independent of Android so transitions can be tested on the JVM. */
final class TaskNotificationState {
    static final int MAX_TASKS = 3;
    static final long STALE_AFTER_MS = 90_000L;
    static final long FINISHED_AFTER_MS = 15 * 60_000L;
    final Map<String, Entry> entries = new LinkedHashMap<>();
    private int nextId = 2000;

    static final class Entry {
        final String threadId;
        final String turnId;
        final int notificationId;
        String title;
        String state;
        long updatedAt;

        Entry(String threadId, String turnId, String title, String state, long now, int id) {
            this.threadId = threadId;
            this.turnId = turnId;
            this.title = title;
            this.state = state;
            this.updatedAt = now;
            this.notificationId = id;
        }

        String key() { return threadId + "\n" + turnId; }
        boolean active() { return "running".equals(state) || "waiting".equals(state); }
        boolean terminal() {
            return "completed".equals(state) || "failed".equals(state) || "interrupted".equals(state);
        }
        boolean stale(long now) { return active() && now - updatedAt >= STALE_AFTER_MS; }
        boolean expired(long now) { return !active() && now - updatedAt >= FINISHED_AFTER_MS; }
    }

    static boolean validId(String value) {
        return value != null && value.matches("[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}");
    }

    static boolean validTitle(String title) {
        if (title == null || title.trim().isEmpty() || title.length() > 80) return false;
        for (int i = 0; i < title.length(); i++) {
            if (Character.isISOControl(title.charAt(i))) return false;
        }
        return true;
    }

    static boolean validState(String state) {
        return "running".equals(state) || "waiting".equals(state) || "completed".equals(state)
            || "failed".equals(state) || "interrupted".equals(state)
            || "disconnected".equals(state) || "idle".equals(state);
    }

    Entry update(String threadId, String turnId, String title, String state, long now) {
        if (!validId(threadId) || !validId(turnId) || !validTitle(title) || !validState(state)
                || "idle".equals(state)) return null;
        Entry old = entries.get(threadId);
        if (old != null && old.turnId.equals(turnId)) {
            // A delayed heartbeat must never resurrect a finished turn.
            if (old.terminal() && !old.state.equals(state)) return null;
            old.title = title;
            if (old.active() || !old.state.equals(state)) old.updatedAt = now;
            old.state = state;
            return old;
        }
        if (old == null && entries.size() >= MAX_TASKS) return null;
        Entry entry = new Entry(threadId, turnId, title, state, now,
            old == null ? ++nextId : old.notificationId);
        entries.put(threadId, entry);
        return entry;
    }
}
