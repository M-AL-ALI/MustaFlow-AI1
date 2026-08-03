import { Router, type IRouter } from "express";
import { eq, and, desc, inArray, isNull } from "drizzle-orm";
import {
  db,
  cveFindingsTable,
  securityFindingsTable,
  projectFilesTable,
  projectVersionsTable,
  projectsTable,
  type SecurityFindingStatus,
  type SecurityFindingSeverity,
} from "@workspace/db";
import type { CveSeverity, CveStatus, CvePatchStatus } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { generateSbom } from "../lib/sbom";
import { getAuth } from "@clerk/express";
import { logger } from "../lib/logger";
import { runCveAudit } from "../lib/checks/cve-scanner";
import { getCveScanStatus, recordScanResult, acknowledgeNewFindings } from "../lib/cve-scheduler";
import { enqueueCveAutoProtectJob } from "../lib/jobs";
import { exec } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";
import path from "path";

const execAsync = promisify(exec);

const router: IRouter = Router();

/**
 * GET /api/security/cve
 * List stored CVE findings. Optionally filter by status.
 */
router.get("/security/cve", async (req, res): Promise<void> => {
  if (!req.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const statusFilter = req.query.status as string | undefined;

  try {
    const rows = await db
      .select()
      .from(cveFindingsTable)
      .where(statusFilter ? eq(cveFindingsTable.status, statusFilter as CveStatus) : undefined)
      .orderBy(cveFindingsTable.detectedAt);

    res.json(rows);
  } catch (err) {
    logger.error({ err }, "Failed to list CVE findings");
    res.status(500).json({ error: "Failed to list CVE findings" });
  }
});

/**
 * GET /api/security/cve/scan-status
 * Returns the last scan timestamp and critical/high counts.
 * Calling this endpoint acknowledges any pending "new findings" notification.
 */
router.get("/security/cve/scan-status", async (req, res): Promise<void> => {
  if (!req.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const status = getCveScanStatus();
  res.json(status);
});

/**
 * POST /api/security/cve/scan-status/acknowledge
 * Resets the newCriticalHighSinceLastScan counter so the notification clears.
 */
router.post("/security/cve/scan-status/acknowledge", async (req, res): Promise<void> => {
  if (!req.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  acknowledgeNewFindings();
  res.json({ acknowledged: true });
});

/**
 * POST /api/security/cve/scan
 * Trigger a fresh npm audit scan, upsert results into DB, return findings.
 * Automatically enqueues CVE auto-protect jobs for new critical findings.
 */
router.post("/security/cve/scan", async (req, res): Promise<void> => {
  if (!req.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  try {
    const advisories = await runCveAudit();

    await db
      .update(cveFindingsTable)
      .set({ status: "fixed" as CveStatus })
      .where(eq(cveFindingsTable.status, "open" as CveStatus));

    if (advisories.length === 0) {
      recordScanResult([]);
      res.json({ scanned: true, findings: [], total: 0 });
      return;
    }

    const inserted = await db
      .insert(cveFindingsTable)
      .values(
        advisories.map((a) => ({
          severity: a.severity as CveSeverity,
          packageName: a.packageName,
          currentVersion: a.currentVersion ?? null,
          patchedVersion: a.patchedVersion ?? null,
          cveId: a.cveId ?? null,
          title: a.title,
          advisoryUrl: a.advisoryUrl ?? null,
          status: "open" as CveStatus,
        })),
      )
      .returning();

    for (const finding of inserted) {
      if (finding.severity === "critical" || finding.severity === "high") {
        enqueueCveAutoProtectJob({ findingId: finding.id, projectId: finding.projectId });
      }
    }

    const criticalCount = inserted.filter(
      (f) => f.severity === "critical" || f.severity === "high",
    ).length;
    if (criticalCount > 0) {
      logger.info({ criticalCount }, "CVE auto-protect jobs enqueued for critical/high findings");
    }

    recordScanResult(inserted);
    res.json({ scanned: true, findings: inserted, total: inserted.length });
  } catch (err) {
    logger.error({ err }, "CVE scan failed");
    res.status(500).json({ error: "CVE scan failed" });
  }
});

/**
 * PATCH /api/security/cve/:id/dismiss
 * Dismiss a specific CVE finding.
 */
router.patch("/security/cve/:id/dismiss", async (req, res): Promise<void> => {
  if (!req.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const findingId = Number(req.params.id);
  if (!Number.isFinite(findingId)) {
    res.status(400).json({ error: "Invalid finding id" });
    return;
  }

  try {
    const [updated] = await db
      .update(cveFindingsTable)
      .set({
        status: "dismissed" as CveStatus,
        dismissedAt: new Date(),
        dismissedBy: req.userId,
      })
      .where(eq(cveFindingsTable.id, findingId))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Finding not found" });
      return;
    }

    res.json(updated);
  } catch (err) {
    logger.error({ err, findingId }, "Failed to dismiss CVE finding");
    res.status(500).json({ error: "Failed to dismiss finding" });
  }
});

/**
 * GET /projects/:id/security-findings
 * List all security findings for a project, filterable by status and severity.
 */
router.get(
  "/projects/:id/security-findings",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (!Number.isFinite(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }

    const statusFilter = req.query.status as string | undefined;
    const severityFilter = req.query.severity as string | undefined;

    const validStatuses = ["open", "dismissed", "fixed"] as const;
    const validSeverities = ["critical", "high", "medium", "low", "info"] as const;

    try {
      const conditions = [eq(securityFindingsTable.projectId, projectId)];

      if (statusFilter && validStatuses.includes(statusFilter as (typeof validStatuses)[number])) {
        conditions.push(eq(securityFindingsTable.status, statusFilter as SecurityFindingStatus));
      }

      if (
        severityFilter &&
        validSeverities.includes(severityFilter as (typeof validSeverities)[number])
      ) {
        conditions.push(
          eq(securityFindingsTable.severity, severityFilter as SecurityFindingSeverity),
        );
      }

      const findings = await db
        .select()
        .from(securityFindingsTable)
        .where(and(...conditions))
        .orderBy(desc(securityFindingsTable.lastSeenAt));

      res.json(findings);
    } catch (err) {
      logger.error({ err, projectId }, "Failed to fetch security findings");
      res.status(500).json({ error: "Failed to fetch security findings" });
    }
  },
);

/**
 * POST /projects/:id/security-findings/:findingId/dismiss
 * Dismiss a security finding.
 */
router.post(
  "/projects/:id/security-findings/:findingId/dismiss",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const findingId = Number(req.params.findingId);

    if (!Number.isFinite(projectId) || !Number.isFinite(findingId)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const { userId } = getAuth(req);
    const now = new Date();

    try {
      const [finding] = await db
        .select()
        .from(securityFindingsTable)
        .where(
          and(
            eq(securityFindingsTable.id, findingId),
            eq(securityFindingsTable.projectId, projectId),
          ),
        );

      if (!finding) {
        res.status(404).json({ error: "Finding not found" });
        return;
      }

      const [updated] = await db
        .update(securityFindingsTable)
        .set({
          status: "dismissed",
          dismissedBy: userId ?? "unknown",
          dismissedAt: now,
        })
        .where(eq(securityFindingsTable.id, findingId))
        .returning();

      res.json(updated);
    } catch (err) {
      logger.error({ err, projectId, findingId }, "Failed to dismiss security finding");
      res.status(500).json({ error: "Failed to dismiss security finding" });
    }
  },
);

/**
 * GET /security/findings
 * Cross-project security findings for the authenticated user.
 * Sorted by severity × exposure (published projects first).
 */
router.get("/security/findings", async (req, res): Promise<void> => {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const statusFilter = (req.query.status as string) || "open";

  const SEVERITY_ORDER: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    info: 4,
  };

  try {
    const projects = await db
      .select({
        id: projectsTable.id,
        name: projectsTable.name,
        status: projectsTable.status,
        publishedSnapshotId: projectsTable.publishedSnapshotId,
        publicSlug: projectsTable.publicSlug,
      })
      .from(projectsTable)
      .where(and(eq(projectsTable.ownerId, userId), isNull(projectsTable.deletedAt)));

    if (projects.length === 0) {
      res.json({ findings: [], summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 } });
      return;
    }

    const projectIds = projects.map((p) => p.id);
    const projectMap = new Map(projects.map((p) => [p.id, p]));

    const conditions = [inArray(securityFindingsTable.projectId, projectIds)];
    if (statusFilter && ["open", "dismissed", "fixed"].includes(statusFilter)) {
      conditions.push(eq(securityFindingsTable.status, statusFilter as SecurityFindingStatus));
    }

    const rawFindings = await db
      .select()
      .from(securityFindingsTable)
      .where(and(...conditions))
      .orderBy(desc(securityFindingsTable.lastSeenAt));

    // Enrich with project info and sort: published projects first, then by severity
    const enriched = rawFindings.map((f) => {
      const proj = projectMap.get(f.projectId);
      return {
        ...f,
        projectName: proj?.name ?? "Unknown",
        projectStatus: proj?.status ?? "draft",
        isPublished: !!proj?.publishedSnapshotId,
        publicSlug: proj?.publicSlug ?? null,
      };
    });

    enriched.sort((a, b) => {
      if (a.isPublished !== b.isPublished) return a.isPublished ? -1 : 1;
      return (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99);
    });

    // Compute summary counts
    const summary = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const f of enriched) {
      if (f.status === "open" && f.severity in summary) {
        summary[f.severity as keyof typeof summary]++;
      }
    }

    res.json({ findings: enriched, summary });
  } catch (err) {
    logger.error({ err, userId }, "Failed to fetch account security findings");
    res.status(500).json({ error: "Failed to fetch account security findings" });
  }
});

/**
 * GET /security/badge
 * Returns the count of open critical+high findings for the badge.
 */
router.get("/security/badge", async (req, res): Promise<void> => {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const projects = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(and(eq(projectsTable.ownerId, userId), isNull(projectsTable.deletedAt)));

    if (projects.length === 0) {
      res.json({ count: 0 });
      return;
    }

    const projectIds = projects.map((p) => p.id);

    const findings = await db
      .select({ id: securityFindingsTable.id })
      .from(securityFindingsTable)
      .where(
        and(
          inArray(securityFindingsTable.projectId, projectIds),
          eq(securityFindingsTable.status, "open"),
          inArray(securityFindingsTable.severity, ["critical", "high"]),
        ),
      );

    res.json({ count: findings.length });
  } catch (err) {
    logger.error({ err, userId }, "Failed to fetch security badge count");
    res.status(500).json({ error: "Failed to fetch badge count" });
  }
});

/**
 * GET /security/badge/by-project
 * Returns open critical+high finding counts grouped by projectId.
 */
router.get("/security/badge/by-project", async (req, res): Promise<void> => {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const projects = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(and(eq(projectsTable.ownerId, userId), isNull(projectsTable.deletedAt)));

    if (projects.length === 0) {
      res.json({ counts: {} });
      return;
    }

    const projectIds = projects.map((p) => p.id);

    const findings = await db
      .select({ projectId: securityFindingsTable.projectId })
      .from(securityFindingsTable)
      .where(
        and(
          inArray(securityFindingsTable.projectId, projectIds),
          eq(securityFindingsTable.status, "open"),
          inArray(securityFindingsTable.severity, ["critical", "high"]),
        ),
      );

    const counts: Record<string, number> = {};
    for (const f of findings) {
      const key = String(f.projectId);
      counts[key] = (counts[key] ?? 0) + 1;
    }

    res.json({ counts });
  } catch (err) {
    logger.error({ err, userId }, "Failed to fetch per-project security badge counts");
    res.status(500).json({ error: "Failed to fetch per-project badge counts" });
  }
});

interface NpmLsPackage {
  version?: string;
  dependencies?: Record<string, NpmLsPackage>;
}

interface NpmLsOutput {
  name?: string;
  version?: string;
  dependencies?: Record<string, NpmLsPackage>;
}

function collectPackages(deps: Record<string, NpmLsPackage>, seen: Map<string, string>): void {
  for (const [name, pkg] of Object.entries(deps)) {
    if (!pkg.version) continue;
    const key = `${name}@${pkg.version}`;
    if (!seen.has(key)) {
      seen.set(key, pkg.version);
    }
    if (pkg.dependencies) {
      collectPackages(pkg.dependencies, seen);
    }
  }
}

/**
 * GET /security/sbom
 * Generate and download a CycloneDX 1.4 SBOM for the workspace dependencies.
 */
router.get("/security/sbom", async (req, res): Promise<void> => {
  if (!req.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  try {
    const workspaceRoot = path.resolve(process.cwd(), "../..");
    const { stdout } = await execAsync("npm ls --json --all --omit=dev", {
      cwd: workspaceRoot,
      timeout: 30_000,
    }).catch(async () => {
      return execAsync("npm ls --json --all", { cwd: workspaceRoot, timeout: 30_000 }).catch(
        async () => {
          return execAsync("pnpm ls --json --depth=Infinity", {
            cwd: workspaceRoot,
            timeout: 30_000,
          });
        },
      );
    });

    let parsed: NpmLsOutput | NpmLsOutput[] = {};
    try {
      parsed = JSON.parse(stdout) as NpmLsOutput | NpmLsOutput[];
    } catch {
      logger.warn("SBOM: Could not parse npm ls output, using empty dependency list");
    }

    const seen = new Map<string, string>();

    const roots = Array.isArray(parsed) ? parsed : [parsed];
    for (const root of roots) {
      if (root.dependencies) {
        collectPackages(root.dependencies, seen);
      }
    }

    const components = [...seen.entries()].map(([nameAtVersion, version]) => {
      const name = nameAtVersion.slice(0, nameAtVersion.lastIndexOf("@"));
      const safeName = name.startsWith("@") ? name : name;
      return {
        type: "library",
        name,
        version,
        purl: `pkg:npm/${encodeURIComponent(safeName)}@${encodeURIComponent(version)}`,
      };
    });

    components.sort((a, b) => a.name.localeCompare(b.name));

    const sbom = {
      bomFormat: "CycloneDX",
      specVersion: "1.4",
      serialNumber: `urn:uuid:${randomUUID()}`,
      version: 1,
      metadata: {
        timestamp: new Date().toISOString(),
        tools: [
          {
            vendor: "MustaFlow",
            name: "NabuFlow SBOM Generator",
            version: "1.0.0",
          },
        ],
        component: {
          type: "application",
          name: "mustaflow",
          version: "1.0.0",
        },
      },
      components,
    };

    const filename = `mustaflow-sbom-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", "application/json");
    res.json(sbom);
  } catch (err) {
    logger.error({ err }, "SBOM generation failed");
    res.status(500).json({ error: "SBOM generation failed" });
  }
});

/**
 * GET /api/projects/:id/sbom
 * Generate and download a CycloneDX 1.5 SBOM for a project.
 */
router.get("/projects/:id/sbom", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  if (!Number.isFinite(projectId)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }

  try {
    const [project] = await db
      .select({ id: projectsTable.id, name: projectsTable.name })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId));

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

    const sbom = generateSbom(project.name, files);

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="sbom-${projectId}.json"`);
    res.json(sbom);
  } catch (err) {
    logger.error({ err, projectId }, "Failed to generate SBOM");
    res.status(500).json({ error: "Failed to generate SBOM" });
  }
});

/**
 * POST /api/security/cve/:id/apply-patch
 * Apply the prepared patch for a CVE finding.
 * If the finding has a projectId, writes the patched file(s) to project_files
 * and creates a version snapshot. Otherwise, the patch is informational only.
 */
router.post("/security/cve/:id/apply-patch", async (req, res): Promise<void> => {
  if (!req.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const findingId = Number(req.params.id);
  if (!Number.isFinite(findingId)) {
    res.status(400).json({ error: "Invalid finding id" });
    return;
  }

  try {
    const [finding] = await db
      .select()
      .from(cveFindingsTable)
      .where(eq(cveFindingsTable.id, findingId))
      .limit(1);

    if (!finding) {
      res.status(404).json({ error: "Finding not found" });
      return;
    }

    if (finding.patchStatus !== "ready") {
      res.status(400).json({ error: "Patch is not ready to apply" });
      return;
    }

    if (!finding.patchContent) {
      res.status(400).json({ error: "No patch content available" });
      return;
    }

    let parsedPatch: { files?: Array<{ path: string; content: string }>; summary?: string };
    try {
      parsedPatch = JSON.parse(finding.patchContent) as typeof parsedPatch;
    } catch {
      res.status(500).json({ error: "Invalid patch content format" });
      return;
    }

    const patchFiles = parsedPatch.files ?? [];

    if (finding.projectId && patchFiles.length > 0) {
      const existingFiles = await db
        .select()
        .from(projectFilesTable)
        .where(eq(projectFilesTable.projectId, finding.projectId));

      const snapshotEntries = existingFiles.map((f) => ({
        path: f.path,
        content: f.content,
        mimeType: f.mimeType,
      }));

      await db.insert(projectVersionsTable).values({
        projectId: finding.projectId,
        label: `CVE patch: ${finding.packageName}${finding.cveId ? ` (${finding.cveId})` : ""}`,
        filesSnapshot: snapshotEntries,
        note: `Auto-protect patch applied by ${req.userId}`,
      });

      for (const patchFile of patchFiles) {
        const existing = existingFiles.find((f) => f.path === patchFile.path);
        if (existing) {
          await db
            .update(projectFilesTable)
            .set({ content: patchFile.content })
            .where(
              and(
                eq(projectFilesTable.projectId, finding.projectId),
                eq(projectFilesTable.path, patchFile.path),
              ),
            );
        } else {
          await db.insert(projectFilesTable).values({
            projectId: finding.projectId,
            path: patchFile.path,
            content: patchFile.content,
            mimeType: patchFile.path.endsWith(".json") ? "application/json" : "text/plain",
          });
        }
      }
    }

    const [updated] = await db
      .update(cveFindingsTable)
      .set({
        patchStatus: "applied" as CvePatchStatus,
        status: "fixed" as CveStatus,
        patchAppliedAt: new Date(),
      })
      .where(eq(cveFindingsTable.id, findingId))
      .returning();

    logger.info({ findingId, projectId: finding.projectId }, "CVE patch applied");
    res.json(updated);
  } catch (err) {
    logger.error({ err, findingId }, "Failed to apply CVE patch");
    res.status(500).json({ error: "Failed to apply patch" });
  }
});

export default router;
