import { Router } from "express";
import { eq } from "drizzle-orm";
import { db, previewSessionsTable, projectActivityTable, projectsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import {
  generatePreviewLaunchToken,
  generatePreviewSessionId,
  hashPreviewLaunchToken,
  PREVIEW_SHARE_DURATION_MS,
} from "../lib/preview-share-session";

const router = Router();

router.post("/projects/:id/preview-share", requireProjectOwnership, async (req, res) => {
  const projectId = Number(req.params.id);
  const [project] = await db
    .select({
      containerId: projectsTable.containerId,
      containerStatus: projectsTable.containerStatus,
    })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));

  if (!project?.containerId || project.containerStatus !== "running") {
    res.status(409).json({
      error: "Start this preview before sharing it.",
      code: "preview_not_running",
    });
    return;
  }

  const sessionId = generatePreviewSessionId();
  const launchToken = generatePreviewLaunchToken();
  const expiresAt = new Date(Date.now() + PREVIEW_SHARE_DURATION_MS);

  await db.transaction(async (tx) => {
    await tx.insert(previewSessionsTable).values({
      sessionId,
      projectId,
      userId: req.userId!,
      launchTokenHash: hashPreviewLaunchToken(launchToken),
      expiresAt,
    });
    await tx.insert(projectActivityTable).values({
      projectId,
      actorId: req.userId!,
      eventType: "share_link_created",
      summary: "Created a time-limited preview invitation",
      metadata: {
        receipt: "preview-share-minted-v1",
        sessionId,
        expiresAt: expiresAt.toISOString(),
      },
    });
  });

  const previewUrl = `https://p${projectId}.preview.mustaflow.com`;
  res.status(201).json({
    previewUrl,
    launchUrl: `${previewUrl}/__preview-launch?t=${launchToken}`,
    expiresAt: expiresAt.toISOString(),
  });
});

export default router;
