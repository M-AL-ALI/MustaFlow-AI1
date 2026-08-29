---
name: Detached gate wrapper
description: How to keep long-running validation receipts alive in the Replit shell runner
---

For long-running validation, let the `run_in_background` shell task execute the timeout-wrapped command directly. Do not add a second `(...) &` background layer inside that command.

**Why:** The outer shell task can finish and its child may be reaped before the child creates its log or terminal receipt, producing a false-looking successful launcher result with no gate evidence.

**How to apply:** Use one foreground command inside the background task, redirect its output to `/tmp`, emit the terminal receipt only after it exits, and monitor the outer task.