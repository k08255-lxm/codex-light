# Optional Velopack release build

This tooling builds/verifies artifacts only. It never publishes, installs, starts the normal application, changes the MSI release path, or migrates a user installation.

## Inputs

- A complete current-version payload produced by `desktop/build.ps1` (including the inherited license bundle).
- A matching host published with the opt-in Velopack integration, using **Velopack 1.3.39-g8d2844f**. For the current opt-in switch: `dotnet publish desktop/CodexLight.Desktop.csproj -c Release -r win-x64 --self-contained false -p:EnableVelopackPrototype=true -o <new-host-directory>`.
- Standalone worker output: `dotnet publish desktop/velopack/worker/UpdateWorker.csproj -c Release -r win-x64 --self-contained false -p:Version=<current-package-version> -p:DebugSymbols=false -p:DebugType=none -o <worker-output>`. The worker is never executed by packaging.
- Python, .NET SDK, and optionally a `dotnet tool install vpk --version 1.3.39-g8d2844f --tool-path <local-tools> --add-source https://api.nuget.org/v3/index.json` installation. If `-ToolPath` is omitted, the build installs that pinned tool inside its new output directory, not globally.

```powershell
./desktop/velopack/build.ps1 -PayloadPath <complete-payload> -VelopackHostPath <host-output> -WorkerPath <worker-output> -Output <new-empty-output> -ToolPath <local-tools>/vpk.exe
python -m unittest discover -s desktop/velopack -p test_verify.py -v
```

The output path must not already exist. Existing/distributed artifacts are never overwritten. The package ID is fixed to `CodexLightDesktop`, separate from the existing `CodexLight` data directory. The same three-part version is required in repository, payload and host.

## Output and integrity

`release/` contains a full `.nupkg`, installer EXE, portable ZIP, full-only feed, SHA256SUMS and a verification report. No deltas are generated. WorkerPath is mandatory. Only the worker EXE, DLL, deps.json and runtimeconfig.json are staged under `update-worker/`; exact version, win-x64/net10 and framework-dependent runtime are checked. `work/final-payload-manifest.json` records hashes of all final staged files including the worker.

Every staged source file is compared against its packaged and portable content. Feed package identity/version/name/size/SHA256/SHA1 are checked. The installer must contain the exact verified full package. ZIP traversal, duplicates and unknown payload content are rejected. The MIT license is pinned to the NuGet package repository commit `8d2844f324a69bd848719ef465b1ae12c5060524`; the pinned tool's vendor notice is included too.

The tool's normal app-invocation bootstrap check is deliberately skipped to guarantee the packaging command cannot open an app window. Runtime reference/version is verified statically, but fast-hook correctness must pass integration tests independently. A successful build is not evidence of safe migration or a working app.

## Release gates still required

- The packages are unsigned unless a separate approved signing pipeline is applied. Signing changes bytes; rerun verification and regenerate checksums after signing. This script does not request or handle private signing keys.
- Velopack bootstraps .NET 10 desktop and WebView2. **It does not install Node.js**. Existing prerequisite detection/bootstrap or an explicit safe Node requirement is required before exposing this installer as a supported first-install path.
- Task-idle/interruption consent, safe process shutdown, first-MSI migration, stable executable paths, updater transaction recovery, and user-data compatibility are runtime integration requirements, not provided by this packaging script.
- Never publish the independent benchmark identity/fixtures. The application root must not be the existing user data directory.

No network feed is modified by these tools. Use a new release version after changing already-distributed application contents.

### Prerelease policy

Tool and runtime are deliberately synchronized to **1.3.39-g8d2844f (official prerelease)**. The build rejects a mismatching stable or preview CLI/runtime. The prior 1.2.161 Setup forwarding defect is historical; the selected revision contains its source fix, but this does **not** authorize migration execution or establish end-to-end migration acceptance. Keep the wrapper gate closed until isolated installation/recovery evidence is reviewed. `README.md` and `TEST_REPORT.md` distinguish real portable apply tests from untested MSI migration.
