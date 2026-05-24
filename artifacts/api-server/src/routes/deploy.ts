// ─────────────────────────────────────────────────────────────────────────────
// Deploy route — POST /api/projects/:id/deploy
//
// Promotes the current project state to a live production deployment.
// For react-vite projects with FLY_API_TOKEN configured, provisions a
// production Fly.io container via a blue/green swap.
// For static-html projects (or when Fly is not configured), falls back to
// the DB-snapshot public URL that the existing /api/p/:slug/ route serves.
//
// Pipeline:
//   1. Validate project ownership
//   2. Run publish-readiness checks (blocking failures abort the deploy)
//   3. Snapshot files into project_versions
//   4. Generate/preserve publicSlug
//   5. If react-vite + Fly configured: deployProductionContainer (blue/green)
//   6. Update project: publishedSnapshotId, publicSlug, status, prodContainer*
//   7. Record deployment_logs entry
//   8. Write Knowledge Vault entry
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  projectsTable,
  projectFilesTable,
  projectVersionsTable,
  deploymentLogsTable,
  secretsTable,
} from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { writeKnowledge } from "../lib/knowledge";
import { generateOgSvg } from "../lib/ogImage";
import { deployProductionContainer } from "../lib/container";
import { encryptionService } from "../lib/encryption";
import { logger } from "../lib/logger";

const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN ?? "mustaflow.app";

const router: IRouter = Router();

function generatePublicSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const rand = Math.random().toString(36).slice(2, 8);
  return base ? `${base}-${rand}` : rand;
}

router.post("/projects/:id/deploy", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  if (!Number.isFinite(projectId)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  // ── 1. Publish-readiness gate ──────────────────────────────────────────────
  const readinessRes = await fetch(
    `http://localhost:${process.env.PORT ?? 8080}/api/projects/${projectId}/publish-readiness?env=production`,
    { headers: { cookie: req.headers.cookie ?? "" } },
  ).catch(() => null);

  if (readinessRes && readinessRes.ok) {
    const readiness = (await readinessRes.json()) as { canPublish: boolean; checks: unknown[] };
    if (!readiness.canPublish) {
      res.status(422).json({
        error: "Publish readiness checks failed. Fix the blocking issues before deploying.",
        checks: readiness.checks,
      });
      return;
    }
  }

  // ── 2. Load files ─────────────────────────────────────────────────────────
  const files = await db
    .select()
    .from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, projectId));

  if (files.length === 0) {
    res.status(400).json({
      error: "Cannot deploy a project with no generated files. Build the app first.",
    });
    return;
  }

  // ── 3. Generate/preserve publicSlug ───────────────────────────────────────
  const slug: string = project.publicSlug ?? generatePublicSlug(project.name);
  const deployedAt = new Date().toISOString();
  const isRedeploy = project.publicSlug !== null;
  const deploymentLabel = `${isRedeploy ? "Redeployed" : "Deployed"} — ${new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`;

  // ── 4. Snapshot files into project_versions ────────────────────────────────
  const ogSvg = generateOgSvg({
    name: project.name,
    description: project.description,
    themeColor: project.themeColor ?? null,
    kind: project.kind,
  });
  const ogImageUrl = `data:image/svg+xml;base64,${Buffer.from(ogSvg).toString("base64")}`;

  const [deploymentVersion] = await db
    .insert(projectVersionsTable)
    .values({
      projectId,
      label: deploymentLabel,
      note: `Production deploy. ${files.length} file(s). Actor: ${req.userId ?? "unknown"}. Deployed: ${deployedAt}`,
      ogImageUrl,
      filesSnapshot: files.map((f) => ({
        path: f.path,
        content: f.content,
        mimeType: f.mimeType,
      })),
    })
    .returning({ id: projectVersionsTable.id, label: projectVersionsTable.label });

  const snapshotVersionId = deploymentVersion?.id ?? null;

  // ── 5. Optional: provision prod container (react-vite + Fly configured) ────
  let prodContainerUrl: string | null = project.prodContainerUrl ?? null;
  let prodContainerStatus = project.prodContainerStatus ?? "stopped";
  let prodContainerId = project.prodContainerId ?? null;
  let containerDeployed = false;

  // Task #543: respect per-project deploymentType. "static" never deploys a
  // container even if projectFormat would otherwise qualify. autoscale +
  // reserved_vm both go through the blue/green path; container.ts reads the
  // type to set min_machines_running appropriately.
  const deploymentType = project.deploymentType ?? "static";
  const containerEligible =
    deploymentType !== "static" &&
    project.projectFormat === "react-vite" &&
    !!process.env.FLY_API_TOKEN;

  if (containerEligible) {
    try {
      // Load secrets for env injection
      const secretRows = await db
        .select({ name: secretsTable.name, valueEncrypted: secretsTable.valueEncrypted })
        .from(secretsTable)
        .where(eq(secretsTable.projectId, projectId));

      const envVars: Record<string, string> = {
        PROJECT_ID: String(projectId),
        NODE_ENV: "production",
        PORT: "3000",
      };
      for (const s of secretRows) {
        try {
          envVars[s.name] = encryptionService.decrypt(s.valueEncrypted);
        } catch {
          // skip malformed secrets
        }
      }

      const filePayload = files.map((f) => ({ path: f.path, content: f.content }));
      const result = await deployProductionContainer(
        projectId,
        project.prodContainerId ?? null,
        filePayload,
        envVars,
      );

      if (result) {
        prodContainerId = result.prodContainerId;
        prodContainerUrl = result.containerUrl;
        prodContainerStatus = result.status;
        containerDeployed = true;
        logger.info({ projectId, prodContainerId, prodContainerUrl }, "Prod container deployed");
      }
    } catch (err) {
      logger.error(
        { err, projectId },
        "Prod container deployment failed — falling back to snapshot",
      );
    }
  }

  const publicUrl = `https://${slug}.${PLATFORM_DOMAIN}/`;
  const internalPathUrl = `/api/p/${slug}/`;

  // ── 6. Update project record ───────────────────────────────────────────────
  await db
    .update(projectsTable)
    .set({
      status: "published",
      publishedSnapshotId: snapshotVersionId,
      publicSlug: slug,
      prodContainerId,
      prodContainerStatus,
      prodContainerUrl,
      updatedAt: new Date(),
    })
    .where(eq(projectsTable.id, projectId));

  // ── 7. Record deployment log ───────────────────────────────────────────────
  void db
    .insert(deploymentLogsTable)
    .values({
      projectId,
      userId: req.userId ?? "unknown",
      env: "production",
      status: containerDeployed ? "deployed" : "published",
      publicSlug: slug,
      publicUrl,
      filesCount: files.length,
      snapshotVersionId,
      note: containerDeployed
        ? `Container deployed (blue/green). ${files.length} file(s).`
        : `Snapshot published. ${files.length} file(s). Container not provisioned.`,
    })
    .catch(() => {
      /* best-effort */
    });

  // ── 8. Knowledge Vault entry ───────────────────────────────────────────────
  void writeKnowledge({
    title: `Deployed: ${project.name}`,
    content: `Project "${project.name}" (id:${projectId}) ${isRedeploy ? "redeployed" : "deployed"} to production. Slug: ${slug}. Container: ${containerDeployed ? prodContainerUrl : "not provisioned"}.`,
    type: "publish",
    category: "event",
    severity: "info",
    projectId,
    userId: req.userId,
  });

  res.json({
    ok: true,
    projectId,
    status: "published",
    publicSlug: slug,
    publicUrl,
    internalPathUrl,
    deployedAt,
    snapshotVersionId,
    filesDeployed: files.length,
    containerDeployed,
    prodContainerUrl: containerDeployed ? prodContainerUrl : null,
    note: containerDeployed
      ? "Production container is live. Custom domain traffic is proxied to the container."
      : "Snapshot published. Traffic is served from the DB snapshot. Configure FLY_API_TOKEN to enable container deployments.",
  });
});

export default router;
