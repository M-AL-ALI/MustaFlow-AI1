import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  enqueueBillingSettlement: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  pool: {
    connect: vi.fn(async () => ({
      query: h.query,
      release: h.release,
    })),
  },
}));

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {},
}));

vi.mock("./billing-settlement-outbox", () => ({
  enqueueBillingSettlement: h.enqueueBillingSettlement,
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  accumulateBuildTokens,
  dominantBuildTokenAttribution,
  flushBuildTokenTelemetry,
} from "./ai-providers";

beforeEach(() => {
  vi.clearAllMocks();
  h.query.mockResolvedValue({ rows: [] });
  h.enqueueBillingSettlement.mockResolvedValue(undefined);
});

describe("build token telemetry", () => {
  it("attributes provider/model by token weight, not last use", () => {
    const dominant = dominantBuildTokenAttribution(
      new Map([
        ["openai", { provider: "openai", model: "gpt-5", tokens: 120 }],
        ["anthropic", { provider: "anthropic", model: "claude-sonnet", tokens: 900 }],
      ]),
    );
    expect(dominant).toEqual({ provider: "anthropic", model: "claude-sonnet" });
  });

  it.each(["canceled", "failed"] as const)(
    "persists partial token usage with terminal status %s",
    async (status) => {
      const taskId = status === "canceled" ? 920 : 921;
      accumulateBuildTokens(taskId, {
        mode: "power",
        provider: "anthropic",
        model: "claude-sonnet",
        inputTokens: 800,
        outputTokens: 200,
      });
      // A smaller final call must not steal dominant attribution.
      accumulateBuildTokens(taskId, {
        mode: "power",
        provider: "openai",
        model: "gpt-5",
        inputTokens: 10,
        outputTokens: 5,
      });

      await flushBuildTokenTelemetry(taskId, status);

      expect(h.query).toHaveBeenCalledWith(
        expect.stringContaining("status"),
        expect.arrayContaining([taskId, "power", "anthropic", "claude-sonnet", status, 810, 205]),
      );
      expect(h.release).toHaveBeenCalled();
    },
  );

  it("defaults the success flush to completed", async () => {
    accumulateBuildTokens(923, {
      mode: "lite",
      provider: "openai",
      model: "gpt-5-nano",
      inputTokens: 50,
      outputTokens: 25,
    });

    await flushBuildTokenTelemetry(923);

    expect(h.query).toHaveBeenCalledWith(
      expect.stringContaining("status"),
      expect.arrayContaining([923, "lite", "openai", "gpt-5-nano", "completed"]),
    );
  });

  it("retries a failed upsert three times, then durably queues the snapshot", async () => {
    h.query.mockRejectedValue(new Error("Neon unavailable"));
    accumulateBuildTokens(922, {
      mode: "eco",
      provider: "gemini",
      model: "gemini-2.5-flash",
      inputTokens: 300,
      outputTokens: 100,
    });

    await flushBuildTokenTelemetry(922, "failed");

    expect(h.query).toHaveBeenCalledTimes(3);
    expect(h.enqueueBillingSettlement).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "build_token_telemetry",
        dedupeKey: "build-token-telemetry:922",
        taskId: 922,
        context: expect.objectContaining({
          status: "failed",
          provider: "gemini",
          model: "gemini-2.5-flash",
        }),
      }),
    );
  });

  it("flushes cancel/failure paths instead of deleting their accumulators", () => {
    const jobs = readFileSync(new URL("./jobs.ts", import.meta.url), "utf8");
    expect(jobs).toContain('flushBuildTokenTelemetry(taskId, "canceled")');
    expect(jobs).toContain('flushBuildTokenTelemetry(taskId, "failed")');
  });

  it("segments calibration by status while pricing completed runs only", () => {
    const admin = readFileSync(new URL("../routes/admin.ts", import.meta.url), "utf8");
    expect(admin).toContain("GROUP BY mode, status");
    expect(admin).toContain('filter((r) => r.status === "completed")');
    expect(admin).toContain("statusSegments");
  });
});
