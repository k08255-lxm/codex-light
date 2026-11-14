# Node prerequisite gate

`NodePrerequisite.csproj` produces a .NET Framework 4.8 x64 console helper, available on supported Windows 10/11 without needing the .NET 10 runtime first. It links the existing MSI prerequisite downloader and pinned `desktop/installer/dependencies.lock.json`; no floating version lookup or additional dependency installer implementation.

- `--check-node ABSOLUTE_APPLICATION_DIRECTORY`: read-only detection. Searches system Program Files, registry and PATH before app-local runtime. Requires x64 PE and successful bounded Node version probe >=20. Existing compatible Node is reused; nothing downloaded.
- `--install-node ABSOLUTE_APPLICATION_DIRECTORY`: explicit consent-required entrypoint, not an automatic fallback. Rechecks first. Only clearly missing Node triggers the existing official Node MSI interactive installer; fixed hash, Windows trust and OpenJS/Node Foundation publisher checks apply. Uncertain/inaccessible/broken/old detected runtime fails closed rather than silently replacing it.
- Exit 0: compatible; 20: missing; 21: uncertain/error/unsupported command; 1602: cancellation; 3010: reboot required. Only 0 permits the wrapper to continue. Reboot and failure must not launch vendor Setup.

## Integration contract

`desktop/velopack/build.ps1` builds this helper and config into both the package `prerequisites/` directory and release `prerequisites/` sidecar directory. The final payload manifest/archive verification covers embedded copies. Release-side copies need to remain alongside the wrapper and be covered by release checksums.

The supported new-install/migration entrypoint must be a consent-aware wrapper: run check, present missing prerequisite and request explicit installation consent, optionally run install, stop on any nonzero code, then run verified vendor Setup. **Velopack vendor Setup by itself still does not check/install Node. Packaging the helper is not equivalent to integration. Do not expose bare Setup as the ready-to-use installation entrypoint.** Migration wrapper owns task-idle/MSI/data protection independently.

`--self-test` checks malformed/truncated/x86/x64 PE fixture parsing without running a runtime or installer. Live read-only detection confirmed the existing system x64 Node v24.13.0. No missing-Node installation, UAC or reboot was exercised; these remain isolated integration tests. This helper never changes system configuration merely on check.
