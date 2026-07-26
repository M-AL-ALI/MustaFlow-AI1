---
name: Builder preview Fly live-container smoke test
description: Deferred acceptance test — Fly-enabled live-container path for the AI Builder preview fix; requires a valid FLY_API_TOKEN in the environment.
---

## Deferred item

After the AI Builder preview fix landed at `646bb7f3`, the full automated gate passed (22/22 preview-architecture tests, both typechecks clean) but one acceptance scenario could not be exercised because `FLY_API_TOKEN` is absent in the Replit dev environment:

**Fly-enabled live-container smoke test** — with a real `FLY_API_TOKEN` set, verify that:
1. An agentic React/Vite project with a live Fly container gets a real container preview (not the DB fallback).
2. The stale-containerId path clears the old ID (logs "Cleared stale preview container ...") and recovers correctly.
3. `isContainerLayerConfigured()` returns `true` and the proxy route is taken through `handleLivePreviewHttp`.

**Why deferred:** `FLY_API_TOKEN` is not available in the Replit dev workspace. This is a runtime credential gap, not a code gap.

**How to apply:** Run this manually in any environment with `FLY_API_TOKEN`, `FLY_APP_NAME`, and `FLY_ORG_SLUG` set, against a real agentic project that has previously been built.
