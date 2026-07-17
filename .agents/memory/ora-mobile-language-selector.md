---
name: Ora mobile language selector
description: Reply-language state is separate from voice language on mobile.
---

Language state (auto/en/ar/es/fr) is separate from voiceLang. It is sent as `chatReq.language` only when non-auto. The picker lives in the PlusMenu "Reply language" section.

**How to apply:** don't merge reply language with voice settings; omit the field entirely for auto.
