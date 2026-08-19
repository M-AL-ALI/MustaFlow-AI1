/**
 * Public /billing/ora-plans reachability + mount-order tests.
 *
 * The anonymous pricing page consumes GET /api/billing/ora-plans as its Ora
 * plan source of truth. That endpoint MUST be reachable without a Clerk session,
 * otherwise signed-out visitors silently fall back to hardcoded tiers and the
 * "server is the single source of truth" guarantee breaks for public pricing.
 *
 * This guards two invariants:
 *   1. billingPublicRouter serves ora-plans with NO auth middleware (200 + tiers).
 *   2. In routes/index.ts the public router is mounted BEFORE the auth wall
 *      (attachUser) while the sensitive authed billingRouter stays AFTER it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
});

// Stripe availability reads live config; pin the public single-flight wrapper
// so the handler is deterministic.
vi.mock("../../lib/stripeClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/stripeClient")>();
  return { ...actual, stripeAvailableSingleFlight: vi.fn(async () => true) };
});

vi.mock("../../lib/ai-providers", () => ({
  creditCostFor: vi.fn((_mode: string, provider: string) => (provider === "anthropic" ? 701 : 307)),
  resolveStageProvider: vi.fn((stage: string) => ({
    provider: stage === "build" ? "anthropic" : "openai",
    model: "test-model",
  })),
}));

const { billingPublicRouter } = await import("../billing");
const { creditCostFor, resolveStageProvider } = await import("../../lib/ai-providers");

describe("GET /billing/ora-plans (public)", () => {
  it("returns Ora tiers with NO auth middleware", async () => {
    const app = express();
    app.use(billingPublicRouter);

    const res = await request(app).get("/billing/ora-plans");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=60, stale-while-revalidate=300");
    expect(res.headers["x-ratelimit-limit"]).toBe("120");

    const ids = (res.body.tiers as Array<{ id: string }>).map((t) => t.id);
    expect(ids).toEqual(["free", "core", "wave"]);

    const wave = (res.body.tiers as Array<{ id: string; priceUsd: number }>).find(
      (t) => t.id === "wave",
    );
    expect(wave?.priceUsd).toBe(40);
    expect((res.body.tiers as Array<{ priceUsd: number }>).some((t) => t.priceUsd === 65)).toBe(
      false,
    );
  });

  it("marks the free tier available even when Stripe is not configured", async () => {
    const stripeClient = await import("../../lib/stripeClient");
    vi.mocked(stripeClient.stripeAvailableSingleFlight).mockResolvedValueOnce(false);

    const app = express();
    app.use(billingPublicRouter);

    const res = await request(app).get("/billing/ora-plans");
    expect(res.status).toBe(200);
    const tiers = res.body.tiers as Array<{ id: string; available: boolean }>;
    expect(tiers.find((t) => t.id === "free")?.available).toBe(true);
    expect(tiers.find((t) => t.id === "core")?.available).toBe(false);
    expect(tiers.find((t) => t.id === "wave")?.available).toBe(false);
  });

  it("bounds and caches the public NabuFlow catalog with the same route-local policy", async () => {
    const app = express();
    app.use(billingPublicRouter);

    const res = await request(app).get("/billing/nabuflow/plans");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=60, stale-while-revalidate=300");
    expect(res.headers["x-ratelimit-limit"]).toBe("120");
    expect(res.body.plans).toBeInstanceOf(Array);

    const buildProvider = resolveStageProvider("build", "power").provider;
    const refineProvider = resolveStageProvider("refine", "power").provider;
    const buildPower = res.body.modeCosts.build.find(
      (entry: { mode: string }) => entry.mode === "Power",
    );
    const refinePower = res.body.modeCosts.refine.find(
      (entry: { mode: string }) => entry.mode === "Power",
    );
    expect(buildPower.credits).toBe(creditCostFor("power", buildProvider));
    expect(refinePower.credits).toBe(creditCostFor("power", refineProvider));
  });
});

describe("billing route mount order in routes/index.ts", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const indexSrc = readFileSync(resolve(here, "../index.ts"), "utf8");
  const publicBillingSrc = readFileSync(resolve(here, "../billing.ts"), "utf8");
  const nabuflowBillingSrc = readFileSync(resolve(here, "../nabuflow-billing.ts"), "utf8");

  const publicMount = indexSrc.indexOf("router.use(billingPublicRouter)");
  const authWall = indexSrc.indexOf("router.use(attachUser)");
  const authedBillingMount = indexSrc.indexOf("router.use(billingRouter)");

  it("mounts the public ora-plans router BEFORE the auth wall", () => {
    expect(publicMount).toBeGreaterThan(-1);
    expect(authWall).toBeGreaterThan(-1);
    expect(publicMount).toBeLessThan(authWall);
  });

  it("keeps the sensitive authed billing router AFTER the auth wall", () => {
    expect(authedBillingMount).toBeGreaterThan(-1);
    expect(authedBillingMount).toBeGreaterThan(authWall);
  });

  it("declares one public NabuFlow plan catalog route", () => {
    const routePattern = /"\/billing\/nabuflow\/plans"/g;
    const declarations =
      (publicBillingSrc.match(routePattern)?.length ?? 0) +
      (nabuflowBillingSrc.match(routePattern)?.length ?? 0);
    expect(declarations).toBe(1);
  });
});
