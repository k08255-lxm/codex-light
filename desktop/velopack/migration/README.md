# MSI → Velopack migration coordinator

This module is a **gated coordinator and read-only inventory command**, not a completed production migration installer. `Invoke-Migration.ps1` provides an inspect-by-default wrapper with explicit execution/idle/health/retirement switches. Its execution path is intentionally hard-disabled: the prior trailing-argument parser defect is fixed in the newly pinned prerelease, but production migration safety and end-to-end validation are not complete. The current MSI remains the production installation route until a wrapper implements `IMigrationHost` and passes isolated end-to-end migration/rollback tests.

## Commands

- `dotnet run --project desktop/velopack/migration/Migration.csproj -- inspect`: read current-user unmanaged MSI registration, identify the sole related Codex Light product, and verify its registered original source database's ProductCode, UpgradeCode and ProductVersion. It reads/hashes the source; it does not install, launch, uninstall or modify registration.
- `dotnet run --project desktop/velopack/migration/tests/Tests.csproj -c Release`: pure fake-host workflow tests with new temporary fixture files. No real MSI or application is executed.

## Wrapper contract

1. Pin and validate the exact target artifact hash/provenance; inspect the installed MSI. Reject another family, ambiguous registrations, missing/tampered source and non-newer target versions.
2. Keep data outside both program roots. Use a dedicated `CodexLightDesktop` new program directory, never `%LOCALAPPDATA%/CodexLight`, which is the existing application data root. Never move, overwrite or delete Codex/DSH/user data as migration setup.
3. Acquire a single migration lock, plus the legacy install and destination locks. Verify task and process idleness; do not force-stop work. Repeat this before staging, health checks and retirement. The production single-instance mutex is shared across directories; health tests must use a purpose-built isolated/read-only mode rather than accidentally waking the real application.
4. Budget disk space for full new payload, extracted temporary copy, rollback source, package/delta reconstruction and safety margin. `RequiredFreeBytes` must be calculated by the wrapper from verified manifests, not guessed. Check the volume(s) actually used.
5. Preserve the exact full MSI source in a verified recovery location outside both program roots and the user data root. Persist the migration receipt and backup path atomically outside those roots before each side effect.
6. Check runtime prerequisites first. The separate prerequisites helper may perform a read-only Node check. Only explicit user approval permits its `--install-node` path; restart-required, canceled or uncertain results must stop migration, not proceed to vendor Setup.
7. Stage the new Velopack installation without uninstalling old MSI, changing its files or producing model traffic. Verify the installed identity/version/file hashes and a genuinely isolated native/backend startup health check. Verify user data is unchanged. The coordinator returns `ReadyToRetire`, not `Completed`.
8. Only after explicit retirement approval and fresh validation, uninstall the **exact** old MSI ProductCode with the MSI API. Do not delete its directory manually. Verify product absence, new installation and data. Uncertain failure becomes `RecoveryRequired`; it is not automatically retried.

## Failure / rollback

- Before retirement: keep the old MSI and its source. A failed new health check must leave it usable. The host must avoid modifying old registration/shortcuts while staging, or journal and restore those changes. The coordinator does not claim Velopack's default Setup automatically satisfies that contract.
- During/after retirement: preserve receipt, full MSI source and new installation. Do not claim cross-installer atomic rollback. A recovery flow must check current registration, reconcile shortcut ownership and offer an explicit verified MSI reinstall if needed. No blanket directory or registry cleanup is allowed.
- No automatic crash resume: `Staging`, `HealthChecking`, or `Retiring` receipts require inspection before continuing. Windows Installer system caches remain untouched.
- Normal data-mutating launches are not health checks; reverting executable files does not undo a data-schema migration.

## Validation boundaries

The tests exercise branching/order/identity/path/hash/task/disk protections through an injected fake host. They do **not** establish actual MSI uninstall/reinstall correctness, Velopack Setup rollback, desktop shortcut takeover, MSI-cache sufficiency, or real elapsed migration time. A separate randomly identified benign MSI/Velopack fixture has now exercised install, stage, failed health, restored health, old-product retirement and normal cleanup; see fixture/README.md and its saved results. This does not validate the real application. The user has authorized formal-app testing without changing Codex configuration, but it remains blocked until actual task idleness, backups and the other production safeguards are established. A disposable VM remains preferred for destructive failure scenarios.

## Historical parser blocker and remaining production gate

Official Velopack 1.2.161 documentation advertises `Setup.exe -- [EXE_ARGS]`, but pinned repository commit `92d6a1c91716729d449034df5c50307dcce39493`, `src/bins/src/setup.rs`, defines the positional without an OsString value parser and retrieves it with `get_many::<OsString>`. This matches upstream issue #1039. That evidence applied to the former 1.2.161 pin. Prerelease 1.3.39-g8d2844f fixes the parser through PR #1088; see the separate isolated fixture/parser results. `commands/install.rs` normally starts the installed application when not silent; `--silent` suppresses normal launch. It was explicitly authorized for the benign fixture. A formal silent flow is permissible only with known prerequisites, no undisclosed terms or permissions and explicit authorization; it must never bypass those gates.

The parser fix alone does not complete migration. The wrapper hard-stop occurs before any prerequisite installer, staging write, recovery copy or uninstall. It must not be removed until a supported no-normal-start mechanism is verified and real-app migration/rollback safeguards and authorized tests pass. The unreachable candidate execution code is retained for review, not advertised as working. Manual health attestation is not equivalent to an automated native/backend smoke test.

Sources:
- https://docs.velopack.io/reference/cli/content/setup-windows
- https://github.com/velopack/velopack/issues/1039
- https://github.com/velopack/velopack/blob/92d6a1c91716729d449034df5c50307dcce39493/src/bins/src/setup.rs

Updated parser fix: https://github.com/velopack/velopack/pull/1088 . Production Execute remains disabled regardless of the fixture result.

## Independent recovery primitives (not wired to Execute)

`MigrationStorage` provides same-directory atomic receipts; manifest-based app-data recovery copies; exact member/length/SHA-256 verification; fresh-directory-only restoration; and cooperative legacy/new/current install mutex acquisition. Acquire and dispose a lock lease on the same thread. A lock alone does not establish task idleness.

The production capture entry is fixed to this application's LocalAppData root. State, statistics, DSH, attachments, window state and the **entire WebView profile** are protected; logs, Updates and SetupLogs are explicitly excluded (rollback MSI source is separately preserved). Unknown entries, `.codex`, reparse paths, overwritten/in-place restore destinations and overlapping roots are refused. Stop the app cleanly before capture, including WebView writers. Pre/post capture plus per-file metadata/hash checks detect changes, but this is **not a filesystem snapshot** and cannot guarantee coherence against a concurrent adversarial writer. Existing recovery copies are never overwritten. Partial failed copies are unapproved and retained for inspection.

Space budgeting uses actual captured file lengths plus verified caller-provided payload/package/MSI sizes and explicit headroom. The wrapper must still check every affected volume and temporary extraction requirements; this helper is not free-space or idle proof. Receipt atomic replacement is not a transaction over installation side effects or a guarantee against filesystem/hardware loss.

The production Execute gate remains disabled. Neither pure storage tests nor benign stub health prove real native/backend readiness, schema compatibility, authenticated task idleness, shortcut ownership or production recovery.

## Packaged component health probe

The packaged host accepts `--backend-health-check` before UI, instance wake, or normal app startup. It starts its actual packaged Node/backend in a fresh temporary demo state, checks anonymous rejection and authenticated loopback status, and shuts that process down normally. Native and backend versions must agree. This was executed from an isolated staged payload: exit 0, 624 ms, Node 24.13.0; no account/model or DSH connection was made.

The JSON deliberately reports `realAccountVerified: false`. This proves the native-to-Node/backend component path, not WebView rendering, real user-account connectivity, old-task idleness, or complete migration. It does not remove the production execution gate.
