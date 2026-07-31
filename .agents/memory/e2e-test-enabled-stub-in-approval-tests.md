---
name: E2E_TEST_ENABLED stub in approval/prompt-gate tests
description: Tests for agent-loop approval gates that call createPrompt silently skip when E2E_TEST_ENABLED is set in the Vitest environment — the auto-approve path fires before the gate.
---

# E2E_TEST_ENABLED must be cleared in approval-gate unit tests

## The rule
Any test that asserts `createPrompt` is called (i.e. a human-confirmation gate fired) must stub out `E2E_TEST_ENABLED` to `""` in `beforeEach`:

```ts
beforeEach(() => {
  vi.stubEnv("E2E_TEST_ENABLED", "");
});
```

**Why:** `isE2EAutoApproveEnabled()` reads `process.env.E2E_TEST_ENABLED`. Vitest inherits the process environment, and the Replit workspace has `E2E_TEST_ENABLED=true` set globally. When that flag is truthy, the agent-loop auto-approves tool calls (including destructive ones like `npm run deploy`) without ever reaching `createPrompt`. The test then sees `createPrompt` called 0 times and fails.

**How to apply:** Any `*.test.ts` that mounts agent-loop logic and checks whether `createPrompt` / an approval gate fired — add the `vi.stubEnv` stub in `beforeEach`. Also convert any `vi.mock('./agent-prompts', ...)` factory to `async` (per `vitest-dynamic-import-mock-gap` note) so the dynamic-import route handler is intercepted before the test runs.
