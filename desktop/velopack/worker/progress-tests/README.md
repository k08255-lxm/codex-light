# Native bootstrap progress checks

`dotnet run --project desktop/velopack/worker/progress-tests -c Release`

Creates only synthetic off-screen Win32 windows. Does not run the updater, inspect or stop the installed app, modify configuration, or mutate the installation. Exercises real UI message dispatch, non-dismissable in-progress state, phase changes, success/error terminal state, long selectable/scrollable diagnostics, terminal-state protection, and disposal.

The embedded bootstrap manifest opts into system-DPI awareness and Windows common-controls v6. File validation shows the verified file count and advances the native progress bar. Phases without a measurable total use the native marquee. The window title shows the current phase and final outcome. The worker reports success after checking the installed payload.

The harness writes `progress-check.bmp` and `progress-error.bmp` next to its executable using WM_PRINT; these validate content/layout, not DWM composition or actual on-screen animation. Mixed-monitor DPI, screen readers, full handoff continuity, and live updater behavior require separate validation.
