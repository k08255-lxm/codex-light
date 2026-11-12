# Codex Light internal MSI

This is a Windows x64, per-user Windows Installer package built with pinned WiX Toolset **6.0.2**. The user-facing installer is [CodexLight-Setup.exe](../setup/README.md), which embeds this MSI and invokes it silently. The MSI has no independent wizard, EULA page or automatic application launch.

WiX is a development tool installed locally under `.tools/wix6`; it is not part of the application. Review the tool author's [licensing and OSMF terms](https://docs.firegiant.com/wix/osmf/) when using its binary releases. This repository's MIT license does not replace third-party tool terms.

## Build

From the repository root, install the pinned tool, build a complete framework-dependent application payload, and select the directory written by `desktop/dist/current.json`:

```powershell
dotnet tool install wix --version 6.0.2 --tool-path .tools/wix6
./desktop/build.ps1 -Runtime win-x64
$current = Get-Content ./desktop/dist/current.json -Raw | ConvertFrom-Json
$payload = (Resolve-Path (Join-Path './desktop/dist' $current.directory)).Path
./desktop/msi/build.ps1 -Payload $payload -Version 0.3.0
./desktop/msi/verify.ps1
```

Python 3 and the .NET SDK are required. `build.ps1` defaults to input `desktop/dist/CodexLight-win-x64-0.3.0` and output `desktop/msi/out-release-0.3.0`; pass `-Payload` for a timestamped application build, or `-Output` for another output directory. Use a new three-part version for every distributed replacement.

If a local NuGet feed is required, populate it with the official `wix.6.0.2.nupkg` from the NuGet flat-container endpoint and pass `--source '<local-feed>'` to `dotnet tool install`. Do not commit the downloaded tool or feed.

`generate.py` curates application files and licenses, then generates `Product.wxs` and `payload-manifest.json`. Root application files, `app/src/`, `app/public/`, `licenses/` and the x64 WebView2 loader are allowlisted. Build tools, user data, other runtime architectures and obsolete installer payloads are excluded. The resulting MSI contains its cabinet; there is no external payload directory. Repeatable inputs and procedure do not imply byte-identical package output.

## Setup contract

- Setup invokes `msiexec.exe /i "<package.msi>" /qn /norestart /L*v "<log>" SETUP_PREREQUISITES_VERIFIED=1 INSTALLFOLDER="<absolute-directory>"` after successful dependency detection.
- The default location is `%LOCALAPPDATA%\Programs\CodexLight`. A first installation requires a directory that does not already exist. Upgrades and maintenance retain the registered location; they do not relocate the application or overwrite an unrelated non-MSI installation.
- MSI launch guards check Node 20+, .NET 10 Core and Desktop runtimes, and the WebView2 minimum from `WebViewRuntime.MinimumMajor`. Searches use versioned file resources and linked locator chains. Setup supplies broader detection for nonstandard dependency paths; MSI itself does not install dependencies. Maintenance and uninstall bypass these dependency checks.
- Stable UpgradeCode: `{C63D113F-36E4-46F6-B635-F1CE57BD166E}`. ProductVersion defaults to `0.3.0`; MSI version component bounds apply. Same-version payload replacements are not upgrades. ProductLanguage remains `1033` for related-product compatibility. Downgrades are blocked, and old-product removal occurs inside the rollback transaction.
- Installation ownership is established through related-product enumeration and MSI registration. An installer registry path by itself does not prove ownership of a folder.
- Exit `0` succeeds; `3010` requires a restart, `1641` reports a restart already initiated, `1602` means cancellation, and `1618` means another installation is in progress. Other nonzero codes remain errors.
- Windows Installer owns registration, uninstall and the current-user Start Menu shortcut. There is no desktop shortcut or automatic launch. Uninstall removes MSI-owned resources without removing shared runtimes, Codex configuration, projects or sessions. Do not place user files inside the application installation directory.

## Package inspection

`verify.ps1` decompiles and extracts the cabinet without installing, compares file sizes and SHA256 values, and reads MSI tables in read-only COM mode. It checks installation scope and identity, dependency locator chains and version bounds, launch guards, cleanup and upgrade sequencing. It rejects independent dialog/control tables, executable Binary streams and UI-level overrides. The only custom actions permitted are standard type 51 property assignments.

The script writes `verification.json` beside the MSI. Generated WiX XML, manifests, receipts and extracted files remain local build outputs. Static package inspection does not replace Windows installation, upgrade, uninstall or signing checks.
