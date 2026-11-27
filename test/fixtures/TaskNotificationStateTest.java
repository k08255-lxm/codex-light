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
        check(tasks.update("thread-1", "turn-1", "任务一", "running", "tool", 100_005) == null,
            "replayed phase from a replaced turn cannot take over the current notification");
        checkPhaseUpdates();
        java.util.Set<String> ignored=TaskNotificationState.ignoring(java.util.Collections.emptySet(),"computer","one","turn-a");
        check(ignored.equals(TaskNotificationState.ignoring(ignored,"computer","one","turn-a")), "repeat ignore is idempotent");
        check(ignored.contains(TaskNotificationState.ignoreKey("computer","one","turn-a")), "same turn remains ignored on the paired computer");
        check(!ignored.contains(TaskNotificationState.ignoreKey("computer","one","turn-b")) && !ignored.contains(TaskNotificationState.ignoreKey("other-computer","one","turn-a")), "next turn and different computer are independent");
        System.out.println("Task notification state checks passed");
    }

    private static void checkPhaseUpdates() {
        TaskNotificationState tasks = new TaskNotificationState();
        TaskNotificationState.Entry first = tasks.update("one", "a", "一", "running", "thinking", 0);
        TaskNotificationState.Entry second = tasks.update("two", "b", "二", "running", "tool", 0);
        TaskNotificationState.Entry third = tasks.update("three", "c", "三", "running", "responding", 0);
        check("思考中".equals(first.phaseLabel()) && "执行中".equals(second.phaseLabel())
            && "回复中".equals(third.phaseLabel()), "three concurrent tasks keep independent phases");
        int id = first.notificationId;
        first.postedAt = 0;
        tasks.update("one", "a", "一", "running", "thinking", 1000);
        check(!first.needsPost(1000) && first.updatedAt == 1000, "duplicate phase only renews local freshness");
        tasks.update("one", "a", "一", "running", 2000);
        check("思考中".equals(first.phaseLabel()) && !first.needsPost(2000), "old clients can send phase-free heartbeats");
        check(first.needsPost(TaskNotificationState.RENEW_AFTER_MS), "system timeout is renewed periodically");
        tasks.update("one", "a", "一", "waiting", "approval", 3000);
        check(first.needsPost(3000) && "等待审批".equals(first.phaseLabel()) && first.notificationId == id,
            "approval replaces this task's running card without creating a second card");
        tasks.update("one", "a", "一", "waiting", "question", 4000);
        check("等待回答".equals(first.phaseLabel()), "question phase replaces approval text");
        first.disconnect(5000);
        check(first.phase == null && !first.active(), "disconnect clears old live activity");
        tasks.update("one", "a", "一", "running", "responding", 6000);
        check("回复中".equals(first.phaseLabel()) && first.active(), "fresh live state restores the same card");
        check(tasks.update("one", "a", "一", "waiting", "thinking", 7000) == null,
            "running phases cannot be applied to a waiting card");
        check(tasks.update("one", "a", "一", "running", "arbitrary command", 7000) == null,
            "free text cannot enter a phase label");
        tasks.update("one", "a", "一", "completed", 8000);
        first.postedAt = 8000;
        check(first.phase == null && !first.needsPost(90000), "completed card drops the ongoing phase and never renews");
        check(tasks.update("one","a","一","waiting","question",90001,true)==first, "a confirmed outstanding request can follow completion on the original card");
        first.details("",2,4,7,"question-1","one","选择哪个版本？");
        check(first.notificationId==id && first.needsPost(90001) && "计划 2/4".equals(first.progressLabel()),"waiting card retains its route and real plan counts");
        tasks.update("one","a","一","running","tool",90002);
        first.details("fileChange",0,0,7,"","","");
        check("修改文件".equals(first.phaseLabel()) && "已完成 7 项工具操作".equals(first.progressLabel()),"answer restores the tool and measured progress");
    }
}
