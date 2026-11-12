# Optional DSH configuration-source adapter

Codex Light already bundles its MCP bridge by default under `components/dsh-bridge/`. End users do not need to find, download or install another bridge. This directory is only a maintainer adapter for an existing external bridge, not the normal Light setup path.

Codex Light works without DSH. This integration is optional and is never installed or started by Light startup or its installer.

This adapter targets an existing [`dsh-subagent-mcp`](https://github.com/dqtz5vpvj9-create/dsh-subagent-mcp) **0.8.0** desktop bridge. It adds configuration-source snapshots at new-runtime boundaries. The implementation is [src/dsh-provider-sources.mjs](../../src/dsh-provider-sources.mjs); only that small module and three guarded bridge hooks are installed. No personal configuration or credentials are distributed here.

Review, then explicitly apply:

```powershell
node integrations/dsh-config-sources/install.mjs
node integrations/dsh-config-sources/install.mjs --apply
# Optional explicit bridge config directory:
node integrations/dsh-config-sources/install.mjs --config "C:\path\to\bridge\config" --apply
```

The tool locates the existing bridge through environment/Codex MCP registration, validates its package version and exact source anchors, backs up changed source files, preserves line endings, and publishes `src/provider-sources-adapter.json` last. It does not download dependencies, alter a source profile, change accounts, or restart anything. Unsupported versions fail before writing. Reapplying updates the small shared module; core hook installation is idempotent.

After all DSH tasks have finished, restart the bridge through its ordinary management procedure. This deployment intentionally does not stop running tasks. Light reports `pendingRestart` until the running daemon has recorded adapter activation; an absent or incompatible adapter reports `available:false` for this optional feature. Ordinary Codex chat remains usable.

Automatic mode reads selected `llm-pi-ai.config.providers` immediately before each new runtime. Existing live runtimes retain their version. Manual mode uses an explicit frozen snapshot until Refresh. Conflicting providers, invalid YAML, inline secrets, unsupported import fields and unsafe URLs are rejected. This is a one-way import; it does not overwrite all profiles or copy plugin trees or credentials. YAML syntax/import validation does not prove provider authentication or service availability.

To roll back while the bridge is stopped, restore the named files from the backup directory printed by the installer and remove the newly added module/capability marker if absent from that backup. Do not remove session history, user config, or credentials.
