# Velopack integration and isolated measurements

Build opt-in only: `dotnet publish desktop/CodexLight.Desktop.csproj -c Release -r win-x64 --self-contained false -p:EnableVelopackPrototype=true`.
Default MSI builds do not include Velopack. Pinned official NuGet runtime and vpk tool: **1.3.39-g8d2844f (prerelease)**. This deliberately adopts upstream Setup argument-forwarding and Windows failed-directory-swap fixes; prerelease behavior still needs migration acceptance. Startup auto-apply is disabled. Fast hooks run before WinForms and the real application's desktop mutex. Do not normally launch a prototype, because normal startup still uses that real mutex/data configuration.

## Historical 1.2.161 measurement 2026-11-14

Windows x64 on the same machine. Independent `CodexLightBenchIsolated` portable identity and fresh temporary directory per run. No installer or real application was opened. Update runs used `--silent --norestart`, and only fast update hooks ran. Logs confirm portable mode skipped uninstall registration and process scans matched only the isolated updater itself.

Inputs: actual 0.4.2 and 0.4.3 published payload trees, filtered through the current MSI payload policy, with the same opt-in prototype host and its Velopack runtime overlaid on both. Thus this is representative real application-resource movement, not byte-identical original release packages, not first-MSI-migration testing, and not a controlled MSI-versus-Velopack comparison.

Target: 2,984 files / 17,123,306 uncompressed bytes. Full package 7,729,164 bytes; delta 1,504,947 bytes (80.5% less network payload). Delta log: 8 patched, 2,974 unchanged, 5 new, 1 removed.

| Local stage (ms) | Run 1 | Run 2 | Run 3 | Median |
| --- | ---: | ---: | ---: | ---: |
| Delta reconstruction | 8073 | 8482 | 8184 | 8184 |
| Delta prepared-package apply | 5360 | 5556 | 5441 | 5441 |
| Delta combined local update | 13433 | 14038 | 13625 | 13625 |
| Full-package apply | 5547 | 5581 | 5629 | 5581 |

Times are wall-clock around process start/wait/exit, including the updater's extraction, directory replacement, fast hooks and own cleanup. They exclude network, preparing the baseline directory, model calls, interactive user decisions, actual app shutdown/restart and post-run full-tree hash verification. App was already stopped, so apply time is not measured user-visible downtime. Each resulting tree was SHA256-compared against all expected target files.

Initial baseline portable extraction took 3.43–3.74 seconds, excluded from update. Packaging was developer-side, not update latency. No peak disk usage was measured. Old package, reconstructed package and extracted trees coexist; disk budget and retained package policy remain production work.

A corrupt package was rejected with exit 1 before switching the installed version. This tests pre-apply rejection, not crash rollback or full application/data recovery.

Historical installed MSI log showed 60 seconds for 0.4.2->0.4.3. This is contextual only: it used the earlier 4k-file payload and different installation state. Do not report a proven 4x/10x production speedup.

## Recommendation and unfinished work

For the current small package, full-download + Velopack directory application is the fastest measured local route. Delta saves 6.22 MB but adds ~8.18s reconstruction; simple bandwidth-only break-even is ~0.76 MB/s. Actual network latency and cache conditions will vary. Prefer full updates on fast connections; evaluate deltas for slow links or much larger packages.

Source integration now includes full-package selection, idle reservation, native identity/hash validation, an external worker handshake and packaging. See INTEGRATION_STATUS.md for exact verification boundaries. First MSI migration, prerequisite entry-point wiring, real process lifecycle, health/recovery, signature policy and full install/uninstall behavior are not yet established by end-to-end evidence. Velopack may terminate processes inside its install root when files are locked, so a safe task gate is mandatory. Do not pass the real data directory as its installation root.

`benchmark.ps1` expects an explicitly marked isolated workspace containing the prepared old portable zip, full/delta packages and expected new payload. It never launches Setup.exe and requires `.portable` before calling Update.exe. It creates new run directories and leaves evidence intact. This development harness is not an application update command.

Sources: https://docs.velopack.io/packaging/deltas ; https://docs.velopack.io/packaging/operating-systems/windows ; https://docs.velopack.io/reference/cli/content/update-windows

## Current pinned prerelease: isolated real update regression

Both tool and runtime are pinned to `1.3.39-g8d2844f`, source commit `8d2844f324a69bd848719ef465b1ae12c5060524`. This is an explicit prerelease dependency, not a stable upstream release. First-MSI migration execution remains disabled.

A fresh current-host snapshot and actual application payload were packed under independent `CodexLightBenchPreviewIsolated` identity with artificial test versions `0.4.900 -> 0.4.901`. Both test versions used the same application code, differing in package version and test sentinel. Three real portable full-package applications took **5.630 / 5.018 / 7.168 seconds**; all 2,994 expected installed files matched hashes. This includes local prerequisite checks, extraction, fast hooks, swap and temporary cleanup, but not download, baseline extraction, hash verification or ordinary UI restart. Some later runs overlapped fault testing, so this is not a controlled MSI speed comparison.

A truncated package was rejected in 80ms with old current unchanged. A locked file in the fully extracted new directory forced replacement to fail after the old directory was backed up. After retries, the old current was restored; every old-file hash matched (35.254 seconds, failure exit). Successful updates delete old temporary backups: do not promise automatic rollback after success. Remaining locked temporary files from a failure may require later cleanup.

No Setup, ordinary host start, formal installation, MSI uninstall or production data access was exercised by this regression. Logs matched only the isolated updater process and showed no process-kill operation. These results do not validate interrupted-power recovery, live-task drain, MSI migration, UAC or reboot paths.
