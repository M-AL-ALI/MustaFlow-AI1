// ─────────────────────────────────────────────────────────────────────────────
// GDPR routes
//
//   GET    /api/me/export  — ZIP download of everything the user owns
//   DELETE /api/me         — soft-delete all project data and queue full removal
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { eq, and, isNull } from "drizzle-orm";
import { Zip, ZipDeflate } from "fflate";
import {
  db,
  projectsTable,
  projectFilesTable,
  secretsTable,
  knowledgeEntriesTable,
  chatMessagesTable,
} from "@workspace/db";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ── GET /api/me/export ────────────────────────────────────────────────────────
// Streams a ZIP archive containing all data owned by the requesting user.
// Archive layout:
//   README.txt                  — guide to the archive
//   account.json                — profile metadata
//   projects/<id>/project.json  — project metadata
//   projects/<id>/files/<path>  — generated source files
//   projects/<id>/secrets.json  — secret names + environments (NO values)
//   projects/<id>/messages.json — AI chat history
//   knowledge.json              — all knowledge vault entries
router.get("/me/export", async (req, res): Promise<void> => {
  const userId = req.userId!;

  try {
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="mustaflow-data-export-${Date.now()}.zip"`,
    );

    const zip = new Zip((err, chunk, final) => {
      if (err) {
        logger.error({ err, userId }, "GDPR export zip stream error");
        return;
      }
      res.write(Buffer.from(chunk));
      if (final) res.end();
    });

    function addJson(path: string, data: unknown) {
      const file = new ZipDeflate(path, { level: 6 });
      zip.add(file);
      file.push(Buffer.from(JSON.stringify(data, null, 2) + "\n"), true);
    }

    function addText(path: string, text: string) {
      const file = new ZipDeflate(path, { level: 6 });
      zip.add(file);
      file.push(Buffer.from(text), true);
    }

    // ── README ────────────────────────────────────────────────────────────────
    addText(
      "README.txt",
      [
        "MustaFlow AI — Personal Data Export",
        "====================================",
        "",
        `Exported: ${new Date().toISOString()}`,
        `User ID:  ${userId}`,
        "",
        "This archive contains:",
        "  account.json          — Your account metadata",
        "  projects/*/           — Each project's files, secrets metadata, and AI messages",
        "  knowledge.json        — Your knowledge vault entries",
        "",
        "Secret values are intentionally excluded for security.",
        "To request account deletion:  contact privacy@mustaflow.app",
        "Data Processing Agreement:    https://mustaflow.app/privacy",
      ].join("\n"),
    );

    // ── Account metadata ──────────────────────────────────────────────────────
    addJson("account.json", {
      userId,
      exportedAt: new Date().toISOString(),
      note: "This archive contains all data MustaFlow AI has stored for your account.",
    });

    // ── Projects ──────────────────────────────────────────────────────────────
    const projects = await db
      .select()
      .from(projectsTable)
      .where(and(eq(projectsTable.ownerId, userId), isNull(projectsTable.deletedAt)));

    for (const project of projects) {
      const prefix = `projects/${project.id}`;

      addJson(`${prefix}/project.json`, {
        id: project.id,
        name: project.name,
        description: project.description,
        kind: project.kind,
        status: project.status,
        agentMode: project.agentMode,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      });

      // Source files
      const files = await db
        .select()
        .from(projectFilesTable)
        .where(eq(projectFilesTable.projectId, project.id));

      for (const file of files) {
        const safePath = file.path.replace(/^\/+/, "").replace(/\.\./g, "_");
        addText(`${prefix}/files/${safePath}`, file.content);
      }

      // Secret names only — never export values
      const secrets = await db
        .select({
          name: secretsTable.name,
          environment: secretsTable.environment,
          category: secretsTable.category,
          createdAt: secretsTable.createdAt,
        })
        .from(secretsTable)
        .where(eq(secretsTable.projectId, project.id));

      addJson(`${prefix}/secrets.json`, {
        note: "Secret values are never exported for security. Only names and metadata are included.",
        secrets,
      });

      // AI chat messages
      const messages = await db
        .select({
          role: chatMessagesTable.role,
          content: chatMessagesTable.content,
          createdAt: chatMessagesTable.createdAt,
        })
        .from(chatMessagesTable)
        .where(eq(chatMessagesTable.projectId, project.id));

      addJson(`${prefix}/messages.json`, messages);
    }

    // ── Knowledge vault ───────────────────────────────────────────────────────
    const knowledge = await db
      .select({
        title: knowledgeEntriesTable.title,
        content: knowledgeEntriesTable.content,
        type: knowledgeEntriesTable.type,
        category: knowledgeEntriesTable.category,
        createdAt: knowledgeEntriesTable.createdAt,
      })
      .from(knowledgeEntriesTable)
      .where(eq(knowledgeEntriesTable.userId, userId));

    addJson("knowledge.json", knowledge);

    zip.end();
  } catch (err) {
    logger.error({ err, userId }, "GDPR data export failed");
    if (!res.headersSent) {
      res.status(500).json({ error: "Export failed — please try again." });
    }
  }
});

// ── DELETE /api/me ────────────────────────────────────────────────────────────
// Soft-deletes all user-owned projects immediately.
// Full account deletion (Clerk credentials, email) must be done via Clerk.
router.delete("/me", async (req, res): Promise<void> => {
  const userId = req.userId!;

  try {
    await db
      .update(projectsTable)
      .set({ deletedAt: new Date() })
      .where(and(eq(projectsTable.ownerId, userId), isNull(projectsTable.deletedAt)));

    logger.info({ userId }, "GDPR account deletion requested — projects soft-deleted");

    res.json({
      deleted: true,
      note: "All your projects have been scheduled for deletion. To fully delete your account (email, authentication credentials), please visit your account settings and use 'Delete Account', or contact privacy@mustaflow.app.",
    });
  } catch (err) {
    logger.error({ err, userId }, "GDPR account deletion failed");
    res.status(500).json({ error: "Deletion request failed. Please contact support." });
  }
});

export default router;
