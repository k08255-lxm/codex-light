package com.codexlight.android;

public final class TaskNotificationStateTest {
    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    public static void main(String[] args) {
        TaskNotificationState tasks = new TaskNotificationState();
        check(tasks.update("thread-1", "turn-1", "任务一", "running", 100) != null, "running accepted");
        TaskNotificationState.Entry first = tasks.entries.get("thread-1");
        check(!first.stale(90_099) && first.stale(90_100), "stale boundary");
        tasks.update("thread-1", "turn-1", "任务一", "running", 60_000);
        check(!first.stale(90_100), "live heartbeat renews freshness");
        tasks.update("thread-1", "turn-1", "任务一", "waiting", 60_100);
        check(first.active() && first.stale(150_100), "waiting also expires without live data");
        tasks.update("thread-1", "turn-1", "任务一", "running", 60_200);
        tasks.update("thread-1", "turn-1", "任务一", "completed", 60_300);
        check(first.terminal() && !first.active(), "completion is not ongoing");
        check(tasks.update("thread-1", "turn-1", "任务一", "running", 60_400) == null,
            "late heartbeat cannot resurrect completed turn");
        tasks.update("thread-1", "turn-1", "任务一", "completed", 60_500);
        check(first.updatedAt == 60_300, "duplicate terminal event must not extend lifetime");
        check(!first.expired(960_299) && first.expired(960_300), "terminal expiry boundary");
        int firstId = first.notificationId;
        TaskNotificationState.Entry second = tasks.update("thread-1", "turn-2", "第二轮", "running", 100_000);
        check(second != first && second.notificationId == firstId && second.turnId.equals("turn-2"),
            "next turn replaces same conversation notification");
        tasks.update("thread-2", "turn-1", "任务二", "running", 100_001);
        tasks.update("thread-3", "turn-1", "任务三", "waiting", 100_002);
        check(tasks.update("thread-4", "turn-1", "任务四", "running", 100_003) == null,
            "fourth active task cannot evict monitored tasks");
        check(tasks.entries.size() == 3, "bounded state");
        check(!TaskNotificationState.validId("x');alert(1)//"), "reject script characters");
        check(!TaskNotificationState.validId("a\nb") && !TaskNotificationState.validId(""), "reject control/empty ids");
        check(!TaskNotificationState.validTitle("title\nspoof") && !TaskNotificationState.validTitle(" "), "reject unsafe title");
        check(!TaskNotificationState.validTitle(new String(new char[81]).replace('\0', 'a')), "bounded title");
        check(!TaskNotificationState.validState("success") && TaskNotificationState.validState("disconnected"), "explicit state enum");
        check(tasks.update("thread-1", "turn-3", "任务", "invented", 100_004) == null, "invalid state leaves existing task intact");
        check(tasks.entries.get("thread-1") == second, "invalid payload cannot replace state");
        System.out.println("Task notification state checks passed");
    }
}
