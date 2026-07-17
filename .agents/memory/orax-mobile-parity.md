---
name: ORAX mobile parity Codex features
description: Mobile orax.tsx parity patterns and type gotchas.
---

- mobile orax.tsx needs activeTaskIdRef + switchedTasks useEffect, a submitTaskMessage taskId guard, and createTaskWithThread(startThread:true).
- OraxTaskArtifact uses `.type`, not `.artifactType`.
- Mobile ButtonVariant has no "outline" — use "secondary".

**How to apply:** when porting website ORAX features to mobile, check these three first; they each caused typecheck or runtime breaks.
