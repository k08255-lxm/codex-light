# Desktop close preference checks

`dotnet run --project test/native-close-behavior/Tests.csproj -c Release`

Uses unique temporary fixture files, never the real close preference or Codex configuration. Tests first-use Ask, restart persistence, reset to Ask, corrupt state fallback, save errors, nonce/message schema, native origin restrictions and unshown dialog remember/cancel behavior.

`node --test test/desktop-close-preference.test.mjs` covers the settings selector, browser/LAN hiding, save rollback, native notification races and the updater early-exit boundary.

Native storage: `%LOCALAPPDATA%/CodexLight/close-behavior.json` (version 1; ask/tray/exit). Close preferences are independent of Codex settings. Explicit tray-menu Exit and verified update shutdown bypass the close preference; Windows session-end handling is unchanged. No host-setting HTTP API is exposed. Persistence failure is reported and does not silently claim the preference was saved.
