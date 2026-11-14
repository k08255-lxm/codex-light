# Native startup surface

Run `dotnet run --project test/startup-view/Tests.csproj -c Release -- artifacts/startup-view`.

Uses an unshown host and renders deterministic component frames to bitmaps. It does not start the application backend, run a model, change real preferences, or install anything. Covers actual phase messages, stopped failure state, complete selectable diagnostics, animation eligibility, dark/light and 200% DPI renderings. Visual previews are component renders, not live DWM window captures or measured frame-rate evidence.

Startup phases follow successful code boundaries: environment → backend handshake → WebView initialization → document navigation. No percentage, elapsed-time progress, artificial delay, automatic retry or simulated completion is added. Success navigation dismisses the surface immediately. The 240ms entrance and small rotating status arc run only while shown and allowed by Windows SPI_GETCLIENTAREAANIMATION; failure/hidden/disposed stop the timer.
