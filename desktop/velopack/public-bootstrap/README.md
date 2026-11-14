# Public Windows bootstrap

A single `CodexLight-Setup-{version}-x64.exe` is the entry point for an old
0.4.3 client's **no-argument** installer launch and for a new installation.
The archive and helper are embedded, hash pinned at build time, and extracted
into a new per-run directory. Users never locate or start a second package.

## Behaviour contract

- Start immediately shows a native, DPI-aware window. Start is single-flight.
- The user saves work/confirms tasks complete once. If the old app is running,
  the same window waits for normal exit (including its tray process). Cancel
  during this wait makes no installation changes. It never kills processes.
- MSI identity/source is independently rechecked by `SafeStage`, not trusted
  from the lightweight routing probe. Incomplete/conflicting roots stop.
- Old MSI: exact hashes, runtime preflight, rollback MSI/data backup, stage,
  native/isolated-backend health, protected data checks, exact MSI retirement,
  shortcut handoff and post-retirement health run automatically. Only then
  does the wrapper open the new app. No fake GUI/account verification record
  is written; automated component acceptance is distinct from `ObserveGui`.
- Existing Velopack: direct installer replacement is refused; use the app's
  guarded updater. This package does not bypass its active-task safeguards.
- Fresh install: invokes the embedded existing prerequisite-aware wrapper.
  Its own result is authoritative, including cancellation. It does not touch
  Codex login/configuration or automatically sign in.
- Failure does not auto-retry stage or uninstall. Existing stage journals and
  backups are retained. If retirement fails after MSI removal, the verified
  new entry and recovery MSI/data remain; **automatic reinstall rollback is
  not implemented**. No blind deletion of partial/new/foreign roots occurs.
- The migration worker is framework-dependent .NET 10, already required by
  the old MSI application. The outer wrapper is .NET Framework 4.8 and does
  not require .NET 10 to show the fresh-install prerequisite flow.

## Build

```powershell
./desktop/velopack/public-bootstrap/build.ps1 `
  -StageRelease <verified-stage-release-directory> `
  -FreshInstallerDirectory <new-install-wrapper/public> `
  -Output <new-empty-output-path> -Version 0.4.4
```

Only `public/` is a release input. It contains the versioned EXE,
`release-bootstrap-receipt.json`, and checksum. `scripts/assemble-release.mjs`
requires the receipt to prevent mistakenly shipping an old MSI installer as
migration support. The bundle includes only fixed release/helper/fresh wrapper
artifacts, not machine receipts, account data, Codex state or logs.

The 0.4.3 client only queries latest. A later release cannot simply omit the
bridge and still migrate skipped versions. A fixed bridge handoff needs a
separate pinned, non-looping routing design; this implementation is the 0.4.4
transition entry, not an unverified dynamic download chain.

## Verification

`dotnet run --project desktop/velopack/public-bootstrap/tests/Tests.csproj -c Release`
checks 12 install routes and six automatic-flow failure/restart/order cases.
Migration tests additionally cover real health-evidence parsing and the existing
isolated filesystem/shortcut/receipt guards. These do not prove a real installed
MSI -> Velopack round trip. Build success is not installation success.

UI design routing: read `ui-skills` categories and interaction candidates,
selected `kemiljk/dxe-interaction-contracts`; implemented truthful pending,
cancel-before-mutation, error/recovery and no duplicate-submit states, semantic
native controls, keyboard focus and DPI layout. Visual QA remains separate.
