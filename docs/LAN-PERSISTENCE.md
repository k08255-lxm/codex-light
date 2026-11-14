# LAN persistence

Windows desktop LAN access is initially off. An explicit enable action remembers the user's desired state; no second “remember” checkbox is required. Shutdown stops the listener without changing that preference. Explicit disable clears the preference and revokes the capability. Existing temporary sessions are not silently migrated.

The application restores only the previously selected RFC1918 IPv4 address, exact port, and Windows trusted network identity. It never binds a wildcard address, chooses a different network or port silently, modifies firewall rules, creates a tunnel, or launches the app at Windows login. An unavailable address, changed/unverifiable network, or occupied port leaves the saved intent enabled but the listener stopped. Settings shows the distinction and offers retry. To choose a new address or replace a pairing, turn access off, then enable on the new trusted network and pair again.

The stable bearer and network settings are encrypted with Windows DPAPI CurrentUser, with an application-specific entropy string, under the desktop state directory. There is no plaintext fallback. Copying the file to another Windows user/machine is not supported. Rotation persists a new bearer and closes existing streams. A storage failure is reported, never treated as successful revocation; if saving revocation fails, users must successfully disable before relying on old pairing being permanently revoked after restart.

The running listener rechecks its selected address and trusted network identity every 15 seconds. This is a detection interval, not a guarantee of immediate isolation during a network transition. HTTP remains unencrypted: credentials and traffic are observable to a network adversary, so this mode is only for a trusted LAN. The Android client must not scan alternate addresses or send saved credentials to redirects. Network/address changes require explicit re-pairing.

Official Codex remote control is separate and unchanged. Browser-only LAN access remains supported. The QR ticket remains single-use and short-lived; only the redeemed bearer is stable.

## Verification

`node --test test/lan-persistence.test.mjs test/lan-access.test.mjs test/lan-server.test.mjs test/qr-pairing.test.mjs`

The persistence fixture binds an isolated loopback listener while injecting a synthetic LAN interface. On Windows it uses real DPAPI encryption and verifies restarting the listener preserves the port and authenticates with the same bearer, while explicit disable clears restoration. This is not a physical Android device test and does not prove real network migration behavior.
