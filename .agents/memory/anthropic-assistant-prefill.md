---
name: Anthropic assistant prefill rejection
description: Anthropic rejects API calls where the last message in the conversation is role:"assistant" with HTTP 400 "does not support assistant message prefill".
---

## Rule
Before calling the Anthropic API in the agentic loop, ensure the conversation always ends with a user turn.

**Why:** The agent loop appends `conversationHistory` (past turns) to the messages array. If history ends with an assistant turn, Anthropic returns HTTP 400. OpenAI allows this; Anthropic does not.

**How to apply:** After appending conversationHistory in agent-loop.ts, check if the last message is `role:"assistant"`. If so, insert a synthetic user bridge message (e.g. "Continue.") before calling the API.
