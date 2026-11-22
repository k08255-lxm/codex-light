# LAN persistence

Windows desktop LAN access is initially off. Selecting all current private IPv4 adapters opens a temporary session. Choosing a single trusted adapter supports a saved pairing. Shutdown stops the listener and retains a saved preference. Explicit disable clears the preference and revokes the capability.

The application restores only the previously selected RFC1918 IPv4 address, exact port, and Windows trusted network identity. It never binds a wildcard address, chooses a different network or port silently, modifies firewall rules, creates a tunnel, or launches the app at Windows login. An unavailable address, changed/unverifiable network, or occupied port leaves the saved intent enabled but the listener stopped. Settings shows the distinction and offers retry. To choose a new address or replace a pairing, turn access off, then enable on the new trusted network and pair again.

The stable bearer and network settings are encrypted with Windows DPAPI CurrentUser, with an application-specific entropy string, under the desktop state directory. There is no plaintext fallback. Copying the file to another Windows user/machine is not supported. Rotation persists a new bearer and closes existing streams. A storage failure is reported, never treated as successful revocation; if saving revocation fails, users must successfully disable before relying on old pairing being permanently revoked after restart.

The saved listener rechecks its selected address and trusted network identity every 15 seconds. In multi-adapter mode, a single port is bound separately to each approved address. Removing or changing a bound address or its network identity closes the session. Connecting another adapter does not automatically expose it. Android checks a saved LAN pairing with a fresh HMAC challenge before sending its bearer to a private address during automatic reconnection. Trusted LANs are still required because LAN HTTP carries subsequent traffic in cleartext. An unreachable LAN can fall back to a separately paired HTTPS route for the same computer.

Official Codex remote control is separate and unchanged. Browser-only LAN access remains supported. The QR ticket remains single-use and short-lived; only the redeemed bearer is stable.

## Verification

`node --test test/lan-persistence.test.mjs test/lan-access.test.mjs test/lan-server.test.mjs test/qr-pairing.test.mjs`

The persistence fixture binds an isolated loopback listener while injecting a synthetic LAN interface. On Windows it uses real DPAPI encryption and verifies restarting the listener preserves the port and authenticates with the same bearer, while explicit disable clears restoration. This is not a physical Android device test and does not prove real network migration behavior.
