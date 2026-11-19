# Versioned compatibility router

Purpose: an old MSI client requesting latest can download the exact versioned
Setup filename it understands. This net48 GUI routes legacy installs to
the unchanged, SHA256-pinned published 0.4.4 bridge. The bridge retains its own
consent, task protection, backups and installation logic. It starts 0.4.4, whose
startup check (3 seconds, then 6-hour intervals) notifies about latest; the user
clicks to install that update. No silent second-stage installation is promised.

Existing Velopack installations use the external update/repair worker when the
build enables recovery. Other builds direct the user to the in-app updater.
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
legacy MSI migration on a new machine, or real mobile/tray behavior. Rerun
applicable tests for each new candidate. Temporary candidate
paths, sizes and hashes from development are not supported download targets.

## Installation and recovery payloads

The embedded NewInstall ZIP carries the Windows first-install wizard and its
Velopack Setup, including the complete desktop application package. The wizard
runs on .NET Framework 4.8 before .NET 10 is installed. The application files
can be installed offline when the machine already meets the prerequisites.
Downloads for missing prerequisites or the legacy MSI bridge need a connection.

`build.ps1 -EnableRecovery` also embeds an external BootstrapWorker ZIP. The
helper runs from the migration cache, outside the installation being replaced.
It uses the existing Microsoft.NETCore.App 10 x64 runtime and includes the
apphost's license and third-party notices. A missing runtime stops the repair
before the router requests application shutdown.

During packaging the verifier finds the exact full nupkg bytes inside the
fresh wizard and the build pins their offset, length and SHA256. Both embedded
ZIPs are rehashed in the compiled EXE. At repair time the router streams the
pinned range to a temporary file, verifies its hash, then publishes it into
the update cache. The external helper independently verifies the full package
and target before reporting readiness. The separate full nupkg in the public
release continues to serve in-app updates.

The router checks the worker's readiness and identity before requesting consent
for graceful shutdown. Cancel and readiness errors leave a cancellation marker.
Use the repair tests with the real helper ZIP, helper hash, NewInstall ZIP,
package offset, package length and package hash to exercise extraction without
starting an installer.
