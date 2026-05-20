/**
 * Package management routes.
 *
 * POST /api/projects/:id/packages/install   — add an npm package (exec in container if running, patch package.json in DB)
 * POST /api/projects/:id/packages/uninstall — remove an npm package (exec in container if running, patch package.json in DB)
 */

import { Router, type IRouter } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db, projectsTable, projectFilesTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { execInContainer } from "../lib/container";

const router: IRouter = Router();

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
};

/** Validate that a package name is non-empty and has no shell-injection characters. */
function isValidPackageName(name: unknown): name is string {
  if (typeof name !== "string" || name.trim().length === 0) return false;
  // Allow letters, digits, @, /, -, _, and dots — covers scoped packages like @scope/pkg
  return /^[@a-zA-Z0-9][a-zA-Z0-9@/._-]*$/.test(name.trim());
}

/** Load the project (non-deleted) or return null. */
async function loadProject(projectId: number) {
  const [project] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));
  return project ?? null;
}

/** Load and parse package.json for the project. Returns null if not found or unparseable. */
async function loadPackageJson(
  projectId: number,
): Promise<{ fileId: number; pkg: PackageJson } | null> {
  const [row] = await db
    .select({ id: projectFilesTable.id, content: projectFilesTable.content })
    .from(projectFilesTable)
    .where(
      and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.path, "package.json")),
    );
  if (!row) return null;
  try {
    const pkg = JSON.parse(row.content) as PackageJson;
    return { fileId: row.id, pkg };
  } catch {
    return null;
  }
}

/** Persist an updated package.json back to the DB. */
async function savePackageJson(projectId: number, fileId: number, pkg: PackageJson): Promise<void> {
  const content = JSON.stringify(pkg, null, 2);
  await db
    .update(projectFilesTable)
    .set({ content, updatedAt: new Date() })
    .where(and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.id, fileId)));
}

/**
 * After a successful npm install, read the resolved version from the container's
 * package.json so we can persist an accurate semver range. Falls back to the
 * user-supplied constraint when the read or parse fails.
 */
async function readResolvedVersion(
  containerId: string,
  projectId: number,
  pkgName: string,
  fallback: string,
  isDev: boolean,
): Promise<string> {
  const result = await execInContainer(containerId, ["cat", "/app/package.json"], projectId);
  if (!result.ok) return fallback;
  try {
    const parsed = JSON.parse(result.output) as PackageJson;
    const section = isDev ? parsed.devDependencies : parsed.dependencies;
    return section?.[pkgName] ?? fallback;
  } catch {
    return fallback;
  }
}

// ── POST /api/projects/:id/packages/install ──────────────────────────────────
router.post(
  "/projects/:id/packages/install",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const project = await loadProject(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const { name, version, dev } = req.body as {
      name?: unknown;
      version?: unknown;
      dev?: unknown;
    };

    if (!isValidPackageName(name)) {
      res.status(400).json({ error: "name must be a valid npm package name" });
      return;
    }

    const pkgName = (name as string).trim();
    const pkgVersion = typeof version === "string" && version.trim() ? version.trim() : null;
    const isDev = dev === true;

    const loaded = await loadPackageJson(projectId);
    if (!loaded) {
      res.status(404).json({ error: "package.json not found or could not be parsed" });
      return;
    }

    const { fileId, pkg } = loaded;

    // Resolve a specifier for npm install (e.g. "lodash" or "lodash@^4.0.0")
    const specifier = pkgVersion ? `${pkgName}@${pkgVersion}` : pkgName;

    // Run npm install in container if it's running; fail fast if the command fails.
    let output = "";
    let resolvedVersion = pkgVersion ?? "latest";

    if (project.containerId && project.containerStatus === "running") {
      const args = isDev
        ? ["npm", "install", "--save-dev", specifier]
        : ["npm", "install", "--save", specifier];
      const result = await execInContainer(project.containerId, args, projectId);
      output = result.output;

      if (!result.ok) {
        res.status(500).json({ error: `npm install failed: ${result.output}` });
        return;
      }

      // Read the resolved version from the container's updated package.json.
      resolvedVersion = await readResolvedVersion(
        project.containerId,
        projectId,
        pkgName,
        pkgVersion ?? "latest",
        isDev,
      );
    }

    // Patch package.json in the DB with the resolved version.
    if (isDev) {
      pkg.devDependencies = { ...(pkg.devDependencies ?? {}), [pkgName]: resolvedVersion };
    } else {
      pkg.dependencies = { ...(pkg.dependencies ?? {}), [pkgName]: resolvedVersion };
    }

    await savePackageJson(projectId, fileId, pkg);

    res.json({
      ok: true,
      output,
      dependencies: pkg.dependencies ?? {},
      devDependencies: pkg.devDependencies ?? {},
    });
  },
);

// ── POST /api/projects/:id/packages/uninstall ────────────────────────────────
router.post(
  "/projects/:id/packages/uninstall",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const project = await loadProject(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const { name } = req.body as { name?: unknown };

    if (!isValidPackageName(name)) {
      res.status(400).json({ error: "name must be a valid npm package name" });
      return;
    }

    const pkgName = (name as string).trim();

    const loaded = await loadPackageJson(projectId);
    if (!loaded) {
      res.status(404).json({ error: "package.json not found or could not be parsed" });
      return;
    }

    const { fileId, pkg } = loaded;

    // Run npm uninstall in container if it's running; fail fast if the command fails.
    let output = "";
    if (project.containerId && project.containerStatus === "running") {
      const result = await execInContainer(
        project.containerId,
        ["npm", "uninstall", pkgName],
        projectId,
      );
      output = result.output;

      if (!result.ok) {
        res.status(500).json({ error: `npm uninstall failed: ${result.output}` });
        return;
      }
    }

    // Remove from both deps sections (covers cases where the user moved it).
    if (pkg.dependencies) {
      delete pkg.dependencies[pkgName];
    }
    if (pkg.devDependencies) {
      delete pkg.devDependencies[pkgName];
    }

    await savePackageJson(projectId, fileId, pkg);

    res.json({
      ok: true,
      output,
      dependencies: pkg.dependencies ?? {},
      devDependencies: pkg.devDependencies ?? {},
    });
  },
);

export default router;
