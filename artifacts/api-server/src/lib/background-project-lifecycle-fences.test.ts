import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), "utf8");

const imageJobs = read("./image-generation-jobs.ts");
const blueprintRoutes = read("../routes/blueprints.ts");
const webhooks = read("./webhook-dispatcher.ts");
const scheduler = read("./cf-scheduler.ts");
const terminal = read("./terminal.ts");
const debug = read("../routes/debug.ts");

describe("background project lifecycle fences", () => {
  it("holds image generation and edit lifecycle sessions through terminal receipts", () => {
    expect(
      imageJobs.match(/acquireProjectLifecycleSession\(opts\.projectId\)/gu) ?? [],
    ).toHaveLength(2);
    expect(imageJobs.match(/registerProjectWorkController\(opts\.projectId/gu) ?? []).toHaveLength(
      2,
    );
    expect(imageJobs.match(/throwIfProjectWorkAborted/gu)?.length ?? 0).toBeGreaterThanOrEqual(7);
    expect(imageJobs.match(/await lifecycleSession\?\.release\(\)/gu) ?? []).toHaveLength(2);
  });

  it("keeps detached blueprint package work admitted until its task receipt is final", () => {
    const detached = blueprintRoutes.slice(
      blueprintRoutes.indexOf("void (async () =>"),
      blueprintRoutes.indexOf("return taskId;"),
    );
    expect(detached).toContain("acquireProjectLifecycleSession(projectId)");
    expect(detached).toContain("registerProjectWorkController(projectId, controller)");
    expect(detached).toContain("execInContainer(");
    expect(detached).toContain('finishTask("completed")');
    expect(detached).toContain("await lifecycleSession?.release()");
    expect(detached.indexOf('finishTask("completed")')).toBeLessThan(
      detached.indexOf("await lifecycleSession?.release()"),
    );
  });

  it("binds webhook retries, transport cancellation, and delivery receipts to one session", () => {
    expect(webhooks).toContain("acquireProjectLifecycleSession(projectId)");
    expect(webhooks).toContain("registerProjectWorkController(projectId, controller)");
    expect(webhooks).toContain("AbortSignal.any([signal, AbortSignal.timeout(10_000)])");
    expect(webhooks).toContain("webhookDeliveriesTable");
    expect(webhooks).toContain("controller.signal");
    expect(webhooks).toContain("await lifecycleSession?.release()");
  });

  it("admits every terminal and debugger command against current container identity", () => {
    for (const source of [terminal, debug]) {
      const messageHandler = source.slice(source.indexOf('ws.on("message"'));
      expect(messageHandler).toContain("acquireProjectLifecycleSession(projectId)");
      expect(messageHandler).toContain("registerProjectWorkController(projectId, controller)");
      expect(messageHandler).toContain("projectsTable.containerId");
      expect(messageHandler).toContain("isNull(projectsTable.deletedAt)");
      expect(messageHandler).toContain("await lifecycleSession?.release()");
      expect(messageHandler).toContain("activeCommandControllers");
    }
  });

  it("filters scheduled observations to active projects and CASes stale certificate writes", () => {
    expect(scheduler.match(/\.innerJoin\(projectsTable/gu)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(scheduler).toContain("isNull(projectsTable.deletedAt)");
    expect(scheduler).toContain("eq(projectDomainsTable.updatedAt, domain.updatedAt)");
    expect(scheduler).toContain(".returning({ id: projectDomainsTable.id })");
    expect(scheduler).toContain("if (!persisted[0]) continue");
  });
});
