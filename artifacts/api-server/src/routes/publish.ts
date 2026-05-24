// ─────────────────────────────────────────────────────────────────────────────
// Publish routes
//
//   POST /api/projects/:id/publish         — freeze snapshot → staging or production
//   POST /api/projects/:id/unpublish       — clear snapshot, disable public URL
//   POST /api/projects/:id/promote         — copy staging → production atomically
//
// Query param:  ?env=production (default) | staging
//
// Publish generates a publicSlug on first publish and preserves it on republish.
// The public route /api/p/:slug/ always serves from the frozen snapshot, not live files.
// Staging URL pattern: {slug}-staging.{PLATFORM_DOMAIN}
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { eq, sql, isNull, and } from "drizzle-orm";
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
import { deployProductionContainer, destroyContainer } from "../lib/container";
import { pushSnapshotToCdn, cdnConfigured } from "../lib/cdn";
import { encryptionService } from "../lib/encryption";
import { getUnresolvedCriticalFindings } from "./readiness";
import { runPostPublishHealthCheck, recordHealthCheck, getDeclaredRoutes } from "../lib/prodLogs";

const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN ?? "mustaflow.app";

const router: IRouter = Router();

// Generates a URL-safe slug from a project name + random suffix.
// Format: <slugified-name>-<6-random-chars>
// Does NOT expose the project's integer ID.
function generatePublicSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const rand = Math.random().toString(36).slice(2, 8);
  return base ? `${base}-${rand}` : rand;
}

// ── POST /api/projects/:id/publish ───────────────────────────────────────────
// Supports ?env=production (default) or ?env=staging
router.post("/projects/:id/publish", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  const env = (req.query.env as string | undefined) ?? "production";

  if (env !== "production" && env !== "staging") {
    res.status(400).json({ error: "env must be 'production' or 'staging'" });
    return;
  }

  // requireProjectOwnership already checks deletedAt — this is defense-in-depth.
  const [project] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  // ── Security gate: block publish when blockPublishOnCritical is on and findings exist ──
  // Only applied to production publishes.
  if (env === "production" && project.blockPublishOnCritical) {
    const dismissed = (project.dismissedFindingHashes as string[] | null) ?? [];
    const criticalFindings = await getUnresolvedCriticalFindings(projectId, dismissed);
    if (criticalFindings.length > 0) {
      res.status(422).json({
        error: `Publish blocked by ${criticalFindings.length} critical security finding${criticalFindings.length !== 1 ? "s" : ""}. Resolve or dismiss them in the Quality tab before publishing.`,
        code: "critical_findings",
        findings: criticalFindings.slice(0, 10).map(({ checkName, finding }) => ({
          checkName,
          file: finding.file,
          line: finding.line,
          message: finding.message,
        })),
      });
      return;
    }
  }

  const files = await db
    .select()
    .from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, projectId));

  if (files.length === 0) {
    res.status(400).json({
      error: "Cannot publish a project with no generated files. Build the app first.",
    });
    return;
  }

  // Generate slug on first publish; preserve existing slug on republish.
  const slug: string = project.publicSlug ?? generatePublicSlug(project.name);

  const publishedAt = new Date().toISOString();
  const isRepublish = project.publicSlug !== null;
  const envLabel = env === "staging" ? "Staged" : isRepublish ? "Republished" : "Published";
  const deploymentLabel = `${envLabel} — ${new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`;

  // Generate OG image at publish time and store as a base64 data URL so the
  // frozen snapshot always carries its own social preview card — no separate
  // on-demand route required.
  const ogSvg = generateOgSvg({
    name: project.name,
    description: project.description,
    themeColor: project.themeColor ?? null,
    kind: project.kind,
  });
  const ogImageUrl = `data:image/svg+xml;base64,${Buffer.from(ogSvg).toString("base64")}`;

  // Snapshot the files into a version record (this is the frozen copy).
  const [deploymentVersion] = await db
    .insert(projectVersionsTable)
    .values({
      projectId,
      label: deploymentLabel,
      note: `${env === "staging" ? "Staging" : "Deployment"} snapshot. ${files.length} file(s). Actor: ${req.userId ?? "unknown"}. Published: ${publishedAt}`,
      ogImageUrl,
      environment: env,
      filesSnapshot: files.map((f) => ({
        path: f.path,
        content: f.content,
        mimeType: f.mimeType,
      })),
    })
    .returning({ id: projectVersionsTable.id, label: projectVersionsTable.label });

  if (env === "staging") {
    // ── Staging publish ───────────────────────────────────────────────────────
    const stagingUrl = `https://${slug}-staging.${PLATFORM_DOMAIN}/`;

    await db
      .update(projectsTable)
      .set({
        status: project.status === "draft" ? "testing" : project.status,
        stagingPublishedSnapshotId: deploymentVersion?.id ?? null,
        publicSlug: slug,
        updatedAt: new Date(),
      })
      .where(eq(projectsTable.id, projectId));

    void writeKnowledge({
      title: `Staged: project ${projectId}`,
      content: `Project id:${projectId} published to staging by ${req.userId ?? "unknown"}. Slug: ${slug}. Staging URL: ${stagingUrl}`,
      type: "publish",
      category: "event",
      severity: "info",
      projectId,
      userId: req.userId,
    });

    setImmediate(() => {
      void db
        .insert(deploymentLogsTable)
        .values({
          projectId,
          userId: req.userId ?? "unknown",
          env: "staging",
          status: "published",
          publicSlug: slug,
          publicUrl: stagingUrl,
          note: `Staged snapshot. ${files.length} file(s).`,
        })
        .catch(() => {
          /* best-effort */
        });
    });

    res.json({
      ok: true,
      projectId,
      env: "staging",
      publicSlug: slug,
      stagingUrl,
      publishedAt,
      snapshotVersionId: deploymentVersion?.id,
      filesPublished: files.length,
      note: "Staging URL serves the frozen snapshot. Use Promote to push to production.",
    });
    return;
  }

  // ── Production publish ────────────────────────────────────────────────────

  const publicUrl = `https://${slug}.${PLATFORM_DOMAIN}/`;
  const internalPathUrl = `/api/p/${slug}/`;

  // If the project has a dev container, deploy a production replica.
  // This runs synchronously so we can include the result in the response.
  // When FLY_API_TOKEN is not set, deployProductionContainer is a no-op returning null.
  let containerDeployed = false;
  let prodContainerUrl: string | null = project.prodContainerUrl ?? null;
  let prodContainerStatus = project.prodContainerStatus ?? "stopped";
  let prodContainerId = project.prodContainerId ?? null;

  // Task #543: respect deployment type. "static" never deploys a container,
  // even if the project has a dev container. "autoscale" + "reserved_vm"
  // both go through the blue/green path; container.ts reads the type to
  // set min_machines_running appropriately.
  const deploymentType = project.deploymentType ?? "static";
  const shouldDeployContainer =
    deploymentType !== "static" && !!project.containerId && !!process.env.FLY_API_TOKEN;

  if (shouldDeployContainer) {
    req.log.info({ projectId }, "Project has dev container — deploying production container");
    try {
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

      const prodResult = await deployProductionContainer(
        projectId,
        project.prodContainerId ?? null,
        files.map((f) => ({ path: f.path, content: f.content })),
        envVars,
      );
      if (prodResult) {
        containerDeployed = true;
        prodContainerId = prodResult.prodContainerId;
        prodContainerUrl = prodResult.containerUrl;
        prodContainerStatus = prodResult.status;
      }
    } catch (err) {
      req.log.error(
        { err, projectId },
        "Prod container deployment failed — falling back to snapshot",
      );
    }
  }

  // Mark the project published, store which snapshot is live, and save the slug.
  // Must be awaited (not setImmediate) so downstream consumers — including the
  // post-publish health check — observe the updated row.
  await db
    .update(projectsTable)
    .set({
      status: "published",
      publishedSnapshotId: deploymentVersion?.id ?? null,
      publicSlug: slug,
      prodContainerId,
      prodContainerUrl,
      prodContainerStatus,
      updatedAt: new Date(),
    })
    .where(eq(projectsTable.id, projectId));

  void writeKnowledge({
    title: `Published: project ${projectId}`,
    content: `Project id:${projectId} published by ${req.userId ?? "unknown"}. Slug: ${slug}. Container deployed: ${containerDeployed}.`,
    type: "publish",
    category: "event",
    severity: "info",
    projectId,
    userId: req.userId,
  });

  setImmediate(() => {
    void db
      .insert(deploymentLogsTable)
      .values({
        projectId,
        userId: req.userId ?? "unknown",
        env: "production",
        status: "published",
        publicSlug: slug,
        publicUrl,
        note: containerDeployed
          ? `Container deployed to production. Machine URL: ${prodContainerUrl ?? "unknown"}.`
          : `Snapshot published. ${files.length} file(s).`,
      })
      .catch(() => {
        /* best-effort */
      });
  });

  // Task #543: edge CDN push (no-op when CDN_PROVIDER is unset).
  // Runs in the background — never blocks publish. On success, stamps
  // cdnLastPushedAt so the Publishing tab can show "Edge cache: just now".
  // Note: cdnPushQueued reflects that we *kicked off* a background push, not
  // that bytes are live on the edge. cdnLastPushedAt (stamped below on
  // success) is the source of truth for actual propagation.
  let cdnPushQueued = false;
  if (project.cdnEnabled && cdnConfigured()) {
    cdnPushQueued = true;
    setImmediate(() => {
      void (async () => {
        try {
          const result = await pushSnapshotToCdn(
            projectId,
            slug,
            files.map((f) => ({ path: f.path, content: f.content, mimeType: f.mimeType })),
          );
          if (result) {
            await db
              .update(projectsTable)
              .set({ cdnLastPushedAt: new Date() })
              .where(eq(projectsTable.id, projectId));
            req.log.info(
              { projectId, slug, files: result.filesUploaded, provider: result.provider },
              "CDN push complete",
            );
          }
        } catch (err) {
          req.log.warn({ err, projectId }, "CDN push failed (non-fatal)");
        }
      })();
    });
  }

  // Post-publish health check — Task #511. Runs in the background so the
  // publish response returns immediately. Writes a Knowledge Vault entry on
  // failure and persists the outcome to prod_health_checks for the banner.
  setImmediate(() => {
    void (async () => {
      try {
        const routes = await getDeclaredRoutes(projectId);
        const result = await runPostPublishHealthCheck({
          projectId,
          publicSlug: slug,
          snapshotId: deploymentVersion?.id ?? null,
          routes,
        });
        await recordHealthCheck({
          projectId,
          publicSlug: slug,
          snapshotId: deploymentVersion?.id ?? null,
          status: result.status,
          rootStatus: result.rootStatus,
          rootLatencyMs: result.rootLatencyMs,
          routesChecked: result.routesChecked,
          routesFailed: result.routesFailed,
          failureSummary: result.failureSummary,
        });
        if (result.status !== "passed") {
          await writeKnowledge({
            title: `Health check ${result.status}: project ${projectId}`,
            content: `Post-publish health check for project ${projectId} (slug ${slug}) returned status="${result.status}". ${
              result.failureSummary ?? "No failure summary."
            }`,
            type: "health-check",
            category: "event",
            severity: result.status === "failed" ? "error" : "warning",
            projectId,
            userId: req.userId,
          });
        }
      } catch (err) {
        req.log.warn({ err, projectId }, "Post-publish health check failed (non-fatal)");
      }
    })();
  });

  res.json({
    ok: true,
    projectId,
    env: "production",
    status: "published",
    publicSlug: slug,
    publicUrl,
    internalPathUrl,
    publishedAt,
    snapshotVersionId: deploymentVersion?.id,
    filesPublished: files.length,
    containerDeployed,
    containerUrl: prodContainerUrl,
    deploymentType,
    cdnPushQueued,
    note: containerDeployed
      ? "Production container deployed. Public URL proxies to the live container."
      : "Public URL serves the frozen snapshot. Draft edits do not affect it until you publish again.",
  });
});

// ── POST /api/projects/:id/promote ───────────────────────────────────────────
// Atomically copies stagingPublishedSnapshotId → publishedSnapshotId (production).
// Runs publish-readiness checks first.
router.post("/projects/:id/promote", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (!project.stagingPublishedSnapshotId) {
    res.status(422).json({
      error: "No staging snapshot found. Publish to staging first before promoting.",
    });
    return;
  }

  // ── Production readiness gate ─────────────────────────────────────────────
  // Minimum checks before promoting to production:
  //   1. Project must have at least one file.
  //   2. If blockPublishOnCritical is enabled, no unresolved critical findings.
  const [filesRow] = await db
    .select({ c: sql`count(*)` })
    .from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, projectId));

  if (Number(filesRow?.c ?? 0) === 0) {
    res.status(422).json({
      error: "Cannot promote: project has no generated files. Build the app first.",
      code: "no_files",
    });
    return;
  }

  if (project.blockPublishOnCritical) {
    const dismissed = (project.dismissedFindingHashes as string[] | null) ?? [];
    const criticalFindings = await getUnresolvedCriticalFindings(projectId, dismissed);
    if (criticalFindings.length > 0) {
      res.status(422).json({
        error: `Promote blocked by ${criticalFindings.length} critical security finding${criticalFindings.length !== 1 ? "s" : ""}. Resolve or dismiss them in the Quality tab before promoting.`,
        code: "critical_findings",
        findings: criticalFindings.slice(0, 10).map(({ checkName, finding }) => ({
          checkName,
          file: finding.file,
          line: finding.line,
          message: finding.message,
        })),
      });
      return;
    }
  }

  // Capture current production snapshot before promoting (needed for rollback)
  const prevProductionSnapshotId = project.publishedSnapshotId ?? null;

  // Fetch staging snapshot details for the confirmation payload
  const [stagingVersion] = await db
    .select({
      id: projectVersionsTable.id,
      label: projectVersionsTable.label,
      createdAt: projectVersionsTable.createdAt,
    })
    .from(projectVersionsTable)
    .where(eq(projectVersionsTable.id, project.stagingPublishedSnapshotId));

  const slug: string = project.publicSlug ?? generatePublicSlug(project.name);
  const publicUrl = `https://${slug}.${PLATFORM_DOMAIN}/`;
  const promotedAt = new Date().toISOString();

  // Atomically promote staging → production
  await db
    .update(projectsTable)
    .set({
      status: "published",
      publishedSnapshotId: project.stagingPublishedSnapshotId,
      publicSlug: slug,
      updatedAt: new Date(),
    })
    .where(eq(projectsTable.id, projectId));

  // Also mark the version row as "production" environment
  await db
    .update(projectVersionsTable)
    .set({ environment: "production" })
    .where(eq(projectVersionsTable.id, project.stagingPublishedSnapshotId));

  void writeKnowledge({
    title: `Promoted: project ${projectId}`,
    content: `Staging snapshot ${project.stagingPublishedSnapshotId} promoted to production for project ${projectId} by ${req.userId ?? "unknown"}. Slug: ${slug}.`,
    type: "publish",
    category: "event",
    severity: "info",
    projectId,
    userId: req.userId,
  });

  // Audit log for rollback: status="promote", snapshotVersionId=OLD production snapshot,
  // so rollback can restore publishedSnapshotId = snapshotVersionId.
  setImmediate(() => {
    void db
      .insert(deploymentLogsTable)
      .values({
        projectId,
        userId: req.userId ?? "unknown",
        env: "production",
        status: "promote",
        publicSlug: slug,
        publicUrl,
        snapshotVersionId: prevProductionSnapshotId,
        note: JSON.stringify({
          action: "promote",
          newSnapshotId: project.stagingPublishedSnapshotId,
          prevSnapshotId: prevProductionSnapshotId,
        }),
      })
      .catch(() => {
        /* best-effort */
      });
  });

  res.json({
    ok: true,
    projectId,
    env: "production",
    status: "published",
    publicSlug: slug,
    publicUrl,
    promotedAt,
    snapshotVersionId: project.stagingPublishedSnapshotId,
    prevProductionSnapshotId,
    stagingSnapshotLabel: stagingVersion?.label ?? null,
    stagingSnapshotCreatedAt: stagingVersion?.createdAt ?? null,
    note: "Staging snapshot is now live in production.",
  });
});

// ── POST /api/projects/:id/unpublish ─────────────────────────────────────────
router.post("/projects/:id/unpublish", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  const env = (req.query.env as string | undefined) ?? "production";

  // Fetch current slug so we can include it in the response (slug is never cleared).
  const [current] = await db
    .select({ publicSlug: projectsTable.publicSlug })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

  if (env === "staging") {
    await db
      .update(projectsTable)
      .set({ stagingPublishedSnapshotId: null, updatedAt: sql`now()` })
      .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

    setImmediate(() => {
      void db
        .insert(deploymentLogsTable)
        .values({
          projectId,
          userId: req.userId ?? "unknown",
          env: "staging",
          status: "unpublished",
          note: "Staging unpublished by user.",
        })
        .catch(() => {
          /* best-effort */
        });
    });

    res.json({ ok: true, projectId, env: "staging", publicSlug: current?.publicSlug ?? null });
    return;
  }

  // Stop the production container if one was deployed — best-effort, non-fatal.
  void (async () => {
    const [proj] = await db
      .select({ prodContainerId: projectsTable.prodContainerId })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId));
    if (proj?.prodContainerId) {
      await destroyContainer(proj.prodContainerId, projectId);
      await db
        .update(projectsTable)
        .set({ prodContainerId: null, prodContainerUrl: null, prodContainerStatus: "stopped" })
        .where(eq(projectsTable.id, projectId));
    }
  })().catch((err: unknown) => {
    req.log.warn({ err, projectId }, "Failed to stop production container on unpublish");
  });

  await db
    .update(projectsTable)
    .set({ status: "testing", publishedSnapshotId: null, updatedAt: sql`now()` })
    .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

  void writeKnowledge({
    title: `Unpublished: project ${projectId}`,
    content: `Project id:${projectId} unpublished by ${req.userId ?? "unknown"}. Public URL is now inactive. Slug preserved for next publish.`,
    type: "publish",
    category: "event",
    severity: "info",
    projectId,
    userId: req.userId,
  });

  setImmediate(() => {
    void db
      .insert(deploymentLogsTable)
      .values({
        projectId,
        userId: req.userId ?? "unknown",
        env: "production",
        status: "unpublished",
        note: "Unpublished by user. Public URL disabled.",
      })
      .catch(() => {
        /* best-effort */
      });
  });

  res.json({
    ok: true,
    projectId,
    env: "production",
    status: "testing",
    publicSlug: current?.publicSlug ?? null,
    publicUrlDisabled: true,
  });
});

export default router;
