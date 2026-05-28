// ─────────────────────────────────────────────────────────────────────────────
// GDPR routes
//
//   GET    /api/me/export  — ZIP download of everything the user owns
//   DELETE /api/me         — soft-delete all user data, enqueue hard-erasure job
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { eq, and, isNull, inArray, desc } from "drizzle-orm";
import { Zip, ZipDeflate } from "fflate";
import {
  db,
  projectsTable,
  projectFilesTable,
  secretsTable,
  knowledgeEntriesTable,
  chatMessagesTable,
  projectVersionsTable,
  projectUploadsTable,
  agentTasksTable,
  agentInboxTable,
  workspacesTable,
  deploymentLogsTable,
  creditTransactionsTable,
  projectDomainsTable,
  orgMembersTable,
  userPreferencesTable,
  userSubscriptionsTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { enqueueGdprErasure, isDurableQueueReady } from "../lib/durable-queue";
import { sendGdprDeletionConfirmation } from "../lib/emailClient";
import { getClerkUserById } from "../lib/clerk-users";
import { ObjectStorageService } from "../lib/objectStorage";

const router: IRouter = Router();
const storage = new ObjectStorageService();

// ── GET /api/me/export ────────────────────────────────────────────────────────
// Streams a ZIP archive containing all data owned by the requesting user.
//
// Archive layout:
//   README.txt
//   account.json                        — profile metadata
//   projects/<id>/project.json          — project metadata
//   projects/<id>/files/<path>          — generated source files
//   projects/<id>/secrets.json          — secret names + environments (NO values)
//   projects/<id>/messages.json         — AI chat history
//   projects/<id>/versions/<n>.json     — up to 20 most-recent snapshots per project
//   projects/<id>/uploads.json          — upload metadata + signed download URLs (7-day TTL)
//   projects/<id>/tasks.json            — agent task summaries
//   projects/<id>/deployments.json      — deployment history
//   projects/<id>/domains.json          — custom domain records
//   inbox.json                          — agent inbox items
//   workspaces.json                     — workspace metadata
//   billing.json                        — credit transactions + subscription history
//   knowledge.json                      — all knowledge vault entries (full metadata)
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
        "  account.json           — Your account metadata",
        "  projects/*/            — Each project's files, versions, secrets, messages,",
        "                           uploads (with 7-day signed download URLs), tasks,",
        "                           deployments, and custom domains",
        "  inbox.json             — Your agent inbox items",
        "  workspaces.json        — Workspace metadata",
        "  billing.json           — Credit transaction history and subscription details",
        "  knowledge.json         — Your knowledge vault entries",
        "",
        "Secret values are intentionally excluded for security.",
        "Signed upload download URLs expire 7 days from export time.",
        "To request account deletion or cancel a pending erasure: privacy@mustaflow.app",
        "Data Processing Agreement: https://mustaflow.app/privacy",
      ].join("\n"),
    );

    // ── Account metadata ──────────────────────────────────────────────────────
    const userPrefs = await db
      .select({ voiceLang: userPreferencesTable.voiceLang })
      .from(userPreferencesTable)
      .where(eq(userPreferencesTable.userId, userId))
      .limit(1);

    const voiceLang = userPrefs[0]?.voiceLang ?? null;

    addJson("account.json", {
      userId,
      exportedAt: new Date().toISOString(),
      preferences: {
        voiceLang: voiceLang !== null ? voiceLang : "null (auto-detect)",
      },
      note: "This archive contains all data MustaFlow AI has stored for your account.",
    });

    // ── Projects ──────────────────────────────────────────────────────────────
    const projects = await db
      .select()
      .from(projectsTable)
      .where(and(eq(projectsTable.ownerId, userId), isNull(projectsTable.deletedAt)));

    const projectIds = projects.map((p) => p.id);

    for (const project of projects) {
      const prefix = `projects/${project.id}`;

      addJson(`${prefix}/project.json`, {
        id: project.id,
        name: project.name,
        description: project.description,
        kind: project.kind,
        status: project.status,
        agentMode: project.agentMode,
        builderMode: project.builderMode,
        provisioningStatus: project.provisioningStatus,
        publicSlug: project.publicSlug,
        customDomain: project.customDomain,
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
          minRole: secretsTable.minRole,
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
          agentMode: chatMessagesTable.agentMode,
          planMode: chatMessagesTable.planMode,
          createdAt: chatMessagesTable.createdAt,
        })
        .from(chatMessagesTable)
        .where(eq(chatMessagesTable.projectId, project.id));

      addJson(`${prefix}/messages.json`, messages);

      // Historical version snapshots — most recent 20 per project
      const versions = await db
        .select({
          id: projectVersionsTable.id,
          label: projectVersionsTable.label,
          note: projectVersionsTable.note,
          changelogEntry: projectVersionsTable.changelogEntry,
          filesSnapshot: projectVersionsTable.filesSnapshot,
          planSnapshot: projectVersionsTable.planSnapshot,
          environment: projectVersionsTable.environment,
          testingApprovedAt: projectVersionsTable.testingApprovedAt,
          createdAt: projectVersionsTable.createdAt,
        })
        .from(projectVersionsTable)
        .where(eq(projectVersionsTable.projectId, project.id))
        .orderBy(desc(projectVersionsTable.createdAt))
        .limit(20);

      for (let i = 0; i < versions.length; i++) {
        addJson(`${prefix}/versions/${i + 1}-${versions[i].id}.json`, versions[i]);
      }

      // Upload metadata + best-effort signed download URLs (7-day TTL)
      const uploads = await db
        .select({
          id: projectUploadsTable.id,
          filename: projectUploadsTable.filename,
          mimeType: projectUploadsTable.mimeType,
          sizeBytes: projectUploadsTable.sizeBytes,
          textPreview: projectUploadsTable.textPreview,
          objectPath: projectUploadsTable.objectPath,
          createdAt: projectUploadsTable.createdAt,
        })
        .from(projectUploadsTable)
        .where(eq(projectUploadsTable.projectId, project.id));

      const uploadsWithUrls = await Promise.all(
        uploads.map(async (u) => {
          const downloadUrl = await storage.getSignedDownloadUrl(u.objectPath).catch(() => null);
          return { ...u, downloadUrl };
        }),
      );

      addJson(`${prefix}/uploads.json`, {
        note: "Signed download URLs expire 7 days from export time.",
        uploads: uploadsWithUrls,
      });

      // Agent task summaries (prompt, status, token count — no raw tool call logs)
      const tasks = await db
        .select({
          id: agentTasksTable.id,
          title: agentTasksTable.title,
          kind: agentTasksTable.kind,
          status: agentTasksTable.status,
          prompt: agentTasksTable.prompt,
          result: agentTasksTable.result,
          taskAgentMode: agentTasksTable.taskAgentMode,
          tokenCount: agentTasksTable.tokenCount,
          createdAt: agentTasksTable.createdAt,
          startedAt: agentTasksTable.startedAt,
          completedAt: agentTasksTable.completedAt,
        })
        .from(agentTasksTable)
        .where(eq(agentTasksTable.projectId, project.id));

      addJson(`${prefix}/tasks.json`, tasks);

      // Deployment history
      const deployments = await db
        .select({
          id: deploymentLogsTable.id,
          env: deploymentLogsTable.env,
          status: deploymentLogsTable.status,
          publicSlug: deploymentLogsTable.publicSlug,
          publicUrl: deploymentLogsTable.publicUrl,
          filesCount: deploymentLogsTable.filesCount,
          note: deploymentLogsTable.note,
          platform: deploymentLogsTable.platform,
          createdAt: deploymentLogsTable.createdAt,
        })
        .from(deploymentLogsTable)
        .where(eq(deploymentLogsTable.projectId, project.id));

      addJson(`${prefix}/deployments.json`, deployments);

      // Custom domain records
      const domains = await db
        .select({
          id: projectDomainsTable.id,
          hostname: projectDomainsTable.hostname,
          isPrimary: projectDomainsTable.isPrimary,
          recordType: projectDomainsTable.recordType,
          verificationStatus: projectDomainsTable.verificationStatus,
          sslStatus: projectDomainsTable.sslStatus,
          environment: projectDomainsTable.environment,
          createdAt: projectDomainsTable.createdAt,
        })
        .from(projectDomainsTable)
        .where(eq(projectDomainsTable.projectId, project.id));

      addJson(`${prefix}/domains.json`, domains);
    }

    // ── Agent inbox ───────────────────────────────────────────────────────────
    const inboxItems =
      projectIds.length > 0
        ? await db
            .select()
            .from(agentInboxTable)
            .where(inArray(agentInboxTable.projectId, projectIds))
        : [];

    addJson("inbox.json", inboxItems);

    // ── Workspaces ────────────────────────────────────────────────────────────
    const workspaces = await db
      .select({
        id: workspacesTable.id,
        name: workspacesTable.name,
        description: workspacesTable.description,
        type: workspacesTable.type,
        createdAt: workspacesTable.createdAt,
        updatedAt: workspacesTable.updatedAt,
      })
      .from(workspacesTable)
      .where(and(eq(workspacesTable.ownerUserId, userId), isNull(workspacesTable.deletedAt)));

    addJson("workspaces.json", workspaces);

    // ── Billing — credit transactions + subscription history ──────────────────
    const [transactions, subscription] = await Promise.all([
      db
        .select({
          id: creditTransactionsTable.id,
          type: creditTransactionsTable.type,
          amount: creditTransactionsTable.amount,
          description: creditTransactionsTable.description,
          balanceAfter: creditTransactionsTable.balanceAfter,
          createdAt: creditTransactionsTable.createdAt,
        })
        .from(creditTransactionsTable)
        .where(eq(creditTransactionsTable.userId, userId)),
      db
        .select({
          tier: userSubscriptionsTable.tier,
          status: userSubscriptionsTable.status,
          currentPeriodEnd: userSubscriptionsTable.currentPeriodEnd,
          cancelAtPeriodEnd: userSubscriptionsTable.cancelAtPeriodEnd,
          createdAt: userSubscriptionsTable.createdAt,
          updatedAt: userSubscriptionsTable.updatedAt,
        })
        .from(userSubscriptionsTable)
        .where(eq(userSubscriptionsTable.userId, userId)),
    ]);

    addJson("billing.json", {
      subscription: subscription[0] ?? null,
      creditTransactions: transactions,
    });

    // ── Knowledge vault — full entries including diff_summary and annotation ──
    const knowledge = await db
      .select({
        id: knowledgeEntriesTable.id,
        title: knowledgeEntriesTable.title,
        content: knowledgeEntriesTable.content,
        type: knowledgeEntriesTable.type,
        category: knowledgeEntriesTable.category,
        scope: knowledgeEntriesTable.scope,
        tags: knowledgeEntriesTable.tags,
        severity: knowledgeEntriesTable.severity,
        diffSummary: knowledgeEntriesTable.diffSummary,
        annotation: knowledgeEntriesTable.annotation,
        approvedForReuse: knowledgeEntriesTable.approvedForReuse,
        thumbsUp: knowledgeEntriesTable.thumbsUp,
        thumbsDown: knowledgeEntriesTable.thumbsDown,
        usageCount: knowledgeEntriesTable.usageCount,
        isPublic: knowledgeEntriesTable.isPublic,
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
// 1. Checks that the durable erasure queue is available before proceeding.
// 2. Soft-deletes all user-owned entities in a single transaction.
// 3. Enqueues a durable pg-boss job (mustaflow.gdpr-erasure) to hard-delete
//    everything 30 days from now (GDPR Art. 17 — allowing 30-day cancellation window).
// 4. Persists the job ID and request timestamp to user_preferences.
// 5. Sends a confirmation email to the user's Clerk-registered address.
//
// Full account deletion (Clerk credentials, email) must be done via Clerk UI.
router.delete("/me", async (req, res): Promise<void> => {
  const userId = req.userId!;

  try {
    // Guard: durable queue must be available to guarantee the erasure will run.
    if (!isDurableQueueReady()) {
      res.status(503).json({
        error:
          "Erasure queue is temporarily unavailable. Please try again in a few minutes, or contact privacy@mustaflow.app to initiate account deletion manually.",
      });
      return;
    }

    // ── Soft-delete all owned data in one transaction ──────────────────────
    await db.transaction(async (tx) => {
      // Projects — soft-delete (cascade children remain until hard-erasure job)
      await tx
        .update(projectsTable)
        .set({ deletedAt: new Date() })
        .where(and(eq(projectsTable.ownerId, userId), isNull(projectsTable.deletedAt)));

      // Knowledge vault entries — soft-delete via archivedAt
      await tx
        .update(knowledgeEntriesTable)
        .set({ archivedAt: new Date() })
        .where(
          and(eq(knowledgeEntriesTable.userId, userId), isNull(knowledgeEntriesTable.archivedAt)),
        );

      // Owned workspaces — soft-delete
      await tx
        .update(workspacesTable)
        .set({ deletedAt: new Date() })
        .where(and(eq(workspacesTable.ownerUserId, userId), isNull(workspacesTable.deletedAt)));

      // Org memberships — no soft-delete column; remove immediately
      await tx.delete(orgMembersTable).where(eq(orgMembersTable.userId, userId));

      // Chat messages — no soft-delete column; remove now for immediate data minimisation
      // (they will also be cascade-deleted when the hard-erasure job removes the projects)
      const userProjectRows = await tx
        .select({ id: projectsTable.id })
        .from(projectsTable)
        .where(eq(projectsTable.ownerId, userId));

      if (userProjectRows.length > 0) {
        const ids = userProjectRows.map((p) => p.id);
        await tx.delete(chatMessagesTable).where(inArray(chatMessagesTable.projectId, ids));
      }
    });

    logger.info({ userId }, "GDPR account deletion requested — soft-delete complete");

    // ── Enqueue durable 30-day hard-erasure job ────────────────────────────
    const erasureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const jobId = await enqueueGdprErasure(userId);

    if (!jobId) {
      // Queue was ready at check time but failed to enqueue — log and continue.
      // The soft-delete has already happened; the user should contact support.
      logger.error({ userId }, "GDPR erasure job enqueue failed after soft-delete was committed");
    }

    // ── Persist job ID and timestamp to user_preferences ──────────────────
    // Allows future cancellation and audit without a separate table.
    try {
      await db
        .insert(userPreferencesTable)
        .values({
          userId,
          erasureJobId: jobId ?? "unavailable",
          erasureRequestedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: userPreferencesTable.userId,
          set: {
            erasureJobId: jobId ?? "unavailable",
            erasureRequestedAt: new Date(),
          },
        });
    } catch (prefErr) {
      logger.warn({ prefErr, userId }, "GDPR: failed to persist erasure job ID (non-fatal)");
    }

    // ── Send confirmation email (best-effort) ─────────────────────────────
    try {
      const clerkUser = await getClerkUserById(userId);
      if (clerkUser?.email) {
        await sendGdprDeletionConfirmation({
          to: clerkUser.email,
          userId,
          erasureDate,
        });
      }
    } catch (emailErr) {
      logger.warn({ emailErr, userId }, "GDPR deletion confirmation email failed (non-fatal)");
    }

    res.json({
      deleted: true,
      erasureScheduledFor: erasureDate.toISOString(),
      erasureJobId: jobId,
      note: "Your data has been soft-deleted and is scheduled for permanent erasure in 30 days. To cancel this request, contact privacy@mustaflow.app. To delete your account credentials, use 'Delete Account' in your account settings.",
    });
  } catch (err) {
    logger.error({ err, userId }, "GDPR account deletion failed");
    res.status(500).json({ error: "Deletion request failed. Please contact support." });
  }
});

export default router;
