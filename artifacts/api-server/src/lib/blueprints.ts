/**
 * Task #542 — Integration blueprints loader + installer.
 *
 * Blueprints live in `blueprints/<id>/blueprint.json`. Each one is a JSON
 * manifest describing required secrets, packages to install, and files to
 * scaffold. There are no executable `scaffold.ts` modules — the manifest is
 * declarative so the installer behaves identically when invoked from a route
 * handler (HTTP API) and from the agent loop (`install_blueprint` tool).
 *
 * Installation is idempotent: existing files with the same path are
 * overwritten with the blueprint's version, and the project_blueprints row
 * is upserted.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  db,
  projectBlueprintsTable,
  projectFilesTable,
  type ProjectBlueprint,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { guessMime } from "./builder";
import { logger } from "./logger";
import { reconcileProjectFileAssetUsage } from "./project-file-asset-usage";

export interface BlueprintSecretSpec {
  name: string;
  category?: "auth" | "payment" | "ai" | "database" | "storage" | "deployment" | "other";
  helpUrl?: string;
  reason?: string;
  optional?: boolean;
}

export interface BlueprintPackageSpec {
  runtime: "node" | "python";
  name: string;
  version?: string;
  dev?: boolean;
}

export interface BlueprintFileSpec {
  /** Path inside the project (e.g. `lib/auth.ts`). */
  path: string;
  /** Inline file content. UTF-8 text only — binary assets aren't supported by blueprints. */
  content: string;
  /** Optional mime override; falls back to `guessMime(path)`. */
  mimeType?: string;
  /** When true, overwrite the existing project file. Default false (skip if file exists). */
  overwrite?: boolean;
}

export interface BlueprintManifest {
  id: string;
  name: string;
  category: "auth" | "payments" | "database" | "storage" | "ai" | "mcp" | "other";
  description: string;
  version: string;
  /** Optional homepage / docs link shown on the install card. */
  url?: string;
  /** When true, this blueprint is intended for mobile (Expo) projects. */
  mobileOnly?: boolean;
  /** When true, only static-html projects can install this. Default: any. */
  webOnly?: boolean;
  /** Secrets the agent must collect from the user. */
  requiredSecrets: BlueprintSecretSpec[];
  /** Packages installed via pkg manager (skipped for static-html projects). */
  packages: BlueprintPackageSpec[];
  /** Files written to the project (idempotent — skipped if file exists unless overwrite=true). */
  files: BlueprintFileSpec[];
  /** Markdown-formatted post-install instructions shown to the user. */
  postInstallNotes?: string;
}

export interface BlueprintInstallResult {
  blueprintId: string;
  filesWritten: string[];
  filesSkipped: string[];
  packagesInstalled: Array<{ runtime: string; name: string; version?: string }>;
  secretsRequested: string[];
  notes: string;
}

export interface ScaffoldContext {
  projectId: number;
  /**
   * Whether to actually install packages. The HTTP install route does not run
   * pkg installs (those happen in the next build). The agent-loop tool does.
   */
  installPackages?: (pkgs: BlueprintPackageSpec[]) => Promise<void>;
  /** Best-effort secret request. Returns the list of secrets the caller surfaced. */
  requestSecrets?: (secrets: BlueprintSecretSpec[]) => Promise<string[]>;
  actor?: string | null;
  /** When true, overwrite existing files even if the blueprint file spec didn't set overwrite. */
  overwrite?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Loader — reads `blueprints/<id>/blueprint.json` at startup
// ─────────────────────────────────────────────────────────────────────────────

let cachedBlueprints: BlueprintManifest[] | null = null;

function resolveBlueprintsDir(): string {
  // artifacts/api-server/src/lib/blueprints.ts → ../../../../blueprints
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "..", "blueprints");
}

export async function loadBlueprints(forceReload = false): Promise<BlueprintManifest[]> {
  if (cachedBlueprints && !forceReload) return cachedBlueprints;
  const dir = resolveBlueprintsDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    logger.warn({ err, dir }, "blueprints directory not found — marketplace will be empty");
    cachedBlueprints = [];
    return cachedBlueprints;
  }
  const manifests: BlueprintManifest[] = [];
  for (const entry of entries) {
    const manifestPath = path.join(dir, entry, "blueprint.json");
    try {
      const text = await fs.readFile(manifestPath, "utf8");
      const parsed = JSON.parse(text) as BlueprintManifest;
      if (!parsed.id || !parsed.name) continue;
      manifests.push(parsed);
    } catch (err) {
      logger.warn({ err, entry }, "skipping invalid blueprint");
    }
  }
  manifests.sort((a, b) => a.name.localeCompare(b.name));
  cachedBlueprints = manifests;
  return manifests;
}

export async function findBlueprint(id: string): Promise<BlueprintManifest | null> {
  const all = await loadBlueprints();
  return all.find((b) => b.id === id) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Installer
// ─────────────────────────────────────────────────────────────────────────────

export async function installBlueprint(
  manifest: BlueprintManifest,
  ctx: ScaffoldContext,
): Promise<BlueprintInstallResult> {
  const filesWritten: string[] = [];
  const filesSkipped: string[] = [];

  // ── Write files (idempotent upsert into project_files) ───────────────────
  for (const file of manifest.files) {
    const mime = file.mimeType ?? guessMime(file.path);
    const wroteFile = await db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: projectFilesTable.id })
        .from(projectFilesTable)
        .where(
          and(
            eq(projectFilesTable.projectId, ctx.projectId),
            eq(projectFilesTable.path, file.path),
          ),
        )
        .limit(1);
      if (existing[0] && !file.overwrite && !ctx.overwrite) return false;
      if (existing[0]) {
        await tx
          .update(projectFilesTable)
          .set({ content: file.content, mimeType: mime, updatedAt: new Date() })
          .where(eq(projectFilesTable.id, existing[0].id));
      } else {
        await tx.insert(projectFilesTable).values({
          projectId: ctx.projectId,
          path: file.path,
          content: file.content,
          mimeType: mime,
        });
      }
      await reconcileProjectFileAssetUsage(tx, {
        projectId: ctx.projectId,
        artifactId: null,
        filePath: file.path,
        nextContent: file.content,
      });
      return true;
    });
    if (wroteFile) {
      filesWritten.push(file.path);
    } else {
      filesSkipped.push(file.path);
    }
  }

  // ── Install packages (delegated to caller — only happens in agent context) ─
  const packagesInstalled: Array<{ runtime: string; name: string; version?: string }> = [];
  if (ctx.installPackages && manifest.packages.length > 0) {
    try {
      await ctx.installPackages(manifest.packages);
      for (const p of manifest.packages) {
        packagesInstalled.push({ runtime: p.runtime, name: p.name, version: p.version });
      }
    } catch (err) {
      logger.warn({ err, blueprint: manifest.id }, "blueprint package install failed (non-fatal)");
    }
  }

  // ── Request secrets (delegated to caller) ────────────────────────────────
  let secretsRequested: string[] = [];
  if (ctx.requestSecrets && manifest.requiredSecrets.length > 0) {
    try {
      secretsRequested = await ctx.requestSecrets(manifest.requiredSecrets);
    } catch (err) {
      logger.warn({ err, blueprint: manifest.id }, "blueprint secret request failed (non-fatal)");
    }
  }

  // ── Upsert project_blueprints row ────────────────────────────────────────
  const result = {
    filesWritten,
    packagesInstalled,
    secretsRequested,
    notes: manifest.postInstallNotes ?? "",
  };
  const existingRow = await db
    .select({ id: projectBlueprintsTable.id })
    .from(projectBlueprintsTable)
    .where(
      and(
        eq(projectBlueprintsTable.projectId, ctx.projectId),
        eq(projectBlueprintsTable.blueprintId, manifest.id),
      ),
    )
    .limit(1);
  if (existingRow[0]) {
    await db
      .update(projectBlueprintsTable)
      .set({
        version: manifest.version,
        result,
        updatedAt: new Date(),
      })
      .where(eq(projectBlueprintsTable.id, existingRow[0].id));
  } else {
    await db.insert(projectBlueprintsTable).values({
      projectId: ctx.projectId,
      blueprintId: manifest.id,
      version: manifest.version,
      installedBy: ctx.actor ?? null,
      result,
    });
  }

  return {
    blueprintId: manifest.id,
    filesWritten,
    filesSkipped,
    packagesInstalled,
    secretsRequested,
    notes: manifest.postInstallNotes ?? "",
  };
}

export async function listProjectBlueprints(projectId: number): Promise<ProjectBlueprint[]> {
  return db
    .select()
    .from(projectBlueprintsTable)
    .where(eq(projectBlueprintsTable.projectId, projectId));
}
