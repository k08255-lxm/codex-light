# Isolated MSI migration fixture (build-only)

`Build-Fixture.ps1 -WixPath <existing WiX 6.0.2 wix.exe>` creates a new random identity under the process temporary directory. It uses the already downloaded `.eval/preview-1.3.39/tools/vpk.exe` 1.3.39-g8d2844f for this test only. Production dependency pins are not changed.

The output contains a minimal per-user MSI 1.0.0, a matching-identity Velopack 1.1.0 package, two benign WinExe payloads, an external data sentinel and `review-plan.json`. No installer, application or health command is run by the build. `--skipVeloAppCheck` avoids invoking the stub during packaging.

Normal stub startup exits without UI/account/application-data operations. Explicit `--fixture-health` hashes only files in its own payload manifest. A corrupted fixture file produces a nonzero result. This models integrity/branching, not Codex/DSH/model/network health.

Before executing anything, review the plan and read the actual MSI tables. Require unique ProductCode and UpgradeCode distinct from production; no CustomAction, Shortcut or Environment rows; fixed Temp installation root; no existing destination roots or matching HKCU registrations. Velopack shortcuts are `None`. The Windows Installer service will still create its own normal product/cache metadata if a later installation is authorized.

Potential later test: hidden `/qn /norestart` MSI installation; old health/data hash; silent Velopack installation into independent new root with old MSI retained; new hash health; deliberate new payload corruption and failed health with old MSI still working; restore known fixture bytes; retire only fixture MSI by exact ProductCode after healthy proof; recheck new health/data. Silent Setup does not start the app, so it does NOT prove first-run argument forwarding. No force-stop, production-root access, user configuration writes, or system MSI-cache deletion is permitted.

This fixture does not establish real application migration, authentic model task-idle state, per-user settings/schema compatibility, real shortcuts, full-app disk usage, or complete rollback. Production `Invoke-Migration.ps1` remains disabled.

Historical execution was **Run + inspected/reviewed Resume**, not one uninterrupted run: the first script safely stopped after successful MSI installation because it assumed HKCU ARP. Native MSI inventory established per-user unmanaged context 2 / AssignmentType 0, while ARP was actually HKLM 64-bit. The reviewed resume completed health, failure/restore, retirement and subsequent normal fixture uninstall. Original results preserve that event.

Both scripts now share `FixtureGuard.ps1`: MSI ProductState 5 plus exact fixture name/version/source and AssignmentType 0 are authoritative; the fixed ProductCode selects inventory and the reviewed MSI hash binds Product/Upgrade identity. ARP in both hives/views is recorded as auxiliary evidence and checked for residue after retirement, not mistaken for installation context. Unknown registration state fails closed. `Test-FixtureGuard.ps1` verifies guard rejection and script syntax without registry reads or installs. The revised uninterrupted script has **not** been rerun as an installation; its patch is validated through simulation and syntax only. Scripts remain pinned to the specific reviewed fixture, not a general installer runner.
