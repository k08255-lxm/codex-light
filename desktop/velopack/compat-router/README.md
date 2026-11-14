# Versioned compatibility router

Purpose: an old MSI client requesting latest can download the exact versioned
Setup filename it understands. This small net48 GUI routes legacy installs to
the unchanged, SHA256-pinned published 0.4.4 bridge. The bridge retains its own
consent, task protection, backups and installation logic. It starts 0.4.4, whose
startup check (3 seconds, then 6-hour intervals) notifies about latest; the user
clicks to install that update. No silent second-stage installation is promised.

Existing Velopack: tell the user to update in-app; do not migrate or downgrade.
Fresh install: download the same-version NewInstall ZIP using a hash embedded at
build time, extract bounded safe members, then open its existing installer UI.
Unknown/conflicting inventories fail closed. No automatic retry of uncertain
installation, force termination, registry deletion, data cleanup, or modification
of the published bridge. A child exit code is not claimed as latest installed.

Build with verified current artifacts:

    ./build.ps1 -Version 0.4.5 -VelopackDirectory <verified-dir> -Output <new-dir>

Then use scripts/assemble-release.mjs with its `public` output. Schema 2 receipts
bind the output EXE hash, bridge identity and current fresh ZIP hash. Final
assembly verifies both old-MSI and Velopack update transports and preserves APK.
The build needs network at runtime to obtain GitHub assets; an offline failure
leaves the installation untouched. TLS/redirect host restrictions and embedded
SHA256 are enforced. Download/extract cache and migration recovery are retained.

Validation so far: net48 compilation 0 warnings/errors; 34 route/policy cases;
12 release assembly cases, including altered bridge/fresh identities refused.
These are not a real MSI migration, first install, or GUI acceptance test.
The 0.4.4 published SHA256SUMS was retrieved from its fixed GitHub release and
matches the bridge pin. Existing fixed original executable was not executed.
No isolated Windows VM/Sandbox was discovered in checked standard tool locations.

Prior two-stage-coordinator experiments are superseded, not release dependencies.

## Final candidate assembly (2026-11-14)

Built version 0.4.5 against the verified candidate-045-20261114 fresh ZIP pin.
The six assembled candidate assets are in the private worktree's ignored
`.eval/release-0.4.5-candidate`; this directory was NOT uploaded or published.
Router size: 22,016 bytes. Router SHA256:
`0498e6fb56eeeabe4e3a2261494f891b539d6a5651c58795f431448f6483c3bc`.
Native test harness links the exact router sources without constructing its UI.
On Windows, fresh ZIP extraction passed and all six extracted member hashes match
the source ZIP. No extracted executable was started. Sandboxed raw network access
was denied; no security setting or execution policy was changed. A separately
approved outside-sandbox run is recorded separately when complete.

Not verified: actual legacy MSI migration end-to-end, first installation,
installed Velopack update, real mobile device, real tray interactions. A successful
build or unpacking result is not a claim those scenarios passed.

Approved local-user native test result: PASS. The exact router source's net48
Download function fetched the fixed GitHub 0.4.4 EXE and matched
`b2410266d12946301ffecebaa9c1fa77c8cebd065fe889cdb8eb83b974245aba`.
Fresh extraction also passed. This was run through the supported execution
approval flow, not by changing execution policy or network/security settings.
No installer was executed. Regression suite: 52 passed, 0 failed/skipped;
separate native policy suite: 34 passed. These supersede only the earlier
network-unverified note, not the remaining real installation/device gaps.

## Review fixes: execution leases and fixed-policy receipts

The earlier 22,016-byte candidate is superseded by `.eval/release-0.4.5-leasefix`.
Router is now 24,064 bytes, SHA256
`ef59a771bb86464bbd0f3266fbc41077eb35fa80c1c5904ba533884ad751dc22`.
`VerifiedLease` rehashes the bridge/ZIP after acquiring FileShare.Read and holds
it through child exit. Fresh extraction rehashes each member from the locked ZIP
while acquiring read-only leases for every output, including configuration and
DLLs, and retains them through child exit. A writable creation handle is closed
before read-lease acquisition, because retaining it can block the Windows loader.
The intervening path is never trusted without the new lease's hash verification.
Native Windows tests prove ZIP/member write+delete attempts fail, a modified file
is refused, and an innocuous child executable can start under the read lease.
No installer was started by these tests.

Post-0.4.4 assembly now requires schema2 fixed-bridge receipts; even internally
consistent schema1 embedded-migration receipts are rejected by a regression test.
