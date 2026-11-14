# Local storage maintenance

Settings > Storage reports three separate categories: browser cache, image data,
and installation temporary data. These are known owned-file totals, not a scan of
the whole disk. Inaccessible and protected data is called out separately.

## Boundaries

- Only authenticated local clients may scan, plan, apply, or restore. LAN clients
  cannot manage the host storage. Demo mode cannot mutate files.
- Scanning never reads Codex configuration, conversations, projects, credentials,
  Windows Installer caches, or existing recovery archives.
- Cache candidates are narrow cache subdirectories of old WebView session
  profiles. The active profile is protected; if it is unknown all profiles are
  protected. Login and cookie databases are never candidates.
- Image accounting currently includes only upload-store staging metadata. Every
  current upload is protected. Historical inline images live in Codex sessions,
  are deliberately not scanned, and cannot be removed from this page. Thus the
  displayed image total is not the total size of all historical images.
- Installation candidates are only updater-owned EXE/partial download paths.
  SetupLogs and MSI sources are protected, as are SetupArchives and other backups.

## Confirmation and recovery

Every operation requires a fresh preview and explicit user confirmation. The
server holds a single-use manifest valid for two minutes, bounded to 1,000 files,
256 MiB total, and 32 MiB per file. Files changed after preview are skipped. No
client-provided filesystem paths are accepted. Busy tasks/uploads/updates block
maintenance. Symbolic/reparse paths are refused.

The default action archives files with gzip, verifies the original bytes, writes
an owned recovery manifest, then removes unchanged originals. Archives remain in
StorageRecovery and can be restored from this settings page after restart.
Restore never overwrites an existing file. Archives are not automatically expired.
Archiving does NOT guarantee space savings: incompressible files may grow, and
reported logical byte differences are not measured free disk space.

Only regenerable old browser caches offer permanent deletion. The confirmation
explicitly says this cannot be restored; each individual plan must be confirmed.
Images and installation data do not offer permanent deletion here.

All failures and partial outcomes retain recoverable copies when possible and are
reported; original files changed during processing are retained. This is not a
privileged service or a defense against a hostile concurrent process running as
the same OS user. All validation tests use disposable fixtures, not user data.

## Native WebView layout

Cache detection supports both legacy direct session profiles and the native
`WebView/Sessions/<outer UUID32>/<inner UUID32>/EBWebView/` layout. It examines
at most 256 outer and 256 inner directory entries per profile, then only the
existing Cache/Code Cache/GPUCache whitelist. GPUPersistentCache, Cookies,
Local Storage and unknown directories remain untouched. The whole active outer
session is protected, including sibling inner profiles. Unknown active identity
protects all session caches. Restore uses the same layout and active-session rule.
