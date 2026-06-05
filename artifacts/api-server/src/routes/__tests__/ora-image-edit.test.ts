import { describe, it, expect, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import { and, eq, like } from "drizzle-orm";
import {
  db,
  generatedImagesTable,
  creditTransactionsTable,
  userCreditsTable,
  oraDailyUsageTable,
} from "@workspace/db";
import imageGenRouter from "../image-gen";
import { CREDITS_ENFORCEMENT_ENABLED } from "../credits";

/**
 * Acceptance tests for inline image editing (Task #1279).
 *
 * Exercises the existing `POST /images/:id/edit` endpoint that powers Ora's
 * inline image Edit action. Mounts the real router behind a stub auth
 * middleware that sets req.userId (the same contract the production auth wall
 * provides) against the real dev DB. Two distinct users prove ownership
 * scoping.
 *
 * The endpoint enqueues a background job that calls the image provider; we only
 * assert the synchronous effects (child lineage row + credit debit ledger +
 * 202 response shape) which are deterministic. The async job is left to fail
 * fast against a bogus parent file URL — that does not affect these assertions
 * (the debit transaction persists even when the job later refunds).
 */

const USER_A = `test-img-edit-a-${Date.now()}`;
const USER_B = `test-img-edit-b-${Date.now()}`;

function appAs(userId: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = userId;
    next();
  });
  app.use(imageGenRouter);
  return app;
}

async function insertParentImage(
  userId: string,
  overrides: Partial<typeof generatedImagesTable.$inferInsert> = {},
): Promise<number> {
  const [row] = await db
    .insert(generatedImagesTable)
    .values({
      userId,
      prompt: "a serene mountain lake at dawn",
      quality: "standard",
      aspectRatio: "1:1",
      style: "vivid",
      providerName: "openai",
      modelName: "gpt-image-1",
      status: "completed",
      safetyStatus: "passed",
      creditCost: 0,
      sourceType: "generated",
      // Bogus but non-empty so the edit precondition passes; the async job that
      // tries to fetch it will fail fast (and is irrelevant to these assertions).
      fileUrl: "/api/images/0/file",
      ...overrides,
    })
    .returning({ id: generatedImagesTable.id });
  return row!.id;
}

afterAll(async () => {
  for (const u of [USER_A, USER_B]) {
    await db.delete(generatedImagesTable).where(eq(generatedImagesTable.userId, u));
    await db.delete(creditTransactionsTable).where(eq(creditTransactionsTable.userId, u));
    await db.delete(userCreditsTable).where(eq(userCreditsTable.userId, u));
    await db.delete(oraDailyUsageTable).where(eq(oraDailyUsageTable.userId, u));
  }
});

describe("POST /images/:id/edit — inline image editing", () => {
  it("rejects an empty instruction with 400", async () => {
    const parentId = await insertParentImage(USER_A);
    const res = await request(appAs(USER_A))
      .post(`/images/${parentId}/edit`)
      .send({ instruction: "" });
    expect(res.status).toBe(400);
  });

  it("returns 404 when editing an image owned by another user", async () => {
    const parentId = await insertParentImage(USER_A);
    const res = await request(appAs(USER_B))
      .post(`/images/${parentId}/edit`)
      .send({ instruction: "make the sky purple" });
    expect(res.status).toBe(404);
  });

  it("returns 422 when the parent image is not completed", async () => {
    const parentId = await insertParentImage(USER_A, { status: "pending" });
    const res = await request(appAs(USER_A))
      .post(`/images/${parentId}/edit`)
      .send({ instruction: "make the sky purple" });
    expect(res.status).toBe(422);
  });

  it("creates a child image with edit lineage and deducts credits", async () => {
    const parentId = await insertParentImage(USER_A);

    const res = await request(appAs(USER_A))
      .post(`/images/${parentId}/edit`)
      .send({ instruction: "add a wooden canoe on the water", quality: "standard" });

    expect(res.status).toBe(202);
    expect(res.body.jobId).toBeTypeOf("string");
    expect(res.body.imageId).toBeTypeOf("number");
    expect(res.body.creditCost).toBe(3);

    const childId = res.body.imageId as number;
    const [child] = await db
      .select()
      .from(generatedImagesTable)
      .where(eq(generatedImagesTable.id, childId));

    expect(child.userId).toBe(USER_A);
    expect(child.parentImageId).toBe(parentId);
    expect(child.sourceType).toBe("edited");
    expect(child.editInstruction).toBe("add a wooden canoe on the water");
    expect(child.creditCost).toBe(3);

    // When credit enforcement is on, a debit transaction is recorded for the
    // edit (it persists even if the async job later fails and issues a separate
    // refund entry). When enforcement is off (default in dev/test), the cost is
    // still surfaced on the 202 response and the child row, asserted above.
    if (CREDITS_ENFORCEMENT_ENABLED) {
      const debits = await db
        .select()
        .from(creditTransactionsTable)
        .where(
          and(
            eq(creditTransactionsTable.userId, USER_A),
            like(creditTransactionsTable.description, `%image #${childId}%`),
          ),
        );
      const debit = debits.find((t) => t.amount === -3);
      expect(debit).toBeDefined();
      expect(debit!.type).toBe("creative");
    }
  });

  it("Ora-originated edits use Ora daily image quota instead of credits", async () => {
    const parentId = await insertParentImage(USER_A);

    const res = await request(appAs(USER_A)).post(`/images/${parentId}/edit`).send({
      instruction: "make the water look like glass",
      quality: "standard",
      origin: "ora",
    });

    expect(res.status).toBe(202);
    expect(res.body.creditCost).toBe(0);
    expect(res.body.imageCount).toBe(1);
    expect(res.body.imageLimit).toBe(3);

    const childId = res.body.imageId as number;
    const [child] = await db
      .select()
      .from(generatedImagesTable)
      .where(eq(generatedImagesTable.id, childId));

    expect(child.userId).toBe(USER_A);
    expect(child.parentImageId).toBe(parentId);
    expect(child.sourceType).toBe("edited");
    expect(child.editInstruction).toBe("make the water look like glass");
    expect(child.creditCost).toBe(0);
  });

  it("rejects Ora-origin quota mode for non-Ora image lineage", async () => {
    const parentId = await insertParentImage(USER_A, { sourceType: "uploaded", creditCost: 0 });

    const res = await request(appAs(USER_A)).post(`/images/${parentId}/edit`).send({
      instruction: "make the sky orange",
      quality: "standard",
      origin: "ora",
    });

    expect(res.status).toBe(403);
  });

  it("returns 404 for a non-existent image id", async () => {
    const res = await request(appAs(USER_A))
      .post(`/images/999999999/edit`)
      .send({ instruction: "make the sky purple" });
    expect(res.status).toBe(404);
  });
});
