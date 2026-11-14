# Integration status and verification boundaries

## Current state (2026-11-14)

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

### Boundaries and remaining release checks

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
