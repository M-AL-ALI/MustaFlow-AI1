import { describe, it, expect, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db, oraConversationsTable } from "@workspace/db";
import oraConversationsRouter from "../ora-conversations";

/**
 * Regression tests for Ora conversation message persistence (Task #1293).
 *
 * The frontend serializes rich per-message UI state (web-search source cards,
 * inline images, edit lineage, and memory-save chips). A prior version of the
 * backend Zod `messageSchema` omitted those fields, so they were silently
 * stripped on save and the conversation reloaded in a degraded state. These
 * tests prove a round-trip (PUT then GET) preserves them — while still
 * stripping the heavy base64 `generatedFile.fileData` by design.
 */

const USER = `test-ora-persist-${Date.now()}`;

function appAs(userId: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = userId;
    next();
  });
  app.use(oraConversationsRouter);
  return app;
}

afterAll(async () => {
  if (process.env.NABUFLOW_VITEST_DATABASE_ENABLED !== "true") return;
  await db.delete(oraConversationsTable).where(eq(oraConversationsTable.userId, USER));
});

describe.skipIf(process.env.NABUFLOW_VITEST_DATABASE_ENABLED !== "true")(
  "Ora conversation message persistence round-trip",
  () => {
    it("preserves sources, inline image fields, memory fields; strips base64 fileData", async () => {
      const app = appAs(USER);

      const created = await request(app).post("/ora/conversations").send({ title: "Persist test" });
      expect(created.status).toBe(201);
      const convId = created.body.conversation.id as number;

      const messages = [
        { role: "user", content: "find recent news about mars" },
        {
          role: "assistant",
          content: "Here's what I found.",
          sources: [
            { title: "NASA Mars update", url: "https://example.com/mars" },
            { title: "ESA report", url: "https://example.com/esa" },
          ],
        },
        {
          role: "assistant",
          content: "Here's the image.",
          imageUrl: "https://cdn.example.com/generated/mars.png",
          imageId: 12345,
          editInstruction: "make the sky redder",
          imageMeta: {
            kind: "illustration",
            aspectRatio: "16:9",
            style: "vivid",
            quality: "high",
          },
        },
        {
          role: "assistant",
          content: "Saved a note.",
          memorySaveCandidate: "I live at 742 Evergreen Terrace",
          memorySaveCandidateConfidence: "low",
          memorySaveCandidateSensitive: true,
          memorySaved: false,
        },
        {
          role: "assistant",
          content: "Here's your spreadsheet.",
          generatedFile: {
            fileName: "report.csv",
            fileData: Buffer.from("a,b,c\n1,2,3").toString("base64"),
            mimeType: "text/csv",
            format: "csv",
          },
        },
        {
          role: "assistant",
          content: "Updated your preference.",
          memorySaved: true,
          memorySupersededTitles: ["Prefers dark mode", "Lives in Portland"],
        },
      ];

      const saved = await request(app)
        .put(`/ora/conversations/${convId}/messages`)
        .send({ conversationId: convId, messages });
      expect(saved.status).toBe(200);

      const fetched = await request(app).get(`/ora/conversations/${convId}`);
      expect(fetched.status).toBe(200);
      const stored = fetched.body.conversation.messages as Array<Record<string, unknown>>;
      expect(stored).toHaveLength(6);

      // Web-search source cards survive.
      expect(stored[1].sources).toEqual([
        { title: "NASA Mars update", url: "https://example.com/mars" },
        { title: "ESA report", url: "https://example.com/esa" },
      ]);

      // Inline image fields survive.
      expect(stored[2].imageUrl).toBe("https://cdn.example.com/generated/mars.png");
      expect(stored[2].imageId).toBe(12345);
      expect(stored[2].editInstruction).toBe("make the sky redder");
      expect(stored[2].imageMeta).toEqual({
        kind: "illustration",
        aspectRatio: "16:9",
        style: "vivid",
        quality: "high",
      });

      // Memory-save chip fields survive.
      expect(stored[3].memorySaveCandidate).toBe("I live at 742 Evergreen Terrace");
      expect(stored[3].memorySaveCandidateConfidence).toBe("low");
      expect(stored[3].memorySaveCandidateSensitive).toBe(true);
      expect(stored[3].memorySaved).toBe(false);

      // generatedFile metadata survives, but the base64 payload is stripped.
      const gf = stored[4].generatedFile as Record<string, unknown>;
      expect(gf.fileName).toBe("report.csv");
      expect(gf.mimeType).toBe("text/csv");
      expect(gf.format).toBe("csv");
      expect(gf.fileData).toBeUndefined();

      // A saved memory keeps its saved flag and the titles it superseded so the
      // inline chip renders the right state after a reload (this is the exact
      // round-trip the mobile saveOraMemory + persist path depends on).
      expect(stored[5].memorySaved).toBe(true);
      expect(stored[5].memorySupersededTitles).toEqual(["Prefers dark mode", "Lives in Portland"]);
    });

    it("rejects a stale client append and leaves the old conversation unchanged", async () => {
      const app = appAs(USER);
      const oldCreated = await request(app)
        .post("/ora/conversations")
        .send({ title: "Old thread" });
      const newCreated = await request(app)
        .post("/ora/conversations")
        .send({ title: "New thread" });
      const oldId = oldCreated.body.conversation.id as number;
      const newId = newCreated.body.conversation.id as number;
      const original = [{ role: "user", content: "old-thread-only" }];

      expect(
        await request(app)
          .put(`/ora/conversations/${oldId}/messages`)
          .send({ conversationId: oldId, messages: original }),
      ).toMatchObject({ status: 200 });

      const staleSave = await request(app)
        .put(`/ora/conversations/${oldId}/messages`)
        .send({
          conversationId: newId,
          messages: [{ role: "user", content: "must-not-bleed" }],
        });
      expect(staleSave.status).toBe(409);
      expect(staleSave.body.code).toBe("ORA_CONVERSATION_MISMATCH");

      const fetchedOld = await request(app).get(`/ora/conversations/${oldId}`);
      expect(fetchedOld.body.conversation.messages).toEqual(original);
    });
  },
);
