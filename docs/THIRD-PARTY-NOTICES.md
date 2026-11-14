# Third-party notices

The project MIT license covers Codex Light's own code. Third-party components
retain their respective copyright, license and distribution terms.

| Component | Version / scope | Use and retained notices |
| --- | --- | --- |
| [xterm.js](https://github.com/xtermjs/xterm.js) | 6.0.0, vendored | Terminal renderer; [MIT license](../licenses/xterm/LICENSE) |
| [@xterm/addon-fit](https://github.com/xtermjs/xterm.js/tree/f447274f430fd22513f6adbf9862d19524471c04/addons/addon-fit) | 0.11.0, vendored | Terminal resizing; [MIT license](../licenses/xterm/addon-fit-LICENSE) |
| [jsdiff](https://github.com/kpdecker/jsdiff) | 9.0.0, minimal vendored ESM files | Applied DSH edit fragment statistics; [BSD license](../public/vendor/jsdiff/LICENSE), retained under `app/public/vendor/jsdiff` in the Windows payload |
| [Microsoft WebView2 SDK](https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.4314.35) | 1.0.4314.35, restored and redistributed | Desktop web control and native loader; exact package LICENSE.txt and NOTICE.txt copied into the installed licenses directory |
| [.NET](https://github.com/dotnet/runtime) / [Windows Forms](https://github.com/dotnet/winforms) | .NET 10 target, exact apphost version recorded at build | Desktop framework and application host; exact apphost LICENSE.TXT and THIRD-PARTY-NOTICES.TXT accompany the payload |
| [WiX Toolset](https://github.com/wixtoolset/wix) | 6.0.2, build tool only | Builds the internal MSI; see the build-tool terms below |
| [Lucide](https://github.com/lucide-icons/lucide) / Feather | Earlier icon geometry | Historical ISC/MIT notices retained below |
| [dsh-subagent-mcp](https://github.com/dqtz5vpvj9-create/dsh-subagent-mcp) | 0.8.0 upstream; bundled integration 0.8.0-light.1 | MIT bridge source and DeepSeek MIT desktop overlay; exact dependency versions and notices retained in the component |

`scripts/vendor-xterm.py` records the exact upstream tarball SHA-256 hashes and
reproduces the vendored files. The local xterm.js modification adds a Content
Security Policy nonce to three dynamically created style elements; the upstream
copyright/license is retained. The fit addon and stylesheet are copied as-is.
Both published packages identify upstream commit
`f447274f430fd22513f6adbf9862d19524471c04` in their npm metadata.

The Windows payload contains `licenses/xterm/LICENSE`,
`licenses/xterm/addon-fit-LICENSE`, `licenses/THIRD-PARTY-NOTICES.md`, and
the resolved Microsoft package notices. The default framework-dependent build
also includes `licenses/DotNet-AppHost-LICENSE.txt`,
`licenses/DotNet-AppHost-THIRD-PARTY-NOTICES.txt`,
`licenses/WebView2-LICENSE.txt` and `licenses/WebView2-NOTICE.txt`.
Packaging fails when required notices are missing. `licenses/VERSIONS.txt`
records the build's actual runtime packages.

The default payload also contains `app/components/dsh-bridge`, including its
MIT `LICENSE`, `assets/DeepSeek-MIT-LICENSE`, `THIRD-PARTY-NOTICES.md`, locked
dependencies and `licenses/manifest.json`. Matching source lives at
`components/dsh-bridge` in this repository. Additional copies of the bridge and
DeepSeek notices are installed at `licenses/dsh-bridge/Bridge-MIT-LICENSE.txt`
and `licenses/dsh-bridge/DeepSeek-MIT-LICENSE.txt`. The dependency inventory
records each exact version, license and retained notice path.

## Runtime and build-tool boundaries

Node.js, .NET Desktop Runtime and WebView2 Runtime are prerequisite installations
managed by their official installers; their binaries are not vendored into the
source repository. Their own licenses apply. The application uses installed
system fonts and does not redistribute Microsoft or Noto font files.

The official Codex engine and the DSH application are external programs accessed
through their protocols; their application binaries are not bundled. The small
DSH compatibility overlay is distributed under its retained MIT license as part
of the bundled bridge. Interface references to Codex, Claude and CC Switch do not imply
affiliation or permission to redistribute their branding or source code.

WiX 6.0.2's official binary package includes OSMF EULA v1.0 in addition to its
source license. That version distinguishes revenue-generating use from exempt
non-revenue-generating use. Build users must review the exact tool's terms;
this project's MIT license does not waive them. Later WiX versions have different
OSMF terms, so do not assume their thresholds apply to 6.0.2. See the
[official version-specific OSMF guidance](https://docs.firegiant.com/wix/osmf/)
and the [WiX 6.0.2 EULA](https://github.com/wixtoolset/wix/blob/v6.0.2/OSMFEULA.txt).
The WiX executable itself is not shipped with Codex Light.

UI Skills and Playwright are development/review tools, not runtime dependencies.
Local skill instructions, internal work plans and review artifacts are excluded
from the repository and release. Source borrowed from a development tool, if
introduced later, still requires its own provenance and license review.

## Icons

The interface icons in `public/icons.js` and the application mark in
`public/icon.svg` are original geometry drawn for Codex Light. They no longer
reuse paths from any icon package.

Earlier versions of this application vendored outline geometry from
`lucide-static@1.72.0` (https://github.com/lucide-icons/lucide, https://lucide.dev).
The upstream license texts are retained below for that distributed history.

### ISC License

```
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### Feather-derived icons

Lucide identifies the following icons as derived from the Feather project.

```
airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle,
arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left,
arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right,
arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right,
chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle,
clipboard, clock, code, columns, command, compass, corner-down-left,
corner-down-right, corner-left-down, corner-left-up, corner-right-down,
corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle,
divide-square, dollar-sign, download, external-link, feather, frown, hash,
headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader,
lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle,
minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music,
navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square,
plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone,
smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv,
type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out
```

The MIT License (MIT) (for the icons listed above)

```
Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## QR pairing

- qrcode-generator 1.4.4, Copyright (c) 2009 Kazuhiko Arase, MIT. Vendored browser module; see `public/vendor/QRCODE-LICENSE.txt`.
- ZXing core 3.5.3, Apache-2.0. Vendored Android decoder, hash pinned in `android/build.ps1`; see `android/libs/ZXING-LICENSE.txt` and APK `assets/licenses/ZXING-LICENSE.txt`.
