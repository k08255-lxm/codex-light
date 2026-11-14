# First-install environment matrix

This matrix separates injected flow tests from real Windows installation evidence.
No model calls, dependency installation, application launch or security-setting changes are required by the test commands below.

| Environment / event | Required behavior | Evidence |
| --- | --- | --- |
| Compatible Node and CLI already present | Reuse both; execute vendor Setup once | Injected flow |
| Node missing, CLI present | Explicit Node consent, install, re-detect, then Setup | Injected flow |
| Node present, CLI missing | Explicit CLI consent, install, re-detect, then Setup | Injected flow |
| Both missing | Node first, then CLI, independent consent and post-checks | Injected flow |
| Node 20.x / 22.0–22.14 | Separate upgrade consent; rejection stops without probing CLI | Version boundary + injected flow |
| Node 22.15 / 24.13 | Accepted by bridge version gate | Version boundary only; architecture is checked separately |
| Uncertain detection | Stop; do not assume missing or replace the environment | Injected flow |
| Dependency refused/cancelled/failed/reboot-required | Stop before subsequent dependency or Setup | Injected flow |
| Installation reports success but post-detection is missing/uncertain/old | Stop before subsequent dependency or Setup | Injected flow |
| Node succeeded, CLI consent refused | Leave installed Node alone; no Setup, no blind shared-runtime rollback | Injected flow |
| Existing installation/data/registration | Refuse first-install path, require update/migration | Source inspection + abstract preflight failure test; actual registry branches not exercised here |
| Setup integrity invalid at start | No dependency probes/installations or Setup | Injected flow |
| Installation appears or Setup changes during dependency work | Final preflight rejects; no Setup | Injected flow |
| Vendor returns failure | Preserve failure code; do not report app health success | Injected flow |
| No .NET Desktop runtime / WebView2 | Vendor framework bootstrap handles these | Build configuration only; clean-machine interactive install NOT tested |
| No Node and no CLI on a genuinely clean machine | Official dependency downloads/consent/UAC/vendor interaction complete correctly | NOT tested on clean Windows VM |
| Restricted corporate policy / SmartScreen / UAC denial | Report denial without bypass | Source inspection; production policy branches NOT tested |

## Reproduce safe checks

```powershell
dotnet run --project desktop/velopack/setup-wrapper/tests/Tests.csproj -c Release --no-restore
dotnet run --project desktop/velopack/cli-prerequisite-tests/Tests.csproj -c Release --no-restore
python -m unittest discover -s desktop/velopack -p test_verify.py
```

The expanded flow suite has 76 assertions (previously 58). The additional assertions cover upgrade post-check failures, downstream isolation after refusal/cancellation/preflight failures, partial dependency completion, and changes discovered by final preflight. They use only an injected fake host and are not proof that a clean-machine installation succeeds.

The current first-install wrapper intentionally rejects the development computer's existing Codex Light data/install directories. Do not delete user data or uninstall the old application just to make that test pass. Use an authorized clean Windows VM for the remaining interactive matrix.