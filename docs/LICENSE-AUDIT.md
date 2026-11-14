# Distribution license audit

This is a scoped engineering inventory, not a statement that every legal or
trademark issue has been certified. Recheck it when dependencies or assets change.

## Verified distribution inventory (2026-11-14)

- The Windows 0.4.3 Velopack full package inspected from the manual handoff
  pipeline contains the application MIT license, Microsoft WebView2 license and
  notice, .NET apphost license and notices, Velopack license/tool-vendor notices,
  xterm licenses, jsdiff, QR generator and historical Lucide/Feather notices.
- DSH's 96 non-development lockfile entries match all 96 entries in its license
  manifest, with existing notice files. Their declared licenses are MIT, ISC,
  BSD-2-Clause and BSD-3-Clause. This check concerns the bundled bridge, not the
  separate DSH application's complete dependency tree.
- The Android client includes ZXing core 3.5.3 in DEX. Its complete upstream
  license was already present. The APK now also includes the application's MIT
  license, an Android-only inventory and the Material Icons Apache-2.0 license.
  `android/verify-licenses.ps1` verifies required assets and compares their
  contents against the signed APK. It fails rather than silently omitting them.
- No TTF, OTF, WOFF or WOFF2 files are tracked. System fonts are referenced,
  not redistributed.

## Image/icon provenance

- `public/icon.svg` defines the project's aperture-and-dot mark.
  `desktop/build-icon.ps1` generates the Windows ICO from the same geometric
  construction. This is not an imported OpenAI logo. No independent trademark
  clearance is implied.
- `public/icons.js` declares original geometry. Historical Lucide/Feather
  notices remain retained; the declaration is not proof of independent creation
  for every path in the project's history.
- Android icons entered with contribution `e1b6c9a`. The adaptive launcher XML
  reproduces the aperture-and-dot mark. Raster launchers were contributed with
  that change; a separate reproducible raster-generation record was not found.
- Android `ic_arrow_back`, `ic_refresh`, `ic_paste`, and `ic_settings` derive
  from Google Material Icons' 24px `arrow_back`, `refresh`, `content_paste` and
  `settings` SVG paths. The first two match command geometry after separator and
  number normalization; the latter two have local path syntax/geometry changes.
  Sources were compared at revision
  `10ecc14790612ca8fd164e3f4ffe9c16fc50d5b7` of
  <https://github.com/google/material-design-icons>. XML format and theme colors
  are local adaptations. The per-file comments and APK notices record this.
- Documentation screenshots are not runtime assets. This audit does not establish
  rights to any third-party content visible inside screenshots; review them when
  replacing/publishing promotional material.

## Fixed Velopack native updater: remaining scope

The fixed source is
<https://github.com/velopack/velopack/tree/1.3.39-g8d2844f>.
Its top-level license is MIT. Its `src/bins/Cargo.toml` and
`src/lib-rust/Cargo.toml` show that setup/update binaries compile Rust/native
dependencies, including zip, zstd, image, Windows bindings, and others.
The accompanying `Cargo.lock` is a whole-workspace lockfile, not a precise
Windows shipping-binary inventory.

The `vpk` tool's vendor notice file mostly describes bundled build tools such as
signtool, zstd CLI and platform packaging tools. It must not be treated as a full
license inventory of the code statically compiled into `Update.exe`/Setup.
This audit has not derived the target/feature-resolved transitive dependency
graph or collected every corresponding copyright notice for those binaries.
Before claiming a complete third-party clearance, obtain an upstream
version-specific notice/SBOM or reproduce that graph and retain the necessary
license texts/notices. A build-only tool entry does not mean that tool is shipped;
a dual-license entry does not by itself relicense this application under GPL.

## Separately downloaded Codex

The optional private tool installation uses the official unmodified
`@openai/codex` 0.169.0 Windows platform package, not a new bundled Codex engine.
The exact upstream root files are preserved under `licenses/codex-0.169.0/`:

- <https://raw.githubusercontent.com/openai/codex/rust-v0.169.0/LICENSE>
- <https://raw.githubusercontent.com/openai/codex/rust-v0.169.0/NOTICE>

The platform archive's native voice directory contains separate LGPL-2.1 and
other library licenses, `NOTICE.md`, source/version manifests and a Microsoft
runtime notice. Preserve that complete directory, including `sources.json`,
`manifest.json` and `windows-crt.json`; do not claim the whole archive is Apache-2.0.
Downloading the original upstream package is distinct from republishing those
binaries in our release. Any future repackaging must reassess corresponding
source availability and Microsoft redistribution terms instead of assuming
the project's MIT license supplies those rights.

## Supplemental fixed-native notices (2026-11-14)

The Windows x64 fixed vendor Update/Setup/stub binaries have exact SHA256 and
positive embedded crate-source-path evidence in
`licenses/velopack-native-1.3.39-g8d2844f/binary-evidence.json`.
Notices for 92 positively identified crates, nested zstd code and the basic
Rust standard-library licenses are retained with source provenance. Missing
crate-archive notices were fetched at their `.cargo_vcs_info.json` revision.
For fs_at, the exact Apache-2.0 manifest declaration and canonical Apache text
are retained; no copyright notice was fabricated.

The rustc source commit embedded in all three binaries matches the official
Rust std 1.97.1 Windows x64 archive's git-commit-hash. The archive SHA256 is
05f356609926e663a81e9697077214236514b2f9ff7a36e63b0070f43f073f66.

Packaging rejects changed pinned vendor hashes and missing/changed notice files,
and verifies that notices survive full-package, portable and Setup embedding.
This is an evidence-backed supplemental subset, NOT an exhaustive native SBOM.
No source-path string does not prove a crate absent. Exact target/feature
resolution, generated detailed Rust std third-party notices and static CRT
terms remain to be reconciled. Neither the Windows nor available cloud
environment had Cargo; no toolchain was installed for this audit.

## Collected distribution notices (Windows snapshot, 2026-11-14)

The new packaging layout is **two primary documents**, `LICENSE` and
`THIRD-PARTY-NOTICES.txt`, plus **one self-contained bridge notice document** at
`app/components/dsh-bridge/THIRD-PARTY-NOTICES.txt`. The bridge remains independently
verifiable and usable; it does not resolve arbitrary parent paths to borrow the
application's notice file. Its `licenses/manifest.json` is technical metadata,
not another set of loose license texts. Source-tree license originals are kept.

The text container is readable UTF-8, not an opaque ZIP. Its index maps every
retained original path to exact bytes, byte length and SHA256. Only byte-identical
texts share storage. Different copyright owners or modified notice text are never
merged by license label. Original CRLF/BOM/text content is retained. Both Python
and JavaScript readers verify the canonical representation and reject changed,
missing, ambiguous or unsafe records. Original source notice documents can mention
a broader source dependency tree; the current distribution inventory below, not
those historical source lists, determines what code this package contains.

### Actual bundled JavaScript, rather than the complete lockfile

The builder derives package ownership from esbuild output inputs with positive
`bytesInOutput`, plus the physically copied `yaml` runtime package. Every owner
must resolve to the exact locked package/version. The output manifest records
`distributedPackages`; its license manifest selects only those entries from the
retained source license inventory. Source fingerprints still cover all original
license inputs and the lockfile. Root-level duplicate bridge notices are selected
against this independently verified bridge, not deleted by filename guesswork.

This captured WSL integration snapshot emitted 13 packages: @hono/node-server,
@modelcontextprotocol/sdk, ajv, ajv-formats, content-type, fast-deep-equal, fast-uri,
hono, json-schema-traverse, ws, yaml, zod and zod-to-json-schema. The 96 source-lock
entries remain provenance, not a claim that all 96 are shipped. No external DSH
application, independently downloaded Codex platform archive, Node installer,
.NET runtime or WebView2 runtime dependency tree is newly copied into this list.
The exact apphost/WebView2 SDK notices and bundled code's own notices remain.

### Verified results and limits

- Fresh desktop, opt-in host and worker builds passed for this independent
  v0.4.5 + WSL-source snapshot. The pinned native Update/Setup/stub hash gate ran.
- Main staged legal inputs: 306 files / 1,331,319 bytes -> two files / 715,207
  bytes, containing 222 selected source records. Eighty-three non-emitted bridge
  dependency notices remain in source but are not repeated in this distribution.
- The self-contained bridge has 210 files total; all selected notices are in one
  readable text. Both source-aware Python and runtime JavaScript validators pass.
- Full nupkg, portable ZIP, vendor Setup embedding and new-install wrapper build
  passed. All 389 staged files match the extracted portable simulation. No Setup
  or installed-mode upgrade was executed; the earlier registry-access isolation
  blocker was not bypassed. No normal app UI, real Codex or model calls were used.
- Notice cross-language and corruption tests, actual bridge readiness/notice
  omission tests, and synthetic MCP/HTTP/WebSocket/stdio/provider tests passed.
  The latest coordinator tree must be rebuilt after merging; this snapshot does
  not include later concurrent callback changes.

This is a verified **layout/selection change**, not new complete native clearance.
All 195 native supplemental source records remain exactly recoverable. The fixed
Velopack workflow uses `+crt-static` for Windows, so static CRT terms require
reconciliation; Rust's dedicated `COPYRIGHT-library.html` scope is still not
replaced by the basic Rust LICENSE/COPYRIGHT files or the entire compiler notice
tree. Exact native dependency closure, detailed Rust std third-party notices and
static CRT redistribution evidence remain open. Do not describe consolidation as
having solved those pre-existing audit gaps.
