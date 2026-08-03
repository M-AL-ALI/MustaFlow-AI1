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
// ── detectSchemaMigrations ────────────────────────────────────────────────────
// Returns paths of files that look like schema-changing SQL migration scripts.
// Scans: files ending in .sql, files whose path contains "migrat" (any case),
// and Drizzle/Prisma/Knex migration files ending in .ts or .js in a migrations/
// directory. Any match against dangerous DDL triggers a hard block.
function detectSchemaMigrations(files: Array<{ path: string; content: string | null }>): string[] {
  const DANGEROUS_DDL =
    /\b(ALTER\s+TABLE|DROP\s+TABLE|DROP\s+COLUMN|DROP\s+INDEX|TRUNCATE\s+TABLE|RENAME\s+TABLE|RENAME\s+COLUMN)\b/i;
  const violations: string[] = [];
  for (const f of files) {
    if (!f.content) continue;
    const isSql = f.path.endsWith(".sql");
    const isMigrationPath =
      /migrat/i.test(f.path) &&
      (f.path.endsWith(".ts") || f.path.endsWith(".js") || f.path.endsWith(".sql"));
    if ((isSql || isMigrationPath) && DANGEROUS_DDL.test(f.content)) {
      violations.push(f.path);
    }
  }
  return violations;
}
import { eq, sql, isNull, and, desc } from "drizzle-orm";
import { randomBytes } from "crypto";
import {
  db,
  projectsTable,
  projectFilesTable,
  projectVersionsTable,
  previewSnapshotsTable,
  deploymentLogsTable,
  projectDomainsTable,
  secretsTable,
  userSubscriptionsTable,
  orgMembersTable,
  notificationsTable,
  type FileSnapshotEntry,
} from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { writeKnowledge } from "../lib/knowledge";
import { scanContent } from "../lib/content-safety";
import { isAdminUser } from "../lib/adminAuth";
import { generateOgSvg } from "../lib/ogImage";
import { deployProductionContainer, destroyContainer } from "../lib/container";
import { pushSnapshotToCdn, cdnConfigured } from "../lib/cdn";
import { encryptionService } from "../lib/encryption";
import { getUnresolvedCriticalFindings } from "./readiness";
import { evaluatePublishGate, evaluatePromotionGate } from "../lib/publish-gate";
import { runPostPublishHealthCheck, recordHealthCheck, getDeclaredRoutes } from "../lib/prodLogs";
import {
  r2Enabled,
  uploadSnapshotToR2,
  syncAllHostnamesKV,
  purgeCacheForProject,
  uploadMaintenancePage,
  setProjectMaintenanceMode,
  type SnapshotFile,
} from "../lib/cloudflare";

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

  // ── Production publish gate ────────────────────────────────────────────────
  // Security rule: ALL project types (static HTML, React SPA, full-stack container)
  // MUST publish from an immutable tested-and-approved snapshot. The mutable
  // project_files table is NEVER consulted for production. No project type is exempt.
  //
  // The gate logic lives in lib/publish-gate.ts as a pure function so it is
  // unit-testable without a DB or Express dependency.
  const versionIdRaw = (req.body as Record<string, unknown>)?.versionId;
  const publishVersionId = typeof versionIdRaw === "number" ? versionIdRaw : null;

  // Track which snapshot files to publish. Null = use project_files (staging only).
  let approvedSnapshot: FileSnapshotEntry[] | null = null;

  if (env === "production") {
    // Fetch specVersion when the caller supplied an explicit versionId.
    let specVersionData: {
      testingApprovedAt: Date | null;
      filesSnapshot: FileSnapshotEntry[] | null;
    } | null = null;
    if (publishVersionId !== null) {
      const [sv] = await db
        .select({
          id: projectVersionsTable.id,
          projectId: projectVersionsTable.projectId,
          filesSnapshot: projectVersionsTable.filesSnapshot,
          testingApprovedAt: projectVersionsTable.testingApprovedAt,
        })
        .from(projectVersionsTable)
        .where(
          and(
            eq(projectVersionsTable.id, publishVersionId),
            eq(projectVersionsTable.projectId, projectId),
          ),
        );
      // Version-not-found is a 404, handled inside evaluatePublishGate when sv is null.
      specVersionData = sv
        ? {
            testingApprovedAt: sv.testingApprovedAt,
            filesSnapshot: sv.filesSnapshot as FileSnapshotEntry[] | null,
          }
        : null;
    }

    // Fetch testedVersion for the auto-resolve (no explicit versionId) path.
    let testedVersionData: { filesSnapshot: FileSnapshotEntry[] | null } | null = null;
    if (
      project.testedSnapshotId !== null &&
      project.testedSnapshotId !== undefined &&
      publishVersionId === null
    ) {
      const [tv] = await db
        .select({ filesSnapshot: projectVersionsTable.filesSnapshot })
        .from(projectVersionsTable)
        .where(
          and(
            eq(projectVersionsTable.id, project.testedSnapshotId),
            eq(projectVersionsTable.projectId, projectId),
          ),
        );
      testedVersionData = tv
        ? { filesSnapshot: tv.filesSnapshot as FileSnapshotEntry[] | null }
        : null;
    }

    const gate = evaluatePublishGate(
      publishVersionId,
      {
        builderMode: project.builderMode ?? null,
        testedSnapshotId: project.testedSnapshotId ?? null,
        testingStatus: project.testingStatus ?? "idle",
        containerId: project.containerId ?? null,
      },
      specVersionData,
      testedVersionData,
    );

    if (!gate.ok) {
      res.status(gate.status).json({
        error: gate.error,
        code: gate.code,
        ...(gate.extra ?? {}),
      });
      return;
    }

    approvedSnapshot = gate.approvedSnapshot as FileSnapshotEntry[];
    req.log.info(
      {
        projectId,
        versionId: publishVersionId,
        testedSnapshotId: project.testedSnapshotId,
        snapshotFileCount: gate.approvedSnapshot.length,
      },
      publishVersionId !== null
        ? "Production publish: using explicit approved versionId snapshot"
        : "Production publish: using approved testedSnapshotId snapshot",
    );
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

  // ── Validation gate: block production publish on completed_with_errors ──────
  // When the latest build snapshot has validation_status="completed_with_errors"
  // the agentic repair loop exhausted all attempts. Require explicit opt-in via
  // forcePublishWithErrors=true to allow publishing with known TypeScript errors.
  if (env === "production" && !publishVersionId) {
    try {
      const [latestVersion] = await db
        .select({ validationStatus: projectVersionsTable.validationStatus })
        .from(projectVersionsTable)
        .where(eq(projectVersionsTable.projectId, projectId))
        .orderBy(desc(projectVersionsTable.createdAt))
        .limit(1);
      if (latestVersion?.validationStatus === "completed_with_errors") {
        const force = (req.body as Record<string, unknown>)?.forcePublishWithErrors === true;
        if (!force) {
          res.status(422).json({
            error:
              "The latest build completed with TypeScript errors that could not be auto-repaired. Fix the errors before publishing to production, or pass forcePublishWithErrors=true to override.",
            code: "completed_with_errors",
          });
          return;
        }
      }
    } catch (validationGateErr) {
      req.log.warn(
        { err: validationGateErr, projectId },
        "Validation gate check failed (non-fatal) — proceeding with publish",
      );
    }
  }

  // ── Validation gate: warn on passed_with_warnings ─────────────────────────
  // Non-required checks (e.g. TypeScript typecheck in constrained containers)
  // failed but required checks passed. Preview works, but the build is not
  // fully clean. Require explicit opt-in via forcePublishWithWarnings=true.
  if (env === "production" && !publishVersionId) {
    try {
      const [latestVersion] = await db
        .select({ validationStatus: projectVersionsTable.validationStatus })
        .from(projectVersionsTable)
        .where(eq(projectVersionsTable.projectId, projectId))
        .orderBy(desc(projectVersionsTable.createdAt))
        .limit(1);
      if (latestVersion?.validationStatus === "passed_with_warnings") {
        const force = (req.body as Record<string, unknown>)?.forcePublishWithWarnings === true;
        if (!force) {
          res.status(422).json({
            error:
              "The latest build completed with validation warnings (non-blocking checks failed). The preview is functional, but the build is not fully clean. Fix the warnings before publishing, or pass forcePublishWithWarnings=true to override.",
            code: "passed_with_warnings",
          });
          return;
        }
      }
    } catch (warningGateErr) {
      req.log.warn(
        { err: warningGateErr, projectId },
        "Warning gate check failed (non-fatal) — proceeding with publish",
      );
    }
  }

  // Hard invariant: for production, the gate above must always set approvedSnapshot.
  // If it is somehow null here (code-path bug or future regression), block rather than
  // silently falling back to the mutable project_files draft.
  if (env === "production" && approvedSnapshot === null) {
    req.log.error(
      { projectId, publishVersionId },
      "Production publish: gate passed but approvedSnapshot is null — invariant violated, blocking",
    );
    res.status(500).json({
      error: "Internal error: approved snapshot unavailable for production publish.",
      code: "internal_error",
    });
    return;
  }

  // For production: always use the frozen approved snapshot (set by the gate above).
  // For staging: approvedSnapshot is null → fall back to the current project_files draft.
  // This is the only code path that may read project_files, and only for staging.
  const files = approvedSnapshot
    ? approvedSnapshot.map((f) => ({
        id: 0,
        projectId,
        path: f.path,
        content: f.content,
        mimeType: f.mimeType,
        createdAt: new Date(),
        updatedAt: new Date(),
      }))
    : await db.select().from(projectFilesTable).where(eq(projectFilesTable.projectId, projectId));

  if (files.length === 0) {
    res.status(400).json({
      error: "Cannot publish a project with no generated files. Build the app first.",
    });
    return;
  }

  // ── Hard block: schema-changing SQL migrations ────────────────────────────
  // v1 policy: no automated schema changes allowed in production publishes.
  // Operators must run migrations out-of-band and ensure DB schema matches
  // the code before publishing. No confirmation checkbox — this is a hard block.
  if (env === "production") {
    const migrationViolations = detectSchemaMigrations(files);
    if (migrationViolations.length > 0) {
      req.log.warn(
        { projectId, files: migrationViolations },
        "Publish blocked: schema-changing SQL migrations detected in snapshot",
      );
      res.status(422).json({
        error:
          `Publish blocked: ${migrationViolations.length} file(s) contain schema-changing SQL ` +
          `(ALTER TABLE, DROP TABLE, DROP COLUMN, TRUNCATE, etc.). ` +
          `Run database migrations out-of-band and remove or guard them before publishing to production.`,
        code: "schema_migration_detected",
        files: migrationViolations,
      });
      return;
    }
  }

  // ── Content safety scan — phishing + malware patterns ─────────────────────
  // Only applied to production publishes (staging is a dev artefact).
  // Admins can bypass by passing overrideSafetyCheck: true in the request body
  // — the override is only honoured when the caller is a platform admin.
  const overrideSafetyRequested =
    (req.body as Record<string, unknown>)?.overrideSafetyCheck === true;
  const overrideSafety =
    overrideSafetyRequested && req.userId ? await isAdminUser(req.userId) : false;
  if (env === "production" && !overrideSafety) {
    const scanResult = scanContent(
      files.map((f) => ({
        path: f.path,
        content: f.content ?? "",
        mimeType: f.mimeType ?? undefined,
      })),
    );
    if (!scanResult.ok) {
      req.log.warn(
        { projectId, violations: scanResult.violations },
        "Content safety scan blocked publish",
      );
      res.status(422).json({
        error: `Publish blocked: content safety scan found ${scanResult.violations.filter((v) => v.severity === "block").length} violation(s). Review it or report a false positive at /help?mode=report.`,
        code: "content_safety_violation",
        violations: scanResult.violations
          .filter((v) => v.severity === "block")
          .map((v) => ({
            pattern: v.pattern,
            context: v.context,
          })),
      });
      return;
    }
    // Log warnings but don't block
    const warnViolations = scanResult.violations.filter((v) => v.severity === "warn");
    if (warnViolations.length > 0) {
      req.log.warn(
        { projectId, warnViolations },
        "Content safety scan found warnings (not blocking)",
      );
    }
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

    // ── Edge CDN: upload to R2 + sync KV (staging subdomain) ─────────────────
    if (deploymentVersion?.id) {
      const snapshotFiles: SnapshotFile[] = files.map((f) => ({
        path: f.path,
        content: f.content,
        mimeType: f.mimeType,
      }));
      // Edge CDN ordering — order matters for consistency:
      //   1. Upload snapshot to R2 FIRST. Only when files exist in R2 is it safe
      //      to advance the Worker's KV routing to the new versionId. Updating KV
      //      before upload would direct edge traffic to a non-existent key → 404s.
      //   2. Update KV routing (awaited, with 5 s bound). Errors are logged but
      //      don't fail publish — DB snapshot fallback keeps the site accessible.
      //   3. Purge CF edge cache async/best-effort (stale HTML is served briefly
      //      if this fails; hashed assets are immutable and don't need purging).
      const maintenanceFile = files.find((f) => f.path === "maintenance.html");
      void uploadMaintenancePage(projectId, maintenanceFile?.content).catch(() => {
        /* best-effort — doesn't affect routing */
      });
      const r2Ok = await uploadSnapshotToR2(projectId, deploymentVersion.id, snapshotFiles);
      if (r2Enabled() && !r2Ok) {
        req.log.warn(
          { projectId, versionId: deploymentVersion.id },
          "R2 upload failed for staging snapshot; skipping KV routing update to prevent edge 404s",
        );
      } else {
        try {
          await Promise.race([
            syncAllHostnamesKV({
              projectId,
              publicSlug: `${slug}-staging`,
              versionId: deploymentVersion.id,
              customDomains: [],
              preferredRegion: project.preferredRegion ?? null,
              errorPage404: project.errorPage404 ?? null,
              errorPage500: project.errorPage500 ?? null,
            }),
            new Promise<void>((resolve) => setTimeout(resolve, 5000)),
          ]);
        } catch (err) {
          req.log.warn(
            { err, projectId },
            "KV sync failed for staging publish; edge routing may be stale until TTL expires",
          );
        }
      }
    }

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

  // ── Gate: autoscale requires Core/pro/team subscription ──────────────────
  const deploymentType = project.deploymentType ?? "static";
  if (env === "production" && deploymentType === "autoscale" && project.ownerId) {
    const [ownerSub] = await db
      .select({ tier: userSubscriptionsTable.tier })
      .from(userSubscriptionsTable)
      .where(eq(userSubscriptionsTable.userId, project.ownerId))
      .limit(1);
    const ownerTier = ownerSub?.tier ?? "free";
    if (ownerTier === "free") {
      res.status(403).json({
        error: "Autoscale requires NabuFlow Core",
        upgradeUrl: "/billing",
        code: "autoscale_requires_core",
      });
      return;
    }
  }

  // Task #543: respect deployment type. "static" never deploys a container,
  // even if the project has a dev container. "autoscale" + "reserved_vm"
  // both go through the blue/green path; container.ts reads the type to
  // set min_machines_running appropriately.
  const shouldDeployContainer =
    deploymentType !== "static" && !!project.containerId && !!process.env.FLY_API_TOKEN;

  if (shouldDeployContainer) {
    req.log.info({ projectId }, "Project has dev container — deploying production container");
    try {
      // SECURITY: Only inject secrets with environment='production' into production containers.
      // Development and testing secrets must never reach the production environment.
      const secretRows = await db
        .select({ name: secretsTable.name, valueEncrypted: secretsTable.valueEncrypted })
        .from(secretsTable)
        .where(
          and(eq(secretsTable.projectId, projectId), eq(secretsTable.environment, "production")),
        );

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
      req.log.error({ err, projectId }, "Prod container deployment failed");
    }
  }

  // ── Blue/green safety: container deploy required but failed ───────────────
  // Refuse to update publishedSnapshotId if the container never became healthy.
  // The old production container (if any) is still serving traffic — preserve it.
  if (shouldDeployContainer && !containerDeployed) {
    req.log.error(
      { projectId, prodContainerId: project.prodContainerId },
      "Publish aborted: container deploy failed and no fallback allowed",
    );
    res.status(500).json({
      error:
        "Production container deployment failed — the health check did not pass within the timeout. " +
        "The existing production version has been preserved. " +
        "Check the deployment logs for details.",
      code: "container_deploy_failed",
    });
    return;
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

  // ── Edge CDN: upload to R2, sync KV, purge cache ──────────────────────────
  if (deploymentVersion?.id) {
    const snapshotId = deploymentVersion.id;
    const snapshotFiles: SnapshotFile[] = files.map((f) => ({
      path: f.path,
      content: f.content,
      mimeType: f.mimeType,
    }));

    // Fetch custom domains for this project (verified only)
    const customDomainRows = await db
      .select({ hostname: projectDomainsTable.hostname })
      .from(projectDomainsTable)
      .where(
        and(
          eq(projectDomainsTable.projectId, projectId),
          eq(projectDomainsTable.verificationStatus, "verified"),
        ),
      )
      .catch(() => [] as { hostname: string }[]);
    const customDomains = customDomainRows.map((r) => r.hostname);

    // Edge CDN ordering — order matters for consistency:
    //   1. Upload snapshot to R2 FIRST (gate KV on success when R2 is configured).
    //   2. Update KV routing (awaited, 5 s bound, explicit failure logging).
    //   3. Purge CF edge cache async/best-effort after routing is live.
    const maintenanceFile = files.find((f) => f.path === "maintenance.html");
    void uploadMaintenancePage(projectId, maintenanceFile?.content).catch(() => {
      /* best-effort — doesn't affect routing */
    });
    const r2Ok = await uploadSnapshotToR2(projectId, snapshotId, snapshotFiles);
    if (r2Enabled() && !r2Ok) {
      req.log.warn(
        { projectId, snapshotId },
        "R2 upload failed for production snapshot; skipping KV routing update to prevent edge 404s",
      );
    } else {
      try {
        await Promise.race([
          syncAllHostnamesKV({
            projectId,
            publicSlug: slug,
            versionId: snapshotId,
            customDomains,
            preferredRegion: project.preferredRegion ?? null,
            errorPage404: project.errorPage404 ?? null,
            errorPage500: project.errorPage500 ?? null,
          }),
          new Promise<void>((resolve) => setTimeout(resolve, 5000)),
        ]);
      } catch (err) {
        req.log.warn(
          { err, projectId },
          "KV sync failed for production publish; edge routing may be stale until TTL expires",
        );
      }
      // Purge after KV is updated so CDN cache is cleared only when routing is live.
      setImmediate(() => {
        void purgeCacheForProject({ publicSlug: slug, customDomains }).catch(() => {
          /* best-effort */
        });
      });
    }
  }

  void writeKnowledge({
    title: `Published: project ${projectId}`,
    content: `Project id:${projectId} published by ${req.userId ?? "unknown"}. Slug: ${slug}. Container deployed: ${containerDeployed}.`,
    type: "publish",
    category: "event",
    severity: "info",
    projectId,
    userId: req.userId,
  });

  // Notify all org members with at least viewer access (fire-and-forget)
  if (project.organizationId && req.userId) {
    const publisherId = req.userId;
    const projectName = project.name;
    const projectSlug = slug;
    const orgId = project.organizationId;
    setImmediate(() => {
      void (async () => {
        try {
          const members = await db
            .select({ userId: orgMembersTable.userId })
            .from(orgMembersTable)
            .where(
              and(
                eq(orgMembersTable.organizationId, orgId),
                // all roles (viewer|member|admin|owner) have at least viewer access
              ),
            );
          const recipients = members.map((m) => m.userId).filter((uid) => uid !== publisherId);
          if (recipients.length === 0) return;
          await db.insert(notificationsTable).values(
            recipients.map((uid) => ({
              recipientId: uid,
              type: "project_published",
              title: `"${projectName}" was published`,
              body: `A new version is live at ${projectSlug}.${PLATFORM_DOMAIN}`,
              actorId: publisherId,
              resourceType: "project",
              resourceId: String(projectId),
              projectId,
              metadata: { projectId, projectName, slug: projectSlug },
            })),
          );
        } catch (err) {
          // best-effort — don't fail publish over notification errors
          void err;
        }
      })();
    });
  }

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

  // ── Staging promotion security gate ───────────────────────────────────────
  // Require: testingStatus=passed, testedSnapshotId===stagingPublishedSnapshotId,
  // and the staging version must have testingApprovedAt.
  // This closes the path where a draft is published to staging and promoted
  // directly to production without passing the test + approval gate.
  {
    const [stagingVersionForGate] = await db
      .select({ testingApprovedAt: projectVersionsTable.testingApprovedAt })
      .from(projectVersionsTable)
      .where(eq(projectVersionsTable.id, project.stagingPublishedSnapshotId));
    const promotionGateResult = evaluatePromotionGate(
      {
        testingStatus: project.testingStatus ?? "idle",
        testedSnapshotId: project.testedSnapshotId ?? null,
        stagingPublishedSnapshotId: project.stagingPublishedSnapshotId,
      },
      stagingVersionForGate ?? null,
    );
    if (!promotionGateResult.ok) {
      res.status(promotionGateResult.status).json({
        error: promotionGateResult.error,
        code: promotionGateResult.code,
        ...promotionGateResult.extra,
      });
      return;
    }
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

  // ── Edge CDN: sync KV + purge cache for promoted version ──────────────────
  setImmediate(() => {
    void (async () => {
      try {
        const customDomainRows = await db
          .select({ hostname: projectDomainsTable.hostname })
          .from(projectDomainsTable)
          .where(
            and(
              eq(projectDomainsTable.projectId, projectId),
              eq(projectDomainsTable.verificationStatus, "verified"),
            ),
          );
        const customDomains = customDomainRows.map((r) => r.hostname);
        await syncAllHostnamesKV({
          projectId,
          publicSlug: slug,
          versionId: project.stagingPublishedSnapshotId!,
          customDomains,
          preferredRegion: project.preferredRegion ?? null,
          errorPage404: project.errorPage404 ?? null,
          errorPage500: project.errorPage500 ?? null,
        });
        await purgeCacheForProject({ publicSlug: slug, customDomains });
      } catch {
        /* best-effort */
      }
    })();
  });

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

  // ── Edge CDN: clear KV entries + purge cache on unpublish ─────────────────
  setImmediate(() => {
    void (async () => {
      try {
        const slug = current?.publicSlug ?? null;
        const customDomainRows = await db
          .select({ hostname: projectDomainsTable.hostname })
          .from(projectDomainsTable)
          .where(
            and(
              eq(projectDomainsTable.projectId, projectId),
              eq(projectDomainsTable.verificationStatus, "verified"),
            ),
          );
        const customDomains = customDomainRows.map((r) => r.hostname);
        // Clear KV entries (pass versionId=null to trigger deletion)
        await syncAllHostnamesKV({
          projectId,
          publicSlug: slug,
          versionId: null,
          customDomains,
        });
        await purgeCacheForProject({ publicSlug: slug, customDomains });
      } catch {
        /* best-effort */
      }
    })();
  });

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

// ── POST /api/projects/:id/preview-link ──────────────────────────────────────
// Creates a shareable, time-limited preview link from the current project files.
// Snapshots files into a project_versions row (environment="preview") and a
// preview_snapshots row with a 7-day expiry. The URL is served by the existing
// /api/p/:slug/ route just like any other preview snapshot.
router.post(
  "/projects/:id/preview-link",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);

    const [project] = await db
      .select({ id: projectsTable.id, name: projectsTable.name })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const files = await db
      .select({
        path: projectFilesTable.path,
        content: projectFilesTable.content,
        mimeType: projectFilesTable.mimeType,
      })
      .from(projectFilesTable)
      .where(eq(projectFilesTable.projectId, projectId));

    if (files.length === 0) {
      res.status(400).json({ error: "No files found. Build the app first." });
      return;
    }

    const filesSnapshot = files.map((f) => ({
      path: f.path,
      content: f.content,
      mimeType: f.mimeType ?? undefined,
    }));

    const label = `Preview link — ${new Date().toISOString().slice(0, 10)}`;

    const [version] = await db
      .insert(projectVersionsTable)
      .values({
        projectId,
        label,
        filesSnapshot,
        environment: "preview",
      })
      .returning({ id: projectVersionsTable.id });

    if (!version) {
      res.status(500).json({ error: "Failed to create version snapshot" });
      return;
    }

    // Use a hex slug so it cannot be guessed
    const previewSlug = `${
      project.name
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .slice(0, 16) || "preview"
    }-lnk-${randomBytes(8).toString("hex")}`;
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const [snap] = await db
      .insert(previewSnapshotsTable)
      .values({
        projectId,
        versionId: version.id,
        previewSlug,
        expiresAt,
      })
      .returning({ id: previewSnapshotsTable.id, previewSlug: previewSnapshotsTable.previewSlug });

    if (!snap) {
      res.status(500).json({ error: "Failed to create preview snapshot record" });
      return;
    }

    const internalUrl = `/api/p/${snap.previewSlug}/preview/`;
    const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN ?? "mustaflow.app";
    const previewUrl = `https://${snap.previewSlug}.${PLATFORM_DOMAIN}/`;

    res.json({
      ok: true,
      previewSlug: snap.previewSlug,
      previewUrl,
      internalUrl,
      expiresAt: expiresAt.toISOString(),
      versionId: version.id,
    });
  },
);

// ── POST /api/projects/:id/maintenance ───────────────────────────────────────
// Toggle the Cloudflare edge CDN maintenance mode for a project.
// When enabled=true the Worker serves the maintenance page for all hostnames.
// Requires the project to already be published (KV entries must exist).
router.post(
  "/projects/:id/maintenance",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const { enabled } = req.body as { enabled?: unknown };
    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: "`enabled` must be a boolean" });
      return;
    }

    const [project] = await db
      .select({
        publicSlug: projectsTable.publicSlug,
      })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    // Collect all hostnames for this project (platform subdomain + custom domains)
    const customDomainRows = await db
      .select({ hostname: projectDomainsTable.hostname })
      .from(projectDomainsTable)
      .where(
        and(
          eq(projectDomainsTable.projectId, projectId),
          eq(projectDomainsTable.verificationStatus, "verified"),
        ),
      )
      .catch(() => [] as { hostname: string }[]);

    const hostnames: string[] = customDomainRows.map((r) => r.hostname);
    if (project.publicSlug) {
      hostnames.push(`${project.publicSlug}.${PLATFORM_DOMAIN}`);
    }

    // Update KV entries best-effort (no-op when CF_KV_NAMESPACE_ID is not set)
    void setProjectMaintenanceMode(hostnames, enabled).catch(() => {
      /* best-effort */
    });

    res.json({ ok: true, projectId, maintenanceEnabled: enabled, hostnamesUpdated: hostnames });
  },
);

export default router;
