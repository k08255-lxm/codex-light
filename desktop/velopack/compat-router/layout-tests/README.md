# Router layout regression test (Windows)

Run `dotnet run --project desktop/velopack/compat-router/layout-tests/LayoutTests.csproj -c Release`.

This builds the actual RouterWindow with fixture pins, creates it off-screen, and checks that both buttons stay completely inside the action row and client area. It toggles the progress control repeatedly and resizes at 100%, 125%, 150%, 175%, and 200% control scaling. It does not click Continue or invoke detection, download, extraction, installation, or user configuration changes.

The scale cases exercise WinForms layout geometry, not physical monitor / per-monitor DPI switching. Actual mixed-DPI desktop transitions require separate interactive validation.

The test executable embeds the router manifest and asserts actual system-DPI awareness through GetProcessDpiAwareness before constructing controls. System-aware mode avoids bitmap scaling at system DPI; moving between different-DPI monitors is not claimed as PerMonitorV2 support.
