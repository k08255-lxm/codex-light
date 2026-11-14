# Pending-package startup safety fixture

Run `dotnet run --project desktop/velopack/pending-startup-tests/PendingStartup.Tests.csproj -- <0.4.900 full nupkg> <0.4.901 full nupkg>` using the independent CodexLightBenchPreviewIsolated packages from the existing portable evaluation.

Pins the real official 1.3.39-g8d2844f managed library. Copies packages to a new disposable directory and calls the real VelopackApp startup twice with SetAutoApplyOnStartup(false). A process spy refuses all child starts/exits, so this harness cannot apply an update or start an application. Both current and newer pending package hashes must stay unchanged.

This simulates repeated startup/second-instance traversal through Velopack; it does NOT launch two production desktop instances or validate the OS wake mutex. The accompanying Node tests check production ordering (false before second-instance return), real project active-task/reservation gates, and storage exclusion of pending nupkg and locks. Existing app-update-server tests cover the authenticated mutation route and reservation behavior.

Observed: two library startups passed; 25 Node tests passed. No production UI, user cache, model, or installation was used.

Important upstream caveat: VelopackApp.Run still performs old-package cleanup even when automatic apply is false. In pinned source VelopackApp.cs around lines 254-269 it preserves current-version full and highest local full, deleting other packages. Thus the highest pending update is preserved, but an intermediate newer package can be removed. Do not equate false with a guarantee of zero filesystem mutations. This fixture intentionally does not broaden runtime policy or implement cleanup.
