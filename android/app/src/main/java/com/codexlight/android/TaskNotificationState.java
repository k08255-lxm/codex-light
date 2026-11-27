package com.codexlight.android;

import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/** Bounded task state, independent of Android so transitions can be tested on the JVM. */
final class TaskNotificationState {
    static final int MAX_TASKS = 3;
    static final long STALE_AFTER_MS = 90_000L;
    static final long RENEW_AFTER_MS = 30_000L;
    static final long FINISHED_AFTER_MS = 15 * 60_000L;
    final Map<String, Entry> entries = new LinkedHashMap<>();
    private final LinkedHashSet<String> replacedTurns = new LinkedHashSet<>();
    private int nextId = 2000;

    static final class Entry {
        final String threadId;
        final String turnId;
        final int notificationId;
        String title;
        String state;
        String phase;
        String action = "", noticeId = "", noticeThread = "", preview = "", alertedNotice = "";
        String planStep = "";
        int done, total, completedTools;
        long updatedAt;
        long postedAt = -1;

        Entry(String threadId, String turnId, String title, String state, String phase, long now, int id) {
            this.threadId = threadId;
            this.turnId = turnId;
            this.title = title;
            this.state = state;
            this.phase = phase;
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
        boolean needsPost(long now) { return postedAt < 0 || (active() && now - postedAt >= RENEW_AFTER_MS); }

        void disconnect(long now) {
            state = "disconnected";
            phase = null;
            details("", 0, 0, 0, "", "", "");
            planStep = "";
            updatedAt = now;
            postedAt = -1;
        }

        void details(String action, int done, int total, int completedTools, String noticeId, String noticeThread, String preview) {
            if (!this.action.equals(action) || this.done != done || this.total != total || this.completedTools != completedTools
                    || !this.noticeId.equals(noticeId) || !this.noticeThread.equals(noticeThread) || !this.preview.equals(preview)) postedAt = -1;
            this.action = action; this.done = done; this.total = total; this.completedTools = completedTools;
            this.noticeId = noticeId; this.noticeThread = noticeThread; this.preview = preview;
        }

        String progressLabel() {
            if (total > 0) return "计划 " + done + "/" + total + (planStep.isEmpty() ? "" : " · " + planStep);
            return completedTools > 0 ? "已完成 " + completedTools + " 项工具操作" : "";
        }

        String phaseLabel() {
            if ("tool".equals(phase)) switch (action) {
                case "commandExecution": return "运行命令";
                case "fileChange": return "修改文件";
                case "webSearch": return "搜索网页";
                case "collabAgentToolCall": return "协调子任务";
                case "imageGeneration": return "生成图片";
                case "imageView": return "查看图片";
                case "mcpToolCall": case "dynamicToolCall": return "调用工具";
            }
            if ("thinking".equals(phase)) return "思考中";
            if ("responding".equals(phase)) return "回复中";
            if ("tool".equals(phase)) return "执行中";
            if ("approval".equals(phase)) return "等待审批";
            if ("question".equals(phase)) return "等待回答";
            return "running".equals(state) ? "工作中" : "等待你的回答或批准";
        }
    }

    static boolean validId(String value) {
        return value != null && value.matches("[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}");
    }

    static String ignoreKey(String origin, String threadId, String turnId) { return origin + "\n" + threadId + "\n" + turnId; }

    static Set<String> ignoring(Set<String> previous, String origin, String threadId, String turnId) {
        Set<String> next = new LinkedHashSet<>(previous);
        String key = ignoreKey(origin,threadId,turnId);
        if (!next.contains(key) && next.size() >= 32) next.remove(next.iterator().next());
        next.add(key);
        return next;
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
        return update(threadId, turnId, title, state, null, now);
    }

    static boolean validPhase(String state, String phase) {
        if (phase == null) return true;
        if ("running".equals(state)) return "working".equals(phase) || "thinking".equals(phase)
            || "tool".equals(phase) || "responding".equals(phase);
        return "waiting".equals(state) && ("question".equals(phase) || "approval".equals(phase));
    }

    Entry update(String threadId, String turnId, String title, String state, String phase, long now) {
        return update(threadId,turnId,title,state,phase,now,false);
    }

    Entry update(String threadId, String turnId, String title, String state, String phase, long now, boolean pendingRequest) {
        if (!validId(threadId) || !validId(turnId) || !validTitle(title) || !validState(state)
                || !validPhase(state, phase) || "idle".equals(state)) return null;
        boolean waitingForRequest = pendingRequest && "waiting".equals(state);
        if (replacedTurns.contains(threadId + "\n" + turnId) && !waitingForRequest) return null;
        Entry old = entries.get(threadId);
        if (old != null && old.turnId.equals(turnId)) {
            // A delayed heartbeat must never resurrect a finished turn.
            if (old.terminal() && !old.state.equals(state) && !waitingForRequest) return null;
            // Older senders may send a heartbeat without a phase for this same state.
            if (phase == null && old.state.equals(state)) phase = old.phase;
            if (!old.title.equals(title) || !old.state.equals(state) || !Objects.equals(old.phase, phase)) old.postedAt = -1;
            old.title = title;
            if (old.active() || !old.state.equals(state)) old.updatedAt = now;
            old.state = state;
            old.phase = phase;
            return old;
        }
        if (old == null && entries.size() >= MAX_TASKS) return null;
        if (old != null) {
            if (!waitingForRequest) replacedTurns.add(old.key());
            if (replacedTurns.size() > 128) replacedTurns.remove(replacedTurns.iterator().next());
        }
        Entry entry = new Entry(threadId, turnId, title, state, phase, now,
            old == null ? ++nextId : old.notificationId);
        entries.put(threadId, entry);
        return entry;
    }

    void clear() {
        entries.clear();
        replacedTurns.clear();
    }
}
