# Codex Light Setup

`CodexLight-Setup.exe` is a single .NET Framework 4.8 WPF executable containing the per-user application MSI. The installer UI uses the system Framework and does not need modern .NET or WebView2 to display. The application has its own runtime requirements; see [INSTALLATION.md](../INSTALLATION.md).

## Build

Run from the repository root on Windows with the .NET SDK and Python 3 installed. First build the framework-dependent application payload and [internal MSI](../msi/README.md).

```powershell
./desktop/setup/build.ps1 -VerifyLayout
# Default input: desktop/msi/out-release-0.3.0/CodexLight-0.3.0-x64.msi
# Output: desktop/setup/out-release-0.3.0/CodexLight-Setup.exe
```

Use `-MsiPath '<absolute-path-to-msi>' -Output '<output-directory>'` for explicit inputs. Rebuild the application, MSI and Setup together for each release version.

The build uses Python to verify that the exact input MSI occurs once in the CLR embedded-resource directory, without loading or starting Setup. It records the MSI and Setup hashes in `build-receipt.json`. Only the resulting Setup executable is a user installation entry point; the MSI remains embedded. Generated files and receipts stay in the build output directory.

## Layout checks

`-VerifyLayout` builds a `net10.0-windows` WPF test DLL linking the same `SetupView.cs` and runs it through the installed system `dotnet.exe`. The project sets `UseAppHost=false`. The runner uses offscreen measurement and rendering without a Window or HWND, and writes previews and `layout-report.json` below the output directory.

The checks cover supported DPI scales, long Chinese paths, installation states, details expansion, long errors, keyboard action gating, selectable paths and button placement. They do not launch Setup, download dependencies or install the application. Offscreen rendering does not establish physical monitor, accessibility, net48 startup or clean-machine installation compatibility.

## Installer behavior

`Program.cs` hosts `SetupView.cs` and connects the setup engine. WPF owns scaling, with per-monitor DPI declarations and Framework switches configured before UI initialization. The location field is selectable and read-only; the parent-folder picker appends `CodexLight`. A registered MSI installation retains its location and offers an update. An existing non-MSI directory is not claimed or overwritten.

Startup checks process integrity before dependency detection. Low or Untrusted integrity, or an integrity-check failure, produces an explicit stop. Setup does not restart itself elevated or modify ACLs.

Setup links runtime detection, dependency installation and shared runtime/integrity helpers from the repository. It reuses compatible dependencies and installs only missing ones after official URL, pinned hash, Authenticode trust and publisher checks. Dependencies are checked again before application installation. Vendor installers use supported unattended/passive arguments and retain system authorization behavior.

The embedded MSI is extracted under `%LOCALAPPDATA%\CodexLight\SetupLogs\<attempt>`. Setup invokes Windows Installer with `/qn /norestart`, a verbose log, an absolute `INSTALLFOLDER`, and `SETUP_PREREQUISITES_VERIFIED=1` after successful dependency detection. Windows Installer owns managed files, rollback, upgrades, registration and shortcuts. Logs and cached packages remain for diagnosis and source repair. Shared dependencies are retained if application installation fails.

Exit `0` succeeds, `3010` requires a restart, `1641` reports a restart already initiated, and `1602` reports cancellation; other codes remain errors. Completion provides explicit user actions and never automatically launches the application. Build outputs remain unsigned unless the release signing process signs them.

## References

- [.NET Framework 4.8 WPF DPI support](https://devblogs.microsoft.com/dotnet/announcing-the-net-framework-4-8/)
- [Windows manifest DPI declarations](https://learn.microsoft.com/en-us/windows/win32/hidpi/setting-the-default-dpi-awareness-for-a-process)
- [Microsoft WPF per-monitor examples](https://github.com/microsoft/WPF-Samples/blob/main/PerMonitorDPI/readme.md)
