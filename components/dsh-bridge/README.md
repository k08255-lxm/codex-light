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

## Compact desktop distribution

Desktop packaging runs `node build.mjs --bundle` after restoring the component
lock and the separate `tools/package-lock.json` with `npm ci --ignore-scripts`.
The build tool is pinned to esbuild 0.25.12. It is never installed or executed
when the application starts, and is not distributed in the application.

`dist/` is the complete redistributable bridge. All local source-module paths
remain intact (including service-runner, the desktop probe and DSH plugin).
Third-party JavaScript is bundled into shared ESM chunks without minification.
YAML remains a real package because provider discovery uses `createRequire`.
Optional ws native accelerators are not shipped; the tested JavaScript fallback
is used. No DSH runtime or model is included or launched by the build.

The distribution manifest records every output SHA-256 (except its own file),
the complete input-source map, component lock, bundler lock/version and all
96 dependency license entries. The adapter hashes are regenerated *after*
bundling. Consumers must validate the exact file set, not merely look for
package.json files. These checks detect stale/corrupt artifacts; they do not
replace release signatures or establish provenance against a malicious author.

Build and synthetic verification from the repository root:

```powershell
npm ci --prefix components/dsh-bridge --ignore-scripts --omit=dev
npm ci --prefix components/dsh-bridge/tools --ignore-scripts
node components/dsh-bridge/build.mjs --bundle
node --test test/dsh-bundle-integrity.test.mjs
node test/dsh-bundle-runtime.mjs
node test/dsh-bundle-stdio.mjs
node test/dsh-bundle-providers.mjs
```

Runtime fixtures use only temporary configuration and loopback mock servers.
They cover tool discovery/dispatch/schema failures, HTTP security, stdio proxy
metadata and framing, ws multiplexing and YAML loading. They do not validate
real provider inference, daemon autostart or real-user DSH task lifecycles.
The integrity test creates a temporary directory junction/symlink; restricted
sandboxes must run that test in an environment that permits creating links.
