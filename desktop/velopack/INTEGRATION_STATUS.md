# Integration status and verification boundaries

This branch is development work, not a released replacement installer. Default MSI builds remain unchanged; Velopack support is explicitly opt-in.

## Implemented

- The native host enables the Velopack transport only for a validated `CodexLightDesktop/current` installation with the external worker present. User data stays in the separate `CodexLight` directory.
- The backend selects full packages from the fixed project release, verifies published SHA256 and exact version, reserves update execution, and blocks new mutations while unresolved.
- Idle checks include turns, approvals, queues, terminals, DSH work and operation state. Missing or unknown state blocks installation.
- Native package validation holds a read lease and checks install identity, exact cache path, ZIP metadata and contents.
- The update worker is staged outside the program tree. It uses the official updater with `--norestart`; it never promises user-data rollback or automatically kills tasks.
- Packaging verifies all staged file hashes in the full package and portable archive, verifies the Setup embedded package, and produces checksums without publishing.

## Release blockers / evidence still required

- The parent/worker ready, cancellation, commit and graceful-exit handshake must be verified as a whole, including leftover job children and user exit after a timeout.
- MSI migration must prove the exact legacy product and source, retain recovery material, preserve user data, and defer old MSI retirement until new-app health has actually been observed. A pure coordinator test is not a Windows Installer migration test.
- Node prerequisites must be checked before a supported first installation. A bare vendor Setup does not install Node.
- Permission-denied process inspection must fail closed. This may block updates on a machine until a safe way of establishing process absence is available.
- Actual first installation, migration, process locks, interrupted update, new-app health, and recovery need an isolated Windows environment. They have not been exercised on the user's real installation, by design.
- Packages are unsigned. Checksums fetched from the same release establish artifact integrity, not an independent publisher-signature trust root.
- Publishing requires a new version for changed distributed contents. No release is created by the development scripts.

See README.md for the measured isolated directory-update timings and exclusions. Those figures are not measured production downtime, MSI migration time, or a controlled MSI-versus-Velopack speedup.

## Selected dependency and isolated regression

The opt-in host and packer now both pin official **1.3.39-g8d2844f (prerelease)**, repository commit `8d2844f324a69bd848719ef465b1ae12c5060524`. The prior stable 1.2.161 Setup argument-forwarding issue is historical for this branch, not its current dependency. The migration execution gate remains closed pending actual migration acceptance.

Real portable full-package application and forced new-directory replacement failure were tested in independent artificial-version roots. Full applies verified every expected installed file; the injected rename failure restored all old current hashes. This narrows the failure-handling uncertainty, but does not prove first MSI migration, interrupted-power recovery, real task-drain integration, or user-data recovery. Successful apply removes its old temporary backup. See TEST_REPORT.md for test scope and README.md for timing exclusions.
