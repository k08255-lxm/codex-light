# Uploaded image history

Uploads remain temporary instance-owned staging files. Before sending them, the
backend converts owned attachment IDs to official app-server input
`{ type: "image", url: "data:image/png;base64,..." }` (also JPEG/WebP/GIF).
No second permanent image cache is created. Codex receives inline bytes instead
of a path that will disappear when Light exits. Repeated resolves of the same ID
use identical in-memory data, preserving request identity on safe retry.

Sources: OpenAI Codex app-server-protocol `v2/turn.rs`, `UserInput::Image`, flattened
`ImageReference::Inline { url }`, and conversion to CoreImageReference::Inline:
https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/turn.rs

This is protocol/source compatibility, not a claim that a real paid model turn
or official desktop end-to-end rendering has been tested. The unified 6 MiB
per-file upload/selection limit matches the preview decoder; total image bytes per message are capped at 20 MiB to
stay below Light's 32 MiB serialized RPC response budget after base64 expansion.

For legacy localImage cards, an already-bound thread's trusted rollout path can
supply image bytes directly. Only configured Codex sessions/archived_sessions
roots, matching filename/thread ID and session_meta ID are eligible. Only an
exact path label immediately followed by inline input_image in a user
response_item is accepted. This uses bounded streaming reads and existing image
format/dimension validation. Nothing is rewritten, recovered, or cached on disk.
If no verified inline match is available, existing safe file preview still runs.

Missing history bytes cannot be invented. The earlier manual recovery copies and
backup are separate, protected user data; this change neither removes nor rewrites
them. No image cleanup is enabled by this patch.
