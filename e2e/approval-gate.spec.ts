/**
 * Task #774 — Testing approval gate & preview DB: browser e2e spec
 *
 * Covers the security-critical paths added in Task #767:
 *   • Version Snapshots panel renders on the Publishing tab of an agentic project
 *   • "Approve" button on an unapproved version submits and badge turns green
 *   • The approval gate warning disappears once a version is approved
 *     (the "Publish now" step is gated behind this warning, so its absence
 *      confirms the publish path is blocked until approval)
 *   • POST /api/projects/:id/preview-db/provision returns { previewDbStatus }
 *
 * Auth bypass (dev builds only):
 *   Same mechanism as the stop-button spec — window.__E2E_TEST_USER__ is
 *   injected before any page script runs, and x-e2e-test-user is sent with
 *   every browser HTTP request so the API server resolves ownership via the
 *   E2E_TEST_ENABLED bypass in auth.ts.
 *
 * Preconditions:
 *   • API server running at E2E_BASE_URL (default http://localhost:80)
 *   • E2E_TEST_ENABLED=true on the API server
 *
 * Run:
 *   npx playwright test e2e/approval-gate.spec.ts
 */

import { test, expect } from "@playwright/test";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:80";
const E2E_TEST_USER = "e2e-test-user";

test.describe("Testing approval gate and preview DB flow", () => {
  let projectId: number;
  let versionId: number;

  test.beforeAll(async ({ browser }) => {
    // Set up a page context with the dev-auth bypass to create shared fixtures.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.setExtraHTTPHeaders({ "x-e2e-test-user": E2E_TEST_USER });

    // Create a fresh project — all new projects default to builderMode='agentic'.
    const projResp = await page.request.post(`${BASE_URL}/api/projects`, {
      data: { name: `e2e-approval-gate-${Date.now()}`, kind: "web" },
    });
    expect(projResp.ok()).toBe(true);
    const proj = (await projResp.json()) as { id: number };
    projectId = proj.id;

    // Create a version snapshot so the Version Snapshots panel renders.
    const verResp = await page.request.post(`${BASE_URL}/api/projects/${projectId}/versions`, {
      data: { label: "e2e test snapshot" },
    });
    expect(verResp.ok()).toBe(true);
    const ver = (await verResp.json()) as { id: number };
    versionId = ver.id;

    await page.close();
    await ctx.close();
  });

  test("Version Snapshots panel is visible on the Publishing tab", async ({ page }) => {
    // ── 0. Dev-auth bypass ───────────────────────────────────────────────────
    await page.addInitScript(() => {
      (window as unknown as Record<string, string>)["__E2E_TEST_USER__"] = "e2e-test-user";
    });
    await page.setExtraHTTPHeaders({ "x-e2e-test-user": E2E_TEST_USER });

    // ── 1. Navigate to the project workspace ─────────────────────────────────
    await page.goto(`${BASE_URL}/projects/${projectId}`);

    // ── 2. Click the Publishing tab ──────────────────────────────────────────
    const publishingTab = page.locator("[data-tab='publishing']");
    await expect(publishingTab).toBeVisible({ timeout: 15_000 });
    await publishingTab.click();

    // ── 3. The Production sub-tab is the default — panel should be present ───
    const panel = page.getByTestId("version-snapshots-panel");
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await expect(panel).toContainText("Version Snapshots");
  });

  test("Approve button click turns the badge green and removes the gate warning", async ({
    page,
  }) => {
    // ── 0. Dev-auth bypass ───────────────────────────────────────────────────
    await page.addInitScript(() => {
      (window as unknown as Record<string, string>)["__E2E_TEST_USER__"] = "e2e-test-user";
    });
    await page.setExtraHTTPHeaders({ "x-e2e-test-user": E2E_TEST_USER });

    // ── 1. Navigate to the project workspace ─────────────────────────────────
    await page.goto(`${BASE_URL}/projects/${projectId}`);

    // ── 2. Open Publishing tab ────────────────────────────────────────────────
    const publishingTab = page.locator("[data-tab='publishing']");
    await expect(publishingTab).toBeVisible({ timeout: 15_000 });
    await publishingTab.click();

    // ── 3. Verify the Approve button is present (no approval yet) ─────────────
    const approveBtn = page.getByTestId("approve-version-btn").first();
    await expect(approveBtn).toBeVisible({ timeout: 10_000 });

    // ── 4. Verify the gate warning is visible before any approval ─────────────
    const gateWarning = page.getByTestId("testing-approval-warning");
    await expect(gateWarning).toBeVisible({ timeout: 5_000 });

    // ── 5. Click Approve ──────────────────────────────────────────────────────
    await approveBtn.click();

    // ── 6. Verify the green Approved badge appears ────────────────────────────
    const approvedBadge = page.getByTestId("version-approved-badge").first();
    await expect(approvedBadge).toBeVisible({ timeout: 10_000 });
    await expect(approvedBadge).toContainText("Approved");

    // ── 7. Verify the gate warning is gone (publish path is now unblocked) ────
    await expect(gateWarning).not.toBeVisible({ timeout: 5_000 });
  });

  test("Publish step is gated (warning shown) when no version is approved", async ({ page }) => {
    // Create a separate project with a version but no approval, to test the
    // gate independently from the approve flow test above.
    await page.addInitScript(() => {
      (window as unknown as Record<string, string>)["__E2E_TEST_USER__"] = "e2e-test-user";
    });
    await page.setExtraHTTPHeaders({ "x-e2e-test-user": E2E_TEST_USER });

    // Create a fresh project with a version but leave it unapproved.
    const projResp = await page.request.post(`${BASE_URL}/api/projects`, {
      data: { name: `e2e-no-approval-${Date.now()}`, kind: "web" },
    });
    expect(projResp.ok()).toBe(true);
    const gatedProjId = ((await projResp.json()) as { id: number }).id;

    const verResp = await page.request.post(`${BASE_URL}/api/projects/${gatedProjId}/versions`, {
      data: { label: "unapproved snapshot" },
    });
    expect(verResp.ok()).toBe(true);

    // Navigate to the project's Publishing tab.
    await page.goto(`${BASE_URL}/projects/${gatedProjId}`);
    const publishingTab = page.locator("[data-tab='publishing']");
    await expect(publishingTab).toBeVisible({ timeout: 15_000 });
    await publishingTab.click();

    // The gate warning must be present, confirming the publish path is blocked.
    const gateWarning = page.getByTestId("testing-approval-warning");
    await expect(gateWarning).toBeVisible({ timeout: 10_000 });

    // The "Publish now" inline text link must not be rendered while gated.
    // (The button is conditionally omitted, not just disabled, when isAgentic
    //  and no latestApprovedVersion exists.)
    await expect(page.getByText("Publish now")).not.toBeVisible();
  });

  test("POST /api/projects/:id/preview-db/provision returns a valid response", async ({ page }) => {
    await page.setExtraHTTPHeaders({ "x-e2e-test-user": E2E_TEST_USER });

    const resp = await page.request.post(
      `${BASE_URL}/api/projects/${projectId}/preview-db/provision`,
    );

    // The endpoint either starts provisioning (200) or reports it's already
    // in progress (409) — both indicate the route is wired and authorised.
    expect([200, 409]).toContain(resp.status());

    if (resp.status() === 200) {
      const body = (await resp.json()) as { previewDbStatus: string };
      expect(body.previewDbStatus).toBe("provisioning");
    } else {
      const body = (await resp.json()) as { error: string };
      expect(body.error).toMatch(/provisioning/i);
    }
  });
});
