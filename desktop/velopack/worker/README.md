# Standalone apply worker

This worker is a fail-closed apply handoff, not a background updater. Build with `dotnet build desktop/velopack/worker/UpdateWorker.csproj -c Release`. Stage the complete runtime output outside the installed root. Native integration must exclude `velopack/worker/**/*.cs` from the GUI's default compilation.

The native caller must first verify explicit user intent and drain tasks safely, then write a create-new receipt under `%LOCALAPPDATA%/CodexLight/Updates/Apply/<32 lowercase hex GUID>.json`. Exact JSON fields: `root`, `package`, `hash` (lowercase SHA256), `parentPid`, `parentStartUtc` (UTC DateTime `O` format), `packageId` (`CodexLightDesktop`). No version/resultPath/extra fields. Launch the worker hidden with exactly `--receipt <absolute file>`, then exit normally. The caller must not accept these fields unchecked from browser content. The worker opens the receipt read-only without write sharing. This is not a defense against a malicious program already running as the same user.

The worker shows a progress window while it waits for the desktop to exit, installs the package, and verifies the installed version and payload bytes. It writes `exitCode`, `message`, and `finishedUtc` to a new `<receipt>.result.json`. A missing receipt or verification failure cannot establish success. The worker releases the installation locks before showing the final result. On verified success the user can select **立即打开应用** to launch the installed executable, or close the updater. A launch failure leaves the completed installation status intact and allows another click.

Worker waits up to five minutes for the exact parent PID/start time, refuses PID reuse, then holds the same current-user/current-session Desktop mutex as current GUI code and both root/current InstallMaintenance locks. These locks must also be respected by all GUI/maintenance launch paths. They are not global across Windows sessions. Parent must not label them global until GUI and worker both change consistently.

After acquiring locks, current installation metadata and package are freshly validated. If another updater changed the installed version while waiting, the old/equal package is refused. Package file remains held against writes/replacement through updater exit. The installed Update.exe is invoked hidden, without shell, with `--silent --rootDir <root> apply --package <path> --norestart`.

The occupancy guard registers files under the installed current directory and root-level launchers with Windows Restart Manager. It asks which processes hold those resources, not whether every unrelated operating-system process is inspectable. Any holder, registry/API error, unresolved/repeatedly changing query, missing installation, or reparse path blocks apply. No RmShutdown, RmRestart, forced termination, elevation, or permission change is performed. The desktop and maintenance mutexes remain held through updater exit. There remains a check/start race for uncooperative external launchers that ignore these locks; this is not an absolute task-protection guarantee.

Validation: worker builds with zero warnings/errors; 15 pure receipt/path tests pass; linked native validator has its own fixture tests. No real Update.exe, installation, application task, or user data has been exercised by these tests. Real isolated lifecycle tests remain required before release.

## Revised readiness protocol

Worker must observe the exact live parent before readiness. It validates and holds the package, then atomically writes `<receipt>.ready.json` containing exactly `ready:true,parentPid,parentStartUtc,packageId,hash`. Host must validate this and worker liveness before initiating graceful drain. Host writes `<receipt>.commit` only after every owned task has drained, immediately before its own exit. A `<receipt>.cancel` always wins before launch. Parent exiting without commit, reused parent PID, or expiry after five minutes is failure. Sidecars are fixed derived paths; arbitrary result paths are not accepted. Both host and worker must ensure cancellation on timeout/failure. A cancellation after updater launch cannot undo an update and is not represented as rollback.

2026-11-15: 24 pure policy checks pass. Native idle/held/released fixture probing in the Codex execution context returned Restart Manager error 29 (registry write fault), including an approved normal-user attempt. No installation or updater was invoked. Native fixture and real isolated upgrade validation remain required before using this candidate in a release.

## External recovery bootstrap (not wired into public installer yet)

`BootstrapWorker.csproj` builds the corrected worker independently of the installed
worker. A repair bundle must publish it with **build-pinned** `RepairVersion` and
`RepairSha256` values matching the final full nupkg. Missing publish pins are an
error; invalid/mismatched pins are also rejected at runtime. Do not use mutable
latest metadata as the repair pin. This is not a security boundary against a
malicious same-user process.

The public router must verify and stage the helper outside the program root,
verify/stage the pinned nupkg in the existing version/hash cache convention, and
create the existing strict ApplyReceipt under Updates/Apply. The router is the
handoff parent, must wait for matching readiness, and only write commit after
explicit confirmation and after the application is closed. Then it exits. The
helper never kills a task, writes user configuration, or copies itself over the
installed old helper. Cancellation before commit aborts. A timeout or occupancy
API failure aborts without calling Update.exe.

Repair is limited to the existing per-user LocalAppData/CodexLightDesktop root.
The original metadata is reread after locks; the full package must be newer,
correct package ID/architecture, and match the embedded pin. After a successful
vendor updater exit, every lib/app payload file is compared against the held
verified archive, and installed version/root must match. Velopack-generated
root-level Squirrel.exe and *_ExecutionStub.exe are verified at their deployed
Update.exe and launcher paths, not incorrectly required beneath current/. A mismatch is failure,
not success or a speculative automatic rollback. Failure evidence remains.

The ordinary user-context Restart Manager fixture still needs to pass before
this can be released: executor-context RmStartSession error 29 is not evidence
that it fails in an ordinary interactive session. No recovery install, updater
execution, or user-data modification has been performed by these tests. Existing
app/maintenance mutexes constrain cooperative relaunch; uncooperative external
launchers remain a race and vendor apply can still fail, which is reported.
