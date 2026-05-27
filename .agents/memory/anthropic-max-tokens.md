---
name: Anthropic max_tokens truncation
description: callAnthropic in ai-providers.ts had a hardcoded 8192 default — large file writes via the agentic loop silently produced empty files.
---

## Rule
Always set `max_tokens` high enough for agentic tool calls. The current value is 32000.

**Why:** When stop_reason="max_tokens", `block.input` comes back as `{}`. `parseArgs()` catches JSON errors and returns `{}`, so `args.content` defaults to `""`. The file is written as empty with no error surfaced. This caused "Refined 0 files" despite the loop running normally.

**How to apply:** If write_file calls consistently produce empty files or "0 changed files" despite the model claiming to write large content, check for max_tokens truncation in the Anthropic adapter logs (WARN: "response truncated at max_tokens"). Increase `max_tokens` in `callAnthropic` in `artifacts/api-server/src/lib/ai-providers.ts`.
