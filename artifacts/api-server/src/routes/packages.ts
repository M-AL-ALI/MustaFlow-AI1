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
import { execInContainer } from "../lib/tenant-runtime";

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

// ── GET /api/projects/:id/packages ────────────────────────────────────────
// Returns installed dependencies and devDependencies from package.json.
router.get("/projects/:id/packages", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  const project = await loadProject(projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const loaded = await loadPackageJson(projectId);
  if (!loaded) {
    // No package.json — could be a Python or static project
    res.json({ dependencies: {}, devDependencies: {} });
    return;
  }

  res.json({
    dependencies: loaded.pkg.dependencies ?? {},
    devDependencies: loaded.pkg.devDependencies ?? {},
  });
});

// ── GET /api/projects/:id/packages/search ─────────────────────────────────
// Proxy search to npm or PyPI registries so the browser doesn't need CORS
// workarounds. Results are cached in-memory for 5 minutes.

interface NpmSearchResult {
  package: {
    name: string;
    version: string;
    description?: string;
    links?: { npm?: string; repository?: string };
    downloads?: { monthly?: number };
  };
  score: { final: number; detail: { quality: number; popularity: number; maintenance: number } };
}

interface _PypiSearchResult {
  name: string;
  version: string;
  description: string;
}

type SearchResultRow = {
  name: string;
  version: string;
  description: string;
  url?: string;
  downloads?: number;
  score?: number;
};

const searchCache = new Map<string, { ts: number; results: SearchResultRow[] }>();
const CACHE_TTL = 5 * 60 * 1000;

router.get(
  "/projects/:id/packages/search",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const registry = req.query.registry === "pypi" ? "pypi" : "npm";

    if (!q || q.length < 2) {
      res.status(400).json({ error: "q must be at least 2 characters" });
      return;
    }

    const cacheKey = `${registry}:${q}`;
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      res.json({ results: cached.results, registry });
      return;
    }

    try {
      let results: SearchResultRow[] = [];

      if (registry === "npm") {
        const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=10`;
        const r = await fetch(url, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) throw new Error(`npm registry returned ${r.status}`);
        const data = (await r.json()) as { objects?: NpmSearchResult[] };
        results = (data.objects ?? []).map((obj) => ({
          name: obj.package.name,
          version: obj.package.version,
          description: obj.package.description ?? "",
          url: obj.package.links?.npm ?? `https://www.npmjs.com/package/${obj.package.name}`,
          score: Math.round((obj.score?.final ?? 0) * 100),
        }));
      } else {
        // PyPI does not have a public JSON search API. We use the direct package
        // lookup endpoint for exact-name queries. It reliably returns JSON.
        const directUrl = `https://pypi.org/pypi/${encodeURIComponent(q)}/json`;
        const dr = await fetch(directUrl, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(8000),
        });
        if (dr.ok) {
          const data = (await dr.json()) as {
            info?: { name: string; version: string; summary?: string };
          };
          if (data.info) {
            results = [
              {
                name: data.info.name,
                version: data.info.version,
                description: data.info.summary ?? "",
                url: `https://pypi.org/project/${data.info.name}/`,
              },
            ];
          }
        }
        // If the direct lookup misses (package not found by exact name), return
        // an empty list — PyPI exposes no public JSON search API for fuzzy queries.
      }

      searchCache.set(cacheKey, { ts: Date.now(), results });
      res.json({ results, registry });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Search failed";
      res.status(500).json({ error: message });
    }
  },
);

export default router;
