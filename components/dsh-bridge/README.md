# Codex Light bundled DSH MCP bridge

This bridge ships with Codex Light by default. DSH itself is optional and is **not** bundled. Without DSH, the normal Codex application continues to work. The user explicitly selects **Connect to Codex** before any MCP registration or Light-owned DSH profile is created.

Derived from `dsh-subagent-mcp` 0.8.0 under MIT (see LICENSE). The small desktop preset compatibility overlay derives from DeepSeek's MIT-licensed DSH; its notice is in `assets/DeepSeek-MIT-LICENSE`. No user configuration, sessions, credentials, private providers, or DSH binaries are included.

The component uses the user's installed DSH desktop executable in `ELECTRON_RUN_AS_NODE=1` mode. The supported DSH runtime is 0.2.2 with SQLite support (Node 22.15+); this does not raise the main application's Node.js 20 requirement. It does not open a desktop window. The independent `codex-light-bridge` profile and Light-owned state do not replace an external bridge or its running tasks.

Reproducible build:

```sh
npm ci --prefix components/dsh-bridge --ignore-scripts --omit=dev
node components/dsh-bridge/build.mjs
```

The exact public-registry dependency lock, source, MIT notices, and a generated dependency-license inventory are included. Desktop packaging builds/verifies this payload and copies the component and its dependency licenses by default. Dependencies are never downloaded at application startup or connection time.

Configuration sources are one-way imports of provider declarations. Existing live tasks keep their loaded revision; new runtimes follow valid selected files. Inline secrets and full plugin trees are not copied. Runtime permissions retain the upstream bridge's explicit per-task sandbox choices and owner checks.

DSH's normal built-in DeepSeek provider remains usable with no third-party provider declaration. A valid empty profile imports nothing; explicit zero selected sources means built-in only. An explicitly selected malformed, missing or conflicting source is rejected rather than silently ignored.
