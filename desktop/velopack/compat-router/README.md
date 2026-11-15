# Versioned compatibility router

Purpose: an old MSI client requesting latest can download the exact versioned
Setup filename it understands. This net48 GUI routes legacy installs to
the unchanged, SHA256-pinned published 0.4.4 bridge. The bridge retains its own
consent, task protection, backups and installation logic. It starts 0.4.4, whose
startup check (3 seconds, then 6-hour intervals) notifies about latest; the user
clicks to install that update. No silent second-stage installation is promised.

Existing Velopack: tell the user to update in-app; do not migrate or downgrade.
Fresh install: read the same-version NewInstall ZIP embedded in the EXE, verify
its build-pinned SHA256, extract bounded safe members, then open the installer UI.
Unknown/conflicting inventories fail closed. No automatic retry of uncertain
installation, force termination, registry deletion, data cleanup, or modification
of the published bridge. A child exit code is not claimed as latest installed.

Build with verified current artifacts:

    ./build.ps1 -Version <current-version> -VelopackDirectory <verified-dir> -Output <new-dir>

Then use scripts/assemble-release.mjs with its `public` output. Schema 3 receipts
bind the output EXE hash, bridge identity and the verified embedded fresh ZIP hash.
The ZIP remains a required verified build input, but is not a published asset.
Final assembly preserves both old-MSI and Velopack update assets and checksums.
Every release retains a same-version APK using the existing signing identity,
including desktop-only updates, so users never need to search older releases.
Legacy migration still needs network to fetch the pinned bridge; an offline failure
leaves the installation untouched. TLS/redirect host restrictions and embedded
SHA256 are enforced. Download/extract cache and migration recovery are retained.

## Integrity and execution safety

The router verifies the pinned bridge or embedded ZIP before execution. It holds
read-only file leases through child exit and rehashes extracted members, so an
intervening write cannot silently substitute an executable. Existing extraction
targets, changed content and conflicting install inventories are rejected.
Schema 3 receipts bind the public EXE to its embedded fresh-install ZIP; legacy
schema 2 receipts remain only for reproducing historical packages.

`build.ps1` reopens the compiled assembly and verifies the embedded resource
against the build input. Keep the independent published bridge hash and the
release-assembly checks; a self-consistent receipt is not enough on its own.

## Verification boundaries

Policy, receipt, extraction, file-lease and assembly regressions use isolated
fixtures. A successful build or unpack does not prove first installation,
legacy MSI migration on a new machine, or real mobile/tray behavior. See
[historical integration evidence](../INTEGRATION_STATUS.md) for version-scoped
results; rerun applicable tests for each new candidate. Temporary candidate
paths, sizes and hashes from development are not supported download targets.

## Recovery candidate (not release validated)

`build.ps1 -EnableRecovery` optionally embeds a build-pinned full nupkg and a
self-contained external BootstrapWorker ZIP. Both resource hashes are reopened
and compared after compilation and recorded in the build receipt. Without this
switch, existing-install behavior remains the previous in-app update direction.
The router uses the existing exact update-cache layout and strict receipt, checks
worker readiness identity/liveness, asks the user to save work and approve graceful closure,
then commits and exits only after the exact application processes close safely. The corrected external worker, not the old
installed worker, validates occupancy and applies the package. It never forces
termination. Cancel/readiness errors write cancellation markers. MSI and fresh
routes are unchanged; migration text is shown only after detecting legacy MSI.

2026-11-15 local candidate evidence: complete REPAIR-enabled router compiled with
zero warnings/errors using deliberately invalid non-release resource fixtures;
11 readiness/hash/extraction tests, 34 routing tests and 5 layout scales passed.
No actual updater/installer was launched, no registry was modified. This is not
an end-to-end clean install or repair validation. Native Restart Manager and a
real isolated upgrade must pass before enabling this in published artifacts.
All fixture binaries and router-layout-proof.png are diagnostics, not release
assets. Recovery resource packing adds runtime size; measure final output before
shipping. A successful handoff is not an installation-success claim.


Real-resource follow-up: `-EnableRecovery` was built successfully against the
verified local 0.4.6 fresh ZIP and full nupkg. The final EXE resources were reopened
and hashed by the build script; the real fresh archive's six members passed
Windows extraction/lease checks. The self-contained recovery runtime carries the
exact restored .NET runtime package's LICENSE and THIRD-PARTY-NOTICES. The full
real helper ZIP also passed the same locked extraction path, without launching
it. This proves packaging, not installation. The historical 0.4.6 payload still
contains the old updater, so this test output must not be released; the final
higher-version package must contain the corrected installed worker as well.
