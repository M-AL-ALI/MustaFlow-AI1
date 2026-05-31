---
name: Agentic container npm idealTree conflict
description: Background npm process in agentic Fly.io containers blocks agent pkg_install and npm run_command calls
---

## Rule

Agentic containers consistently fail all `npm install` / `pkg_install` operations with:
```
npm error Tracker "idealTree" already exists
```

## Why

The Fly.io container image used for agentic projects appears to run a background npm process on boot (likely `npm install` in the project's pre-seeded directory). When the agent's `pkg_install` or `run_command` calls npm, it conflicts with the already-running npm process.

## Impact

- Every `pkg_install` (react-router-dom, lucide-react, typescript) fails with exitCode=1
- Every `run_command npm install` fails with exitCode=1
- `node_modules/.bin/tsc` not found because npm install never completes
- Builds that need npm packages consume most of the 8-min wall-clock budget on failed installs, then time out at approval prompts

## How to apply

When investigating why agentic builds fail after the agent loop starts: check for the "idealTree" string in `tool_call` events before assuming a code bug. Next step: inspect the container Dockerfile or startup command (`fly machines list`, `fly config show`) for the conflicting npm process and remove or serialize it.

Workaround: Prompts that don't need npm packages (pure HTML/Tailwind CDN apps) proceed to file writing without hitting this issue.
