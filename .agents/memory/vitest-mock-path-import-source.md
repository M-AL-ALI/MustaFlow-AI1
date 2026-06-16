---
name: Vitest mock path must match the importer's resolved module
description: vi.mock path must resolve to the same canonical file that the route-under-test imports — not a related file with a similar name.
---

## Rule

`vi.mock("../path/to/module")` is resolved relative to the TEST file, not the source file. Vitest matches by canonical (absolute) path. If a route does `await import("../../lib/ai-providers")` and the test is in `src/routes/public-ai/__tests__/`, the correct mock path is `"../../../lib/ai-providers"` (3 levels up from `__tests__/`).

**Why:** A similar file `ai-provider-config.ts` existed nearby. Mocking it (wrong file) left real API calls firing inside the test — producing real-network latency, flaky results, and 4 failing tests even though the mock appeared to be set up correctly.

**How to apply:** Before writing a `vi.mock` for a dynamic import inside a route, trace the actual import string in the source file, resolve it relative to the TEST file's location, and double-check with a quick `grep -n "import.*ai-providers"` on the route file.
