# MSI → Velopack migration coordinator

This module is a **gated coordinator and read-only inventory command**, not a completed production migration installer. `Invoke-Migration.ps1` provides an inspect-by-default wrapper with explicit execution/idle/health/retirement switches. Its execution path is intentionally hard-disabled: the pinned vendor source still has the documented trailing-argument parser defect, and no isolated VM migration has passed. The current MSI remains the production installation route until a wrapper implements `IMigrationHost` and passes isolated end-to-end migration/rollback tests.

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

The tests exercise branching/order/identity/path/hash/task/disk protections through an injected fake host. They do **not** establish actual MSI uninstall/reinstall correctness, Velopack Setup rollback, desktop shortcut takeover, MSI-cache sufficiency, or real elapsed migration time. Those require a disposable Windows VM with snapshots and the exact old/new packages. The user's active installation is not a suitable test fixture.

## Wrapper blocker (verified source, not speculation)

Official Velopack 1.2.161 documentation advertises `Setup.exe -- [EXE_ARGS]`, but pinned repository commit `92d6a1c91716729d449034df5c50307dcce39493`, `src/bins/src/setup.rs`, defines the positional without an OsString value parser and retrieves it with `get_many::<OsString>`. This matches upstream issue #1039. The proposed `--migration-staged` argument cannot safely be relied on for this release. `commands/install.rs` normally starts the installed application when not silent; using `--silent` as a workaround would auto-accept prompts and is not acceptable here.

The wrapper hard-stop occurs before any prerequisite installer, staging write, recovery copy or uninstall. It must not be removed until a supported no-normal-start mechanism is verified and real disposable-VM migration/rollback tests pass. The unreachable candidate execution code is retained for review, not advertised as working. Manual health attestation is not equivalent to an automated native/backend smoke test.

Sources:
- https://docs.velopack.io/reference/cli/content/setup-windows
- https://github.com/velopack/velopack/issues/1039
- https://github.com/velopack/velopack/blob/92d6a1c91716729d449034df5c50307dcce39493/src/bins/src/setup.rs
