# Update safety planner

`UpdateSafetyPlanner.Evaluate` is a pure decision function, not an installer. It accepts a trusted locally observed `UpdateSafetySnapshot` and returns a decision and required lock roots. Do not deserialize a web request directly into its evidence booleans.

The caller must inspect actual package identity/hash, canonical paths and every ancestor's reparse attributes, installed MSI ProductCode/version/UpgradeCode and source, retained recovery source, application task state and process identities. It must acquire **both** legacy and new-root maintenance leases in the returned sorted order, re-observe after acquiring them, and hold them throughout the operation. `MaintenanceLeaseHeld` means those real leases, not merely the per-current-directory application mutex.

- Stage only into a new empty independent program root. Existing application and data remain untouched.
- Active work without explicit interruption consent blocks activation. Consent only permits requesting graceful stop. Never force-kill. Observe stopped processes and idle task state before applying.
- Failed/unresolved installation or pending reboot blocks all phases.
- Retire only the exact legacy MSI identity after explicit consent and actual new-version health proof; preserve complete MSI source and all user data.
- Binary rollback requires explicit approval, a verified previous package and proved data backward compatibility. The planner never promises user-data rollback.
- Missing, inconsistent or task/process evidence older than 30 seconds blocks activation, retirement and rollback. A caller must prevent new task admission between checking idle and updater execution; this planner does not create that admission gate.

Run: `dotnet run --project desktop/velopack/safety/PlannerTests.csproj -c Release`.

54 pure cases passed. Tests perform no install, app launch, task interruption, user-data modification or migration. Windows installation, failure injection and recovery still require isolated end-to-end testing before claiming production support.
