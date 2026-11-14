# Controlled MSI to Velopack stage

This module supports read-only inspection and an explicitly requested **stage-only** production path. Stage never retires the old MSI. Separate explicitly confirmed retirement is described below. Neither phase closes user tasks, installs missing prerequisites, modifies Codex configuration or cleans old user files. It is not a completed migration product.

## Commands

Build `Migration.csproj` in Release. `Migration inspect` verifies sole current-user unmanaged MSI, registered original source and exact Product/Upgrade/version identity.

`Invoke-Migration.ps1 -ManifestPath <migration-release.json> -TrustedManifestSha256 <externally verified SHA> -TrustedSetupSha256 <externally verified SHA> [-AllowSameVersion]` defaults to read-only package/MSI inspection. The hashes must come from trusted build verification, not merely be calculated from an untrusted download.

Only `-ExecuteStage -TasksCompleted` permits stage. The user must explicitly confirm all work finished and normally close the app. Absence of a process alone is not task completion. `-AllowSameVersion` permits explicitly recorded same-version installer-format migration, never downgrade or 0.4.900 benchmark packages.

## Stage contract

1. Exact CodexLightDesktop identity, pinned Velopack 1.3.39-g8d2844f, shortcutLocations None, trusted manifest plus Setup hash, all release/payload file hashes, exact embedded full package bytes and nupkg metadata/updater verification.
2. Fixed independent LocalAppData/CodexLightDesktop destination, absent registration/root, no reparse/overlap. Acquire desktop single-instance exclusion and legacy/new/current maintenance locks. Check old/new process roots and matching Node/WebView command lines without exposing command text; inventory uncertainty blocks. Never kill.
3. Existing .NET10 Desktop/WebView/Node checks plus verified independent payload's native/backend health preflight. No prerequisite installation. Health checks are demo/account-free, not a renderer or real-account test.
4. Actual manifest byte budget on relevant volumes; complete protected app data including WebView profile and exact MSI source recovery copies. Atomic receipts before Setup. Reject unknown entries or any backup/hash error. Repeat identity and idle checks.
5. Official Setup `--silent --installto <fixedroot>` stages only, with no normal app launch or shortcut takeover. Nonzero/timeout/uncertain outcome becomes RecoveryRequired, not an automatic retry or deletion.
6. Verify entire current payload, root updater, sq.version and registration. Run explicit native/backend component health, compare protected data and old MSI again. Record StagedOldPreserved, **not Completed**. Old MSI remains installed.

Retirement is a separate CLI stage. Native/backend component health alone cannot authorize retirement; live new-GUI observation and explicit user acceptance/retirement confirmation are additionally required.

## Recovery primitives

MigrationStorage provides same-directory atomic receipt replacement, exact manifest copies and verification, fresh-directory-only restore, root locks and checked byte budgeting. Acquire/dispose mutex leases on the same thread. State, statistics, DSH, attachments, window state, application recovery directory and entire WebView profile are protected. Logs/Updates/SetupLogs are explicitly excluded; original MSI separately backed up. `.codex`, unknown entries, reparse paths and in-place restore are rejected. Partial failed copies remain unapproved for inspection.

Stop all app/profile writers first. Per-file metadata/hash checks and pre/post manifests are **not a filesystem snapshot** and cannot guarantee consistency against concurrent adversarial writes. Atomic receipt replacement is not a cross-installer transaction or hardware-loss guarantee.

## Validation scope

56 pure fixture checks pass (coordinator order/failure/retirement gates, storage byte restore/lock/atomic-write safety, stage manifest policy). They do not run the production stage. The benign uniquely identified MSI/Velopack fixture completed reviewed Run+Resume health/failure/restore/retirement and normal cleanup; see fixture/README.md. Its timing and results are not real-app migration performance.

The user has authorized formal-app tests without changing Codex configuration, subject to idle proof and backups. Production stage has not yet been executed or accepted; first-run/GUI/account and actual retirement/recovery execution remain unverified. Disposable VM snapshots remain preferred for destructive failure cases.

Official parser issue in 1.2.161 was fixed by prerelease1.3.39; silent usage still requires authorized scope, known prerequisites and no undisclosed terms/permissions:
- https://docs.velopack.io/reference/cli/content/setup-windows
- https://github.com/velopack/velopack/issues/1039
- https://github.com/velopack/velopack/pull/1088

## Explicit GUI acceptance / retirement (implemented, not production-executed)

After successful stage, launch the new `CodexLightDesktop/current/CodexLight.exe` normally and test it. The helper never launches it silently as a substitute for acceptance. Optionally request `create-migration-shortcut RECEIPT MANIFEST MANIFEST_SHA SETUP_SHA --create-shortcut`; it creates only a distinct `Codex Light (Velopack).lnk` in the user's Start Menu. Existing links are refused, not overwritten. Original MSI shortcuts are never edited by this helper. A unique temporary link is atomically moved without overwrite; the owned link hash/target are journaled.

`observe-gui RECEIPT MANIFEST MANIFEST_SHA SETUP_SHA --confirm-real-use` requires exactly one responsive window belonging to the verified new executable, records process/start-time/exe-hash and binds evidence to the stage receipt. The flag represents the user's explicit acceptance of actual use. Process/window observation proves that GUI is running, **not** that arbitrary account/DSH operations succeeded; the user must genuinely perform/accept those before giving the flag. No fabricated evidence or component-only substitution.

Complete tasks and close both instances normally. `retire-plan RECEIPT MANIFEST MANIFEST_SHA SETUP_SHA` defaults to inspect. Only all three flags `--execute-retire --tasks-completed --confirm-retirement` enable exact ProductCode MSI uninstall. It revalidates GUI evidence, original recovery copy/MSI, new package and registration, locks/process-idleness, fresh component health, and creates a fresh verified **pre-retirement** data backup (including changes from GUI testing and the application's recovery directory). It atomically journals before uninstall, uses normal msiexec, never manually deletes program/registry/cache directories. Nonzero, uncertain or reboot-required results retain evidence and are not completed automatically. Successful absence is checked through MSI API plus both ARP hives/views; new payload/root executables/registration, protected data and component health are checked again. Original source and both data snapshots remain available for explicitly planned recovery.

`OldMsiRetired` is not an assertion that a restore has been tested. Reboot-required and uncertain journals need manual reconciliation; no automatic retry/resume. The distinct shortcut intentionally does not claim ownership of unknown old shortcuts. Real production stage/GUI/retire and a restoration drill remain pending; pure guard tests and the separate benign fixture do not replace them.

## Setup exit-1 investigation (no installer rerun)

A real stage attempt returned exit 1 with no expected setup.log or new destination. The existing receipt/backup was retained and no MSI retirement occurred. The original process runner discarded stderr; this has been corrected. Future authorized attempts retain bounded, drained stdout/stderr plus native exit code/timeout and expected-log existence in `setup-process.json`. No retry is implied by this code change. A harmless PowerShell child emitting separate stdout/stderr and exit7 verifies capture; no installer, including --help, was executed during diagnosis.

At fixed upstream commit 8d2844f324a69bd848719ef465b1ae12c5060524, setup.rs108 makes EXE_ARGS optional, lines122-123 return Option, and the test at356-358 accepts `--silent` without `--`. install.rs252-255 starts the app only when not silent. Thus the absence of trailing `-- --migration-staged` is not evidence of this failure and adding it is not a verified fix. setup.rs127-140 parses arguments and initializes the requested log before package install. No log suggests an earlier failure or logging initialization issue, but exit1 alone does not identify which. The earlier benign fixture used quoted Start-Process arguments and a trailing marker; the production runner uses ProcessStartInfo.ArgumentList. Those differences have not been shown to cause failure.

Source: https://github.com/velopack/velopack/blob/8d2844f324a69bd848719ef465b1ae12c5060524/src/bins/src/setup.rs and https://github.com/velopack/velopack/blob/8d2844f324a69bd848719ef465b1ae12c5060524/src/bins/src/commands/install.rs . Current stage remains unaccepted; collect actual diagnostics only through a separately permitted invocation, never work around an execution denial.
