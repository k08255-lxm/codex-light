# Verification record (development branch)

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

Real portable regression on that pinned prerelease passed: three full applies 5.630/5.018/7.168 seconds, 2,994 current-file hashes matching; truncated-package rejection retained old current; forced new-directory rename failure restored all old current hashes after retries (35.254 seconds). Success removes old temporary backup, so successful-update rollback is not established. See README for artificial-version, timing and isolation limits.

No release was published, no remote default branch was pushed, and no normal application or user's installed copy was run by this verification.
