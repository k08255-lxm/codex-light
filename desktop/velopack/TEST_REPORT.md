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

The current migration wrapper explicitly disables execution before installing prerequisites, staging vendor Setup, or uninstalling old MSI. Official 1.2.161 Setup argument forwarding has an upstream type mismatch (issue 1039 / fix PR 1088). Official pre-release 1.3.39-g8d2844f fixes it in source. Investigation of that version is separate from this branch's fixed 1.2.161 dependency. No Rust toolchain was available to run the upstream parser tests; source inspection must not be reported as a passing executable test.

No release was published, no remote default branch was pushed, and no normal application or user's installed copy was run by this verification.
