---
name: Ora chat/upload API contract
description: Wire contract quirks for /api/public-ai chat and upload endpoints.
---

- Chat requires `message` (required, the current turn) PLUS `messages` (history).
- The response field is `reply`, not `content`.
- File and image-analysis requests require a UUID ref obtained from /upload first — inline data is rejected.
- Session-create is rate-limited to 10/day.

**How to apply:** any new client (web, mobile, tests, curl) must follow this shape; a missing `message` or reading `content` fails silently or 400s.
