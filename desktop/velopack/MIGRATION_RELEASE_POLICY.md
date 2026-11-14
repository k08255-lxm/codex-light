# One bridge release, not recurring migration implementations

0.4.4 is the intended fixed MSI-to-Velopack bridge release. This policy is a
forward compatibility contract, not a claim that later-version routing or the
real migration acceptance has already passed.

## Existing clients

Released 0.4.3 requests GitHub `releases/latest`, selects
`CodexLight-Setup-{latest-version}-x64.exe` (with a historical unversioned fallback),
verifies the matching entry in `SHA256SUMS.txt`, then starts that EXE without
arguments. It does not search historical releases or stop the old application.
Keeping only the 0.4.4 installer in an older release therefore cannot support
users who skip 0.4.4.

## Later releases

- Keep a small versioned compatibility router under the exact filename expected
  by old clients. Its displayed target is the latest release, not 0.4.4.
- If a verified legacy MSI is present, route to the immutable 0.4.4 bridge using
  a fixed project URL and a pinned SHA256 recorded at the original publication.
  Never replace the already published bridge bytes or trust a newly fetched
  checksum as the only identity for that fixed bridge.
- Explain the two stages: migrate to 0.4.4, then update through Velopack to the
  originally requested latest version. Do not claim success at the intermediate
  version. Preserve the selected final version across the handoff.
- New installs and verified Velopack installs must not run the old-MSI migration
  again. They use their normal installer/update path.
- Record and verify format/version/receipt identity. Stop on unknown inventory,
  a newer already-installed version, a missing bridge, changed hashes, network
  failure, or an unresolved previous migration. No recursion, forced downgrade,
  forced process termination, silent retry of an uncertain transaction, or
  manual deletion of MSI registration.
- A shortcut points at the stable Velopack root stub, never a versioned payload
  directory. Retain recovery material until final health and entrypoint checks.

Before the first post-0.4.4 release, implement and test that router with old MSI
0.4.3 skipping directly to the later release, existing Velopack 0.4.4, a fresh
machine, missing/corrupted bridge, interrupted stage, and repeated invocation.
The current tests prove the old client's filename/metadata constraints only;
they do not pretend to execute this future router.
