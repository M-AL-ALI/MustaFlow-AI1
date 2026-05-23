/**
 * Per-task skills system (Task #506).
 *
 * Skills are markdown files on disk under `skills/<name>/SKILL.md` at the
 * workspace root. Each file starts with YAML-ish frontmatter:
 *
 *   ---
 *   name: react-vite
 *   description: One-line summary shown in the skill index.
 *   triggers: [react, vite, tsx]
 *   ---
 *
 *   # Skill body in markdown…
 *
 * The agent loop injects a compact index (name + description) into its system
 * prompt. The model can call `load_skill(name)` to pull the full SKILL.md body
 * into the conversation when it deems a skill relevant.
 *
 * Admin enable/disable + load counts persist in the `builder_skills` table.
 * Disabled skills are hidden from the index and `load_skill` returns an error
 * for them.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql, inArray } from "drizzle-orm";
import { db, builderSkillsTable, type BuilderSkillRow } from "@workspace/db";
import { logger } from "./logger";

export interface SkillManifest {
  name: string;
  description: string;
  triggers: string[];
  body: string;
  /** Absolute path to the SKILL.md file. */
  filePath: string;
}

export interface SkillSummary {
  name: string;
  description: string;
  triggers: string[];
  enabled: boolean;
  loadCount: number;
  lastLoadedAt: string | null;
  bytes: number;
}

let cachedManifests: Map<string, SkillManifest> | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 30_000;

function candidateDirs(): string[] {
  const fromEnv = process.env.BUILDER_SKILLS_DIR;
  const dirs: string[] = [];
  if (fromEnv) dirs.push(path.resolve(fromEnv));
  dirs.push(path.resolve(process.cwd(), "skills"));
  dirs.push(path.resolve(process.cwd(), "../../skills"));
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    dirs.push(path.resolve(here, "../skills")); // dist-relative
    dirs.push(path.resolve(here, "../../../../skills")); // src-relative monorepo root
  } catch {
    /* ignore */
  }
  return Array.from(new Set(dirs));
}

async function resolveSkillsDir(): Promise<string | null> {
  for (const dir of candidateDirs()) {
    try {
      const st = await fs.stat(dir);
      if (st.isDirectory()) return dir;
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * Minimal YAML frontmatter parser. We deliberately do not pull in a YAML
 * library — the format is fixed: a leading `---` line, key/value pairs (with
 * scalar or bracketed-list values), and a closing `---` line.
 */
function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  if (!raw.startsWith("---")) return { meta: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { meta: {}, body: raw };
  const headerBlock = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\r?\n/, "");
  const meta: Record<string, unknown> = {};
  for (const line of headerBlock.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    const value: string = m[2]!.trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      meta[key] = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      meta[key] = value.replace(/^["']|["']$/g, "");
    }
  }
  return { meta, body };
}

async function readManifests(): Promise<Map<string, SkillManifest>> {
  const now = Date.now();
  if (cachedManifests && now - cachedAt < CACHE_TTL_MS) return cachedManifests;

  const root = await resolveSkillsDir();
  const out = new Map<string, SkillManifest>();
  if (!root) {
    logger.warn("builder-skills: skills/ directory not found in any candidate path");
    cachedManifests = out;
    cachedAt = now;
    return out;
  }

  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch (err) {
    logger.warn({ err, root }, "builder-skills: failed to read skills directory");
    cachedManifests = out;
    cachedAt = now;
    return out;
  }

  for (const entry of entries) {
    const skillPath = path.join(root, entry, "SKILL.md");
    let raw: string;
    try {
      const st = await fs.stat(path.join(root, entry));
      if (!st.isDirectory()) continue;
      raw = await fs.readFile(skillPath, "utf8");
    } catch {
      continue;
    }
    const { meta, body } = parseFrontmatter(raw);
    const name = typeof meta.name === "string" && meta.name.length > 0 ? meta.name : entry;
    const description =
      typeof meta.description === "string" ? meta.description : "(no description)";
    const triggers = Array.isArray(meta.triggers) ? (meta.triggers as string[]) : [];
    out.set(name, {
      name,
      description: description.slice(0, 240),
      triggers,
      body: body.trim(),
      filePath: skillPath,
    });
  }
  cachedManifests = out;
  cachedAt = now;
  return out;
}

/** Invalidate the in-memory manifest cache (for tests / hot-reload). */
export function invalidateSkillCache(): void {
  cachedManifests = null;
  cachedAt = 0;
}

async function loadSettingsMap(names: string[]): Promise<Map<string, BuilderSkillRow>> {
  if (names.length === 0) return new Map();
  try {
    const rows = await db
      .select()
      .from(builderSkillsTable)
      .where(inArray(builderSkillsTable.name, names));
    return new Map(rows.map((r) => [r.name, r]));
  } catch (err) {
    logger.warn({ err }, "builder-skills: settings query failed (defaulting to enabled)");
    return new Map();
  }
}

/** Returns enabled-only manifests, applying DB enable/disable settings. */
export async function listEnabledSkills(): Promise<SkillManifest[]> {
  const manifests = await readManifests();
  const settings = await loadSettingsMap(Array.from(manifests.keys()));
  const out: SkillManifest[] = [];
  for (const m of manifests.values()) {
    const s = settings.get(m.name);
    if (s && s.enabled === false) continue;
    out.push(m);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Admin view: all skills (enabled + disabled) with settings + telemetry. */
export async function listAllSkillsForAdmin(): Promise<SkillSummary[]> {
  const manifests = await readManifests();
  const settings = await loadSettingsMap(Array.from(manifests.keys()));
  const out: SkillSummary[] = [];
  for (const m of manifests.values()) {
    const s = settings.get(m.name);
    out.push({
      name: m.name,
      description: m.description,
      triggers: m.triggers,
      enabled: s?.enabled ?? true,
      loadCount: s?.loadCount ?? 0,
      lastLoadedAt: s?.lastLoadedAt ? new Date(s.lastLoadedAt).toISOString() : null,
      bytes: m.body.length,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function setSkillEnabled(name: string, enabled: boolean): Promise<void> {
  await db
    .insert(builderSkillsTable)
    .values({ name, enabled, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: builderSkillsTable.name,
      set: { enabled, updatedAt: new Date() },
    });
}

/**
 * Load a single skill's full body. Returns null when the skill is unknown or
 * disabled. Increments the persistent load counter on success.
 */
export async function loadSkillContent(name: string): Promise<SkillManifest | null> {
  const manifests = await readManifests();
  const m = manifests.get(name);
  if (!m) return null;
  const settings = await loadSettingsMap([name]);
  const s = settings.get(name);
  if (s && s.enabled === false) return null;
  // Best-effort load count update — never fail the load on a DB hiccup.
  try {
    await db
      .insert(builderSkillsTable)
      .values({ name, enabled: true, loadCount: 1, lastLoadedAt: new Date() })
      .onConflictDoUpdate({
        target: builderSkillsTable.name,
        set: {
          loadCount: sql`${builderSkillsTable.loadCount} + 1`,
          lastLoadedAt: new Date(),
          updatedAt: new Date(),
        },
      });
  } catch (err) {
    logger.warn({ err, name }, "builder-skills: load-count update failed");
  }
  return m;
}

/** Format a compact index for injection into the agent system prompt. */
export function formatSkillIndex(skills: SkillManifest[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((s) => {
    const trig = s.triggers.length > 0 ? `  (triggers: ${s.triggers.slice(0, 6).join(", ")})` : "";
    return `- ${s.name} — ${s.description}${trig}`;
  });
  return [
    "## Available skills (load on demand)",
    "Each skill is a focused instruction set for a specific stack or feature.",
    "Call `load_skill(name)` to read the full guidance for a skill BEFORE generating code that uses it.",
    "",
    ...lines,
  ].join("\n");
}

/** Pure lookup (no telemetry, no enable check). Used by callers that already
 *  validated enablement (e.g. inside the loop after a successful load). */
export async function getSkillManifest(name: string): Promise<SkillManifest | undefined> {
  const manifests = await readManifests();
  return manifests.get(name);
}

/** Use only in unit tests to inject manifests. */
export function __setManifestsForTesting(map: Map<string, SkillManifest>): void {
  cachedManifests = map;
  cachedAt = Date.now();
}
