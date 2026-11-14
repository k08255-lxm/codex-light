# Local-path link regression checks

`dotnet run --project test/native-local-links/Tests.csproj -c Release` validates local Windows path/file URI normalization, spaces/Chinese, unsafe protocols/UNC/device paths/ADS/traversal, exact native origin, fixture existence, and Explorer argument construction without launching Explorer or opening documents.

`node --test test/native-local-links.test.mjs test/markdown.test.mjs` exercises the injected trusted-click/top-frame bridge and existing Markdown controls.

Desktop behavior: clicking a Markdown file control asks native confirmation, then opens the directory or selects the file in Explorer. It deliberately does not execute/open arbitrary model-supplied files through their default associations. Line references are displayed by Markdown but Explorer cannot navigate to a source line. Relative references require the renderer's conversation working directory; unresolved relative paths fail visibly. Browser/LAN/Android retain their existing copy behavior; there is no network endpoint to open host files.

The native bridge accepts only the current app's exact loopback port, top-level `/` document, two-field message, local fixed/removable drive and existing paths without reparse ancestors. Path validation repeats after confirmation. The native confirmation remains the security boundary if same-origin page code is compromised; injected JavaScript's `isTrusted` check alone is not treated as authentication. Tests do not prove live WebView2/Explorer interaction; no foreground UI smoke test was performed.
