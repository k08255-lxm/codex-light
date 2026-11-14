# QR pairing and update checks (0.4.3)

## Pairing

Desktop Settings > LAN access retains its default-off opt-in listener and existing manual bearer link. Generate a pairing QR after enabling LAN. QR generation is local (MIT qrcode-generator); Android scanning is local (Apache-2.0 ZXing), requests CAMERA only on entry, and offers manual paste when camera access is unavailable.

The QR contains a random 256-bit single-use ticket, valid for two minutes, not the persistent LAN bearer. Regeneration, cancellation, rotation, disable and shutdown revoke it. A concurrent exchange has exactly one winner. The browser clears the ticket fragment before exchanging it. Only the LAN listener accepts redemption; Host/Origin checks still apply. LAN credentials cannot manage the desktop listener or updater. Browser-only LAN remote access is retained, independently of the Android APK. This is not an implementation of OpenAI's official remote-control service.

Transport is still HTTP on a trusted private IPv4 LAN. QR screenshots are temporary credentials. The feature does not claim end-to-end encryption, NAT traversal, or public-Internet security; it does not alter firewall rules.

## Updates

Desktop local access checks stable GitHub Releases shortly after startup and every six hours, notifying once per version per window. Existing About-page checks and explicit download/install remain available. Remote browsers do not manage desktop updates.

Android 0.4.2 lacks this native checker; its first upgrade must be manual and in-place. Android 0.4.3 checks the same repository on foreground entry and periodically while foregrounded. A successful check has a six-hour cooldown; failures retry after ten minutes. Only a stable release containing the exact versioned APK asset on the expected repository is eligible. Prompts are deduplicated per version. Viewing an update opens the project release page; it does not install silently. Android itself verifies package identity, increasing versionCode and matching signing certificate on install.

The APK retains the existing 0.4.2 certificate for upgrade compatibility. Its certificate subject is Android Debug; this is not a newly provisioned private production signing identity. Do not rotate it casually or instruct existing users to uninstall to overcome signature errors.

## Verification and device compatibility

Automated coverage includes single-use pairing, expiry, revocation, concurrent redemption, origin checks, browser fragment clearing, remote-management restrictions and update retry/deduplication. Camera permission behavior and package upgrades should also be checked on supported physical Android devices. Windows display scaling and installed prerequisites can vary by device.
