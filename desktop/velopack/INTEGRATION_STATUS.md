# Migration and update verification history

## 0.4.4 migration verification (2026-11-14)

0.4.4 adds a single migration-aware public bootstrap. It preserves the old
client's versioned-asset, no-argument launch contract. Release publication is
still a separate step; successful compilation is not installation acceptance.

### Verified

- A real current-user MSI 0.4.3 installation was migrated to Velopack 0.4.4 by
  the public bootstrap's actual automatic worker, without a second manual
  installer invocation. Runtime preflight, exact payload checks, full data/MSI
  recovery copies, installation, post-install health, exact MSI retirement,
  protected-data verification and post-retirement health all completed.
- Old MSI registration and program directory were absent afterward. Exactly one
  `Codex Light.lnk` remained in the user Start Menu, targeting the stable
  Velopack root stub. Recovery material was retained. The user's Codex config
  hash was unchanged. No inference/model call was made.
- This was a non-foreground core-flow test. It did not click through the outer
  installer UI or claim real-account/GUI acceptance. No fake GUI observation
  receipt was created. Component acceptance is explicitly recorded as such.
- An independent portable 0.4.3 copy successfully applied the final 0.4.4 full
  package with the official updater and no restart. All 780 expected payload
  hashes matched. The observed local apply was 3.435 seconds, excluding download,
  task shutdown and migration; it is not a promised end-to-end update time.
- A compiled standalone bootstrap, renamed to `CodexLight-Setup.exe` with no
  adjacent payload and a different working directory, successfully executed its
  production embedded-resource extraction routine. Main/UI/install were not
  invoked by this resource test.
- Released 0.4.3 checker source accepted the candidate release metadata and its
  checksums. Current MSI and Velopack transports selected their distinct assets.
  Android 0.4.4 has versionCode 404 and the same signing certificate as the
  published 0.4.3 APK.

### Scope and verification limits

- The outer native installer visual/interactive path is not fully exercised on
  the user's desktop because tests must not interrupt their foreground work.
- Fresh-machine dependency installation remains covered by controlled fixtures,
  not a claim of a real pristine Windows-machine installation.
- A previous direct developer-stage Setup launch failed while loading its own
  embedded ZIP with OS error 5. The actual automatic worker later succeeded from
  the product's normal extraction layout without permission changes or security
  bypasses. The exact cause of that earlier failure is not established.
- Packages are unsigned. GitHub release checksums provide integrity, not an
  independent publisher-signature trust root.
- Fixed upstream native binaries, observed crate notices and their hashes are
  retained, but the notice inventory is not a certified complete linked SBOM.
- Later versions must preserve the fixed-bridge compatibility contract in
  `MIGRATION_RELEASE_POLICY.md`; merely leaving 0.4.4 in historical releases is
  insufficient for clients that only query latest.

## Runtime safety

The host uses the Velopack transport only for a validated
`CodexLightDesktop/current` installation with the external worker present. User
state remains in a separate directory. Startup does not auto-apply pending
packages. Full-package identity, published SHA256 and exact version are checked;
unknown task/process state blocks updates. The worker performs the ready/commit
handshake, graceful exit and `--norestart` apply, never a forced task kill.

The tool/runtime pin is official **1.3.39-g8d2844f (prerelease)**, upstream commit
`8d2844f324a69bd848719ef465b1ae12c5060524`. The older stable 1.2.161 argument
forwarding failure is historical, not the current dependency.

## Earlier development measurements (historical)

The following records predate the 0.4.4 migration verification above. Statements about incomplete migration or unpublished candidates describe those earlier snapshots, not the current release. They are retained for regression traceability; test counts and timings are not release guarantees.

### Original portable benchmark notes

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

### Recommendation and unfinished work

For the current small package, full-download + Velopack directory application is the fastest measured local route. Delta saves 6.22 MB but adds ~8.18s reconstruction; simple bandwidth-only break-even is ~0.76 MB/s. Actual network latency and cache conditions will vary. Prefer full updates on fast connections; evaluate deltas for slow links or much larger packages.

Source integration now includes full-package selection, idle reservation, native identity/hash validation, an external worker handshake and packaging. See the 0.4.4 migration verification at the beginning of this file for later evidence. First MSI migration, prerequisite entry-point wiring, real process lifecycle, health/recovery, signature policy and full install/uninstall behavior are not yet established by end-to-end evidence. Velopack may terminate processes inside its install root when files are locked, so a safe task gate is mandatory. Do not pass the real data directory as its installation root.

`benchmark.ps1` expects an explicitly marked isolated workspace containing the prepared old portable zip, full/delta packages and expected new payload. It never launches Setup.exe and requires `.portable` before calling Update.exe. It creates new run directories and leaves evidence intact. This development harness is not an application update command.

Sources: https://docs.velopack.io/packaging/deltas ; https://docs.velopack.io/packaging/operating-systems/windows ; https://docs.velopack.io/reference/cli/content/update-windows

### Current pinned prerelease: isolated real update regression

Both tool and runtime are pinned to `1.3.39-g8d2844f`, source commit `8d2844f324a69bd848719ef465b1ae12c5060524`. This is an explicit prerelease dependency, not a stable upstream release. First-MSI migration execution remains disabled.

A fresh current-host snapshot and actual application payload were packed under independent `CodexLightBenchPreviewIsolated` identity with artificial test versions `0.4.900 -> 0.4.901`. Both test versions used the same application code, differing in package version and test sentinel. Three real portable full-package applications took **5.630 / 5.018 / 7.168 seconds**; all 2,994 expected installed files matched hashes. This includes local prerequisite checks, extraction, fast hooks, swap and temporary cleanup, but not download, baseline extraction, hash verification or ordinary UI restart. Some later runs overlapped fault testing, so this is not a controlled MSI speed comparison.

A truncated package was rejected in 80ms with old current unchanged. A locked file in the fully extracted new directory forced replacement to fail after the old directory was backed up. After retries, the old current was restored; every old-file hash matched (35.254 seconds, failure exit). Successful updates delete old temporary backups: do not promise automatic rollback after success. Remaining locked temporary files from a failure may require later cleanup.

No Setup, ordinary host start, formal installation, MSI uninstall or production data access was exercised by this regression. Logs matched only the isolated updater process and showed no process-kill operation. These results do not validate interrupted-power recovery, live-task drain, MSI migration, UAC or reboot paths.

### Original fixture verification record


- JavaScript suite: 1,014 tests, 1,008 passed, 6 skipped, 0 failed.
- Host opt-in build: successful, 0 warnings/errors.
- Native package validation: 25 passing fixture checks.
- Worker identity, process policy and commit/cancel matrix: 26 passing checks.
- Host ready/cancel/empty-job safety: 13 passing checks.
- Pure safety planner: 54 passing checks.
- Migration fake-host workflow: 21 passing checks.
- Full-package verifier: 12 passing checks.
- Node helper: built successfully; PE cases passed; read-only detection reused installed Node 24.13.0 x64.
- A real application payload with worker and Node helper was packaged and all staged hashes verified. No Setup was run.

These are not equivalent to a production upgrade test. Host safety checks use fixtures and an empty job, not a running user task. Migration tests use a fake executor. The worker's sandbox process probe could see only four processes, so it does not prove complete host process visibility. No real install, uninstall, shortcut transfer, full GUI shutdown/restart, data recovery, or cross-installer rollback was exercised.

The migration wrapper still explicitly disables execution before installing prerequisites, staging vendor Setup or uninstalling old MSI. The previous stable dependency 1.2.161 had the upstream Setup argument-forwarding mismatch (issue 1039 / fix PR 1088). The development branch now pins both official tool and runtime to **1.3.39-g8d2844f (prerelease)**, source commit `8d2844f324a69bd848719ef465b1ae12c5060524`, which contains that source fix and Windows failed-directory-swap recovery. The historical parser issue is no longer the selected dependency, but real MSI migration acceptance remains outstanding. Source inspection is not an executable Setup argument test.

Real portable regression on that pinned prerelease passed: three full applies 5.630/5.018/7.168 seconds, 2,994 current-file hashes matching; truncated-package rejection retained old current; forced new-directory rename failure restored all old current hashes after retries (35.254 seconds). Success removes old temporary backup, so successful-update rollback is not established. See the portable benchmark notes above for artificial-version, timing and isolation limits.

No release was published, no remote default branch was pushed, and no normal application or user's installed copy was run by this verification.
