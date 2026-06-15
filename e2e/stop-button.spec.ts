/**
 * Task #753 — Stop-button cancellation: browser e2e spec
 *
 * Tests the full cancel flow by navigating to the real project workspace and
 * clicking the "Cancel build" button inside the AgentThinkingBubble.  No API
 * endpoints are called directly from the test — every cancellation assertion
 * is driven by a real UI interaction.
 *
 * Auth bypass (dev builds only):
 *   Playwright injects window.__E2E_TEST_USER__ via page.addInitScript() before
 *   any script runs.  Protected renders children immediately when that flag is
 *   set in import.meta.env.DEV builds (dead-code-eliminated in production).
 *   page.setExtraHTTPHeaders() wires x-e2e-test-user into every browser
 *   request (fetch, XHR, EventSource) so the API server resolves ownership via
 *   the E2E_TEST_ENABLED bypass in auth.ts.
 *
 * Build stub:
 *   DEV_SLOW_BUILD_DELAY_MS=30000 (set on the API server) makes the builder
 *   sleep instead of calling OpenAI, keeping the task in "building" state long
 *   enough for the test to navigate and click Cancel.
 *
 * The workspace page auto-initialises activeTaskId from the tasks query on
 * mount (didAutoInitActiveTask ref), so AgentThinkingBubble renders even after
 * a fresh page load with an in-flight task.
 *
 * Preconditions:
 *   • API server running at E2E_BASE_URL (default http://localhost:80)
 *   • E2E_TEST_ENABLED=true on the API server
 *   • DEV_SLOW_BUILD_DELAY_MS set on the API server
 *
 * Run:
 *   npx playwright test e2e/stop-button.spec.ts
 */

import { test, expect } from "@playwright/test";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:80";
const E2E_TEST_USER = "e2e-test-user";
const E2E_HEADERS = { "x-e2e-test-user": E2E_TEST_USER };

test.describe("Stop-button cancellation flow", () => {
  test("clicking the UI Cancel button transitions task to 'canceled' and SSE emits 'cancelled'", async ({
    page,
  }) => {
    // ── 0. Dev-auth bypass setup ────────────────────────────────────────────
    // addInitScript runs before any page script so Protected sees the flag
    // on the very first render.
    await page.addInitScript(() => {
      (window as unknown as Record<string, string>)["__E2E_TEST_USER__"] = "e2e-test-user";
    });
    // Injects x-e2e-test-user into every browser-initiated HTTP request
    // (navigations, fetch(), XHR) so the API auth bypass in auth.ts fires.
    await page.setExtraHTTPHeaders(E2E_HEADERS);

    // ── 1. Create project ──────────────────────────────────────────────────
    const projResp = await page.request.post(`${BASE_URL}/api/projects`, {
      headers: E2E_HEADERS,
      data: { name: "e2e-stop-test", kind: "web", builderMode: "static-legacy" },
    });
    if (!projResp.ok()) {
      throw new Error(`Create project failed ${projResp.status()}: ${await projResp.text()}`);
    }
    const project = (await projResp.json()) as { id: number };

    // ── 2. Submit a build task via API ────────────────────────────────────
    // DEV_SLOW_BUILD_DELAY_MS keeps the job sleeping in "building" state so
    // there is time to navigate and click Cancel before it completes.
    const taskResp = await page.request.post(`${BASE_URL}/api/projects/${project.id}/tasks`, {
      headers: E2E_HEADERS,
      data: {
        title: "Build a minimal todo app",
        kind: "main",
        prompt: "Build a minimal todo app",
      },
    });
    if (!taskResp.ok()) {
      throw new Error(`Create task failed ${taskResp.status()}: ${await taskResp.text()}`);
    }
    const task = (await taskResp.json()) as { id: number; status: string };

    // ── 3. Wait until the task enters "building" ──────────────────────────
    // Proves runJob() has acquired the lock and registered an AbortController
    // so the subsequent Cancel click will abort the in-flight signal.
    await expect
      .poll(
        async () => {
          const r = await page.request.get(`${BASE_URL}/api/projects/${project.id}/tasks`, {
            headers: E2E_HEADERS,
          });
          const tasks = (await r.json()) as Array<{ id: number; status: string }>;
          return tasks.find((t) => t.id === task.id)?.status;
        },
        { timeout: 20_000, intervals: [500] },
      )
      .toBe("building");

    // ── 4. Navigate to the real project workspace ─────────────────────────
    // Protected bypasses Clerk (window.__E2E_TEST_USER__ is set) so the page
    // renders without a real Clerk session.  All subsequent API calls from the
    // React app carry x-e2e-test-user via page.setExtraHTTPHeaders().
    await page.goto(`${BASE_URL}/projects/${project.id}`);

    // ── 5. Wire a fetch-based SSE listener in the page context ────────────
    // Started after navigation so it lives in the workspace document.
    // Using fetch (not EventSource) ensures x-e2e-test-user is included.
    const sseUrl = `${BASE_URL}/api/projects/${project.id}/tasks/${task.id}/events/stream`;
    await page.evaluate((url: string) => {
      (window as unknown as Record<string, unknown>)["__sseEvents"] = [];
      void (async () => {
        const resp = await fetch(url);
        if (!resp.body) return;
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        // Carry partial lines across chunk boundaries so a data: line split
        // across two network chunks is never silently dropped.
        let lineBuf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          lineBuf += dec.decode(value, { stream: true });
          const lines = lineBuf.split("\n");
          // Last element is either "" (complete line ended with \n) or a
          // partial line.  Keep it in the buffer for the next chunk.
          lineBuf = lines.pop() ?? "";
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                (
                  (window as unknown as Record<string, unknown>)["__sseEvents"] as {
                    eventType: string;
                  }[]
                ).push(JSON.parse(line.slice(6)) as { eventType: string });
              } catch {
                /* skip malformed SSE data lines */
              }
            }
          }
        }
        // Flush any remaining buffered content after stream EOF.
        if (lineBuf.startsWith("data: ")) {
          try {
            (
              (window as unknown as Record<string, unknown>)["__sseEvents"] as {
                eventType: string;
              }[]
            ).push(JSON.parse(lineBuf.slice(6)) as { eventType: string });
          } catch {
            /* skip */
          }
        }
      })();
    }, sseUrl);

    // ── 6. Wait for the Cancel button in AgentThinkingBubble ──────────────
    // The workspace page auto-initialises activeTaskId from the tasks query
    // on mount (didAutoInitActiveTask ref), so the AgentThinkingBubble renders
    // even though the task was created via API rather than the UI form.
    const cancelBtn = page.getByTestId("cancel-build-btn");
    await expect(cancelBtn).toBeVisible({ timeout: 20_000 });

    // ── 7. Click Cancel — real UI → handleCancel → POST /cancel ──────────
    await cancelBtn.click();

    // ── 8. Assert GET /tasks reflects "canceled" in the DB ────────────────
    await expect
      .poll(
        async () => {
          const r = await page.request.get(`${BASE_URL}/api/projects/${project.id}/tasks`, {
            headers: E2E_HEADERS,
          });
          const tasks = (await r.json()) as Array<{ id: number; status: string }>;
          return tasks.find((t) => t.id === task.id)?.status;
        },
        { timeout: 15_000, intervals: [500] },
      )
      .toBe("canceled");

    // ── 9. Assert the real SSE stream emitted a "cancelled" event ─────────
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            (
              (window as unknown as Record<string, unknown>)["__sseEvents"] as {
                eventType: string;
              }[]
            ).some((e) => e.eventType === "cancelled"),
          ),
        { timeout: 15_000, intervals: [500] },
      )
      .toBe(true);
  }, 90_000);
});
