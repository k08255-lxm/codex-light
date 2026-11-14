# Windows installation and updates (Velopack)

The desktop uses Velopack packages from 0.4.4 onward. The package identity remains
`CodexLightDesktop`; application data stays in the separate `CodexLight` directory.
Changing the visible brand must not change either identity.

## Maintenance entry points

- [Build and artifact verification](BUILD.md): pinned tool/runtime, complete payload,
  source integrity and packaging commands.
- [Legacy MSI migration contract](MIGRATION_RELEASE_POLICY.md): the immutable 0.4.4
  bridge and update behavior for clients that skipped it.
- [Compatibility router](compat-router/README.md): later-release manual download
  entrypoint and routing between legacy, existing Velopack and fresh installations.
- [First-install prerequisites](setup-wrapper/README.md): explicit dependency consent
  and reuse of installed runtimes.
- [Migration bootstrap](public-bootstrap/README.md) and [migration recovery](migration/README.md).
- [Worker](worker/README.md) and [runtime safety](safety/README.md).
- [Historical verification](INTEGRATION_STATUS.md): scoped regression evidence,
  measurements and remaining limitations, not a current release checklist.

## Update boundaries

The host selects the Velopack transport only for a validated installation with
its external worker. It validates version, package identity and published hashes,
reserves an idle application, performs the worker handshake and exits gracefully
before applying the full package. Unknown task/process state blocks the update.
Startup does not silently apply pending updates, and active tasks are not killed.

The official tool and runtime are pinned together to **1.3.39-g8d2844f
(prerelease)**. Keep the vendor binary checks and required notices. The build
property remains `EnableVelopackPrototype=true` for compatibility with the existing
build scripts; its name does not mean all current updates use the legacy MSI path.

Full packages are the current release route. Historical delta measurements saved
network bytes but increased local reconstruction time; they are not a production
speed guarantee. Successful updates do not establish automatic rollback after
success. Preserve migration recovery material and stop on uncertain transactions.

The benchmark scripts are isolated developer tools, not application update
commands. Do not publish their independent identities or fixture packages.
Compilation, fixtures and portable updates do not by themselves validate fresh
installation, interactive consent, real devices or power-loss recovery.
