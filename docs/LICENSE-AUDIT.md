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
