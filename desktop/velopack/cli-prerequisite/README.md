# Private Codex CLI prerequisite

The net48 library is UI-free. `CodexLight.Prerequisites.CliPrerequisite.Detect()`
returns Ready/Missing/Uncertain. Existing known npm and official desktop native
CLI candidates are tried first with `--version` only. Readable semantic versions
prove only that the CLI can run, not support for every app-server feature. Unknown
or failed candidates are not silently overwritten. No login/model invocation is
part of detection or installation.

The wrapper must obtain explicit consent before `InstallAsync(progress, token)`.
It downloads only the fixed official npm `@openai/codex@0.169.0-win32-x64` tarball,
187,002,407 bytes, pinned SHA512. No npm scripts or command wrapper are executed.
The complete 47-file package expands to 515,178,111 bytes, including its original
voice DLLs, licenses, NOTICE and metadata. The matching upstream Codex LICENSE
and NOTICE are additionally embedded and installed in `codex-light-notices`.
This does not classify all bundled dependencies as Apache licensed.

Installation targets `%LOCALAPPDATA%\CodexLightTools\codex\0.169.0`; it never
changes PATH, global npm, Codex configuration or account data. A create-new stage
is bounded by archive/expanded/file-count limits, blocks links, traversal, ADS,
reserved filenames and duplicate entries, checks the native executable SHA256
and version, then renames the completed payload and publishes a create-new
current.json receipt. Existing version directories or unrecognized receipts are
not overwritten. Partial/uncertain failures are retained and block destructive
retry; manual inspection may be required. No rollback of an existing installation
is claimed. A full old/current.json replacement workflow is not implemented.

Return codes: 0 success, 1602 canceled/timed out, 1603 verification or installation
failure. The fixed x64 package requires native x64 Windows (GetNativeSystemInfo).
The filesystem must be local and non-reparse. A minimum of archive + expanded +
128 MiB available disk space is checked; the wrapper should show these sizes.

Tests cover hostile tar names/types/duplicates/checksum/budgets/cancellation and
an actual full extraction/hash check of the official archive in a disposable
fixture. They do not install to the user's ToolsRoot or start the downloaded CLI.
The backend separately validates current.json, pinned executable hash, then
`--version` before using the private fallback. System candidates stay preferred.
