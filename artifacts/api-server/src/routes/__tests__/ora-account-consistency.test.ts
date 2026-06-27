import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  oraConversationsTable,
  oraProjectsTable,
  knowledgeEntriesTable,
  oraAssetsTable,
  supportTicketsTable,
  userSubscriptionsTable,
} from "@workspace/db";

// Clerk + superuser checks are the only side-effecting deps — the DATABASE stays
// REAL so the owner-scoped counts and per-user isolation are genuinely exercised.
//
// getAuth is stubbed to return a session with NO user so the REAL
// ClerkAuthAdapter.attachUser hits its unauthenticated branch (401) — exercising
// the actual auth wall this route sits behind, not a hand-rolled guard.
vi.mock("@clerk/express", () => ({
  getAuth: vi.fn(() => ({})),
  clerkClient: { users: {} },
}));
vi.mock("../../lib/clerk-users", () => ({
  getClerkUserById: vi.fn(async () => ({
    userId: "masked",
    email: "user@example.com",
    displayName: null,
    imageUrl: null,
  })),
}));
vi.mock("../../lib/superusers", () => ({
  isSuperuser: vi.fn(async () => false),
  isSuperuserSync: vi.fn(() => false),
  superuserEmails: vi.fn(() => []),
  SUPERUSER_ORA_TIER: "core",
}));

import { isSuperuser } from "../../lib/superusers";
import { attachUser } from "../../lib/auth";
import accountConsistencyRouter from "../ora-account-consistency";

/**
 * Owner-isolation + privacy tests for GET /ora/account-consistency.
 *
 * The endpoint is a cross-platform diagnostic: it must report ONLY the caller's
 * own counts/tiers, never leak another user's rows, and never expose the raw
 * user id or any message/memory content. Billing tier and chat tier must agree
 * (both derive from the same resolver), and superuser fallback must apply.
 */

const STAMP = Date.now();
const USER_A = `acc-consistency-a-${STAMP}`;
const USER_B = `acc-consistency-b-${STAMP}`;
const USER_PAID = `acc-consistency-paid-${STAMP}`;
const USER_SUPER = `acc-consistency-super-${STAMP}`;
const ALL_USERS = [USER_A, USER_B, USER_PAID, USER_SUPER];

function appAs(userId: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = userId;
    next();
  });
  app.use(accountConsistencyRouter);
  return app;
}

// App that runs the REAL auth wall (no Clerk session resolved => 401).
function appUnauthenticated() {
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use(accountConsistencyRouter);
  return app;
}

async function cleanup() {
  for (const u of ALL_USERS) {
    await db.delete(oraConversationsTable).where(eq(oraConversationsTable.userId, u));
    await db.delete(oraProjectsTable).where(eq(oraProjectsTable.userId, u));
    await db.delete(knowledgeEntriesTable).where(eq(knowledgeEntriesTable.userId, u));
    await db.delete(oraAssetsTable).where(eq(oraAssetsTable.userId, u));
    await db.delete(supportTicketsTable).where(eq(supportTicketsTable.userId, u));
    await db.delete(userSubscriptionsTable).where(eq(userSubscriptionsTable.userId, u));
  }
}

beforeAll(async () => {
  await cleanup();

  // ── USER_A: a precise, known set of rows (the counts under test) ──────────
  await db.insert(oraConversationsTable).values([
    { userId: USER_A, title: "A chat one", messages: [], surface: "normal" },
    { userId: USER_A, title: "A chat two", messages: [], surface: "normal" },
    // Excluded: support surface + archived normal must NOT be counted.
    { userId: USER_A, title: "A support", messages: [], surface: "support" },
    {
      userId: USER_A,
      title: "A archived",
      messages: [],
      surface: "normal",
      archivedAt: new Date(),
    },
  ]);
  await db.insert(oraProjectsTable).values([
    { userId: USER_A, name: "A project" },
    { userId: USER_A, name: "A archived project", archivedAt: new Date() },
  ]);
  await db.insert(knowledgeEntriesTable).values([
    // userLevelMemories: scope='user', origin='ora', not archived → counted (2).
    { userId: USER_A, title: "A mem 1", content: "x", scope: "user", origin: "ora" },
    { userId: USER_A, title: "A mem 2", content: "x", scope: "user", origin: "ora" },
    // Excluded from userLevelMemories: builder origin, archived, and project scope.
    { userId: USER_A, title: "A builder mem", content: "x", scope: "user", origin: "builder" },
    {
      userId: USER_A,
      title: "A archived mem",
      content: "x",
      scope: "user",
      origin: "ora",
      archivedAt: new Date(),
    },
    // projectMemories: origin='ora' with an Ora project anchor → counted (1).
    {
      userId: USER_A,
      title: "A proj mem",
      content: "x",
      scope: "project",
      origin: "ora",
      oraProjectId: 999,
    },
  ]);
  await db.insert(oraAssetsTable).values([
    { userId: USER_A, kind: "image", fileName: "a.png", mimeType: "image/png", data: "x" },
    {
      userId: USER_A,
      kind: "image",
      fileName: "del.png",
      mimeType: "image/png",
      data: "x",
      deletedAt: new Date(),
    },
  ]);
  await db
    .insert(supportTicketsTable)
    .values({ userId: USER_A, subject: "A ticket", status: "new" });

  // ── USER_B: lots of NOISE that must never bleed into USER_A's snapshot ────
  await db.insert(oraConversationsTable).values(
    Array.from({ length: 5 }, (_, i) => ({
      userId: USER_B,
      title: `B chat ${i}`,
      messages: [],
      surface: "normal" as const,
    })),
  );
  await db.insert(oraProjectsTable).values({ userId: USER_B, name: "B project" });
  await db
    .insert(knowledgeEntriesTable)
    .values({ userId: USER_B, title: "B mem", content: "x", scope: "user", origin: "ora" });
  await db
    .insert(oraAssetsTable)
    .values({ userId: USER_B, kind: "image", fileName: "b.png", mimeType: "image/png", data: "x" });

  // ── USER_PAID: an active wave subscription ────────────────────────────────
  await db.insert(userSubscriptionsTable).values({
    userId: USER_PAID,
    tier: "wave",
    status: "active",
    currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    cancelAtPeriodEnd: false,
  });
});

afterAll(async () => {
  await cleanup();
});

beforeEach(() => {
  vi.mocked(isSuperuser).mockResolvedValue(false);
});

describe("auth wall", () => {
  it("returns 401 when no user is resolved (real attachUser)", async () => {
    const res = await request(appUnauthenticated()).get("/ora/account-consistency");
    expect(res.status).toBe(401);
  });
});

describe("identity is privacy-safe", () => {
  it("exposes a stable sha256 fingerprint and never the raw user id", async () => {
    const res = await request(appAs(USER_A)).get("/ora/account-consistency");
    expect(res.status).toBe(200);

    const expectedHash = createHash("sha256").update(USER_A).digest("hex").slice(0, 12);
    expect(res.body.identity.userIdHash).toBe(expectedHash);
    expect(res.body.identity.userIdHash).toHaveLength(12);
    expect(res.body.identity.clerkUserIdLast4).toBe(USER_A.slice(-4));
    expect(res.body.identity.email).toBe("user@example.com");

    // The raw user id must appear NOWHERE in the serialized response.
    expect(JSON.stringify(res.body)).not.toContain(USER_A);
  });

  it("produces a different fingerprint for a different user", async () => {
    const a = await request(appAs(USER_A)).get("/ora/account-consistency");
    const b = await request(appAs(USER_B)).get("/ora/account-consistency");
    expect(a.body.identity.userIdHash).not.toBe(b.body.identity.userIdHash);
  });
});

describe("counts are owner-scoped and exclude soft-deleted / wrong-surface rows", () => {
  it("counts only USER_A's own active rows", async () => {
    const res = await request(appAs(USER_A)).get("/ora/account-consistency");
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({
      conversations: 2,
      projects: 1,
      userLevelMemories: 2,
      projectMemories: 1,
      assets: 1,
      supportTickets: 1,
    });
  });

  it("does not leak USER_B's rows into USER_A's snapshot", async () => {
    const res = await request(appAs(USER_A)).get("/ora/account-consistency");
    // USER_B has 5 conversations; USER_A must still report exactly 2.
    expect(res.body.counts.conversations).toBe(2);
    expect(res.body.latest.conversation?.label).not.toContain("B chat");
  });
});

describe("latest rows carry labels + timestamps only (no content)", () => {
  it("returns the caller's own most-recent conversation/project/memory summaries", async () => {
    const res = await request(appAs(USER_A)).get("/ora/account-consistency");
    expect(res.body.latest.conversation).toMatchObject({ label: expect.any(String) });
    expect(typeof res.body.latest.conversation.id).toBe("number");
    expect(res.body.latest.project?.label).toBe("A project");
    expect(res.body.latest.memory).not.toBeNull();
    // Latest rows expose id/label/at only — never a "content" field.
    expect(res.body.latest.conversation).not.toHaveProperty("content");
    expect(res.body.latest.memory).not.toHaveProperty("content");
  });
});

describe("billing tier and chat tier always agree", () => {
  it("free user: billingTier == chatSession.tier == 'free'", async () => {
    const res = await request(appAs(USER_A)).get("/ora/account-consistency");
    expect(res.body.billing.billingTier).toBe("free");
    expect(res.body.billing.sourceTier).toBe("free");
    expect(res.body.chatSession.tier).toBe("free");
    expect(res.body.chatSession.isPaid).toBe(false);
    expect(res.body.billing.billingTier).toBe(res.body.chatSession.tier);
  });

  it("paid user: reflects the active subscription on both tiers", async () => {
    const res = await request(appAs(USER_PAID)).get("/ora/account-consistency");
    expect(res.body.billing.sourceTier).toBe("wave");
    expect(res.body.billing.billingTier).toBe("wave");
    expect(res.body.billing.status).toBe("active");
    expect(res.body.chatSession.tier).toBe("wave");
    expect(res.body.chatSession.isPaid).toBe(true);
    expect(typeof res.body.billing.currentPeriodEnd).toBe("string");
    expect(res.body.billing.billingTier).toBe(res.body.chatSession.tier);
  });
});

describe("superuser fallback raises the effective tier", () => {
  it("a superuser with no paid subscription resolves to the superuser tier", async () => {
    vi.mocked(isSuperuser).mockResolvedValue(true);
    const res = await request(appAs(USER_SUPER)).get("/ora/account-consistency");
    expect(res.body.billing.isSuperuser).toBe(true);
    expect(res.body.billing.sourceTier).toBe("free");
    expect(res.body.billing.billingTier).toBe("core");
    expect(res.body.chatSession.tier).toBe("core");
    expect(res.body.billing.billingTier).toBe(res.body.chatSession.tier);
  });
});

describe("api block echoes environment + host without a fetch surface", () => {
  it("reports the request host and node environment", async () => {
    const res = await request(appAs(USER_A)).get("/ora/account-consistency");
    expect(typeof res.body.api.environment).toBe("string");
    expect(res.body.api).toHaveProperty("host");
    expect(typeof res.body.checkedAt).toBe("string");
  });
});
