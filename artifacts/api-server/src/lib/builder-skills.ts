/**
 * Per-task skills system (Task #506, expanded in #536).
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
 *
 * Task #536:
 *   - Drafts: agent-authored skills live under `skills/_drafts/<slug>/SKILL.md`
 *     with `draft=true` in the DB. They are excluded from the loop index and
 *     `load_skill`. Admin approval moves the file to `skills/<slug>/` and
 *     flips the flag.
 *   - Trigger-aware ranking: callers can pass a user prompt to
 *     `formatSkillIndex` to bubble matched skills to the top of the index.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql, inArray, eq, and } from "drizzle-orm";
import { db, builderSkillsTable, type BuilderSkillRow } from "@workspace/db";
import { logger } from "./logger";
import type {
  ZeroEligibilityReason,
  ZeroGenerationTarget,
} from "@workspace/tenant-runtime-contracts";
import {
  resolveZeroIntegrationEligibility,
  resolveZeroIntegrationEligibilityOutcome,
} from "./zero-capability-eligibility";

export interface SkillManifest {
  name: string;
  description: string;
  triggers: string[];
  body: string;
  /** Absolute path to the SKILL.md file. */
  filePath: string;
  /** True when this manifest came from skills/_drafts/. */
  draft: boolean;
}

export interface SkillSummary {
  name: string;
  description: string;
  triggers: string[];
  enabled: boolean;
  loadCount: number;
  lastLoadedAt: string | null;
  bytes: number;
  draft: boolean;
  authoredBy: string | null;
  authoredAt: string | null;
  authoringContext: string | null;
}

const DRAFTS_DIRNAME = "_drafts";

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
export function parseFrontmatter(raw: string): {
  meta: Record<string, unknown>;
  body: string;
} {
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

async function readSkillFile(
  dir: string,
  entry: string,
  isDraft: boolean,
): Promise<SkillManifest | null> {
  const skillPath = path.join(dir, entry, "SKILL.md");
  let raw: string;
  try {
    const st = await fs.stat(path.join(dir, entry));
    if (!st.isDirectory()) return null;
    raw = await fs.readFile(skillPath, "utf8");
  } catch {
    return null;
  }
  const { meta, body } = parseFrontmatter(raw);
  const name = typeof meta.name === "string" && meta.name.length > 0 ? meta.name : entry;
  const description = typeof meta.description === "string" ? meta.description : "(no description)";
  const triggers = Array.isArray(meta.triggers) ? (meta.triggers as string[]) : [];
  return {
    name,
    description: description.slice(0, 240),
    triggers,
    body: body.trim(),
    filePath: skillPath,
    draft: isDraft,
  };
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
    if (entry === DRAFTS_DIRNAME) continue; // handled separately below
    const m = await readSkillFile(root, entry, false);
    if (m) out.set(m.name, m);
  }

  // Drafts: skills/_drafts/<slug>/SKILL.md
  const draftsRoot = path.join(root, DRAFTS_DIRNAME);
  try {
    const draftEntries = await fs.readdir(draftsRoot);
    for (const entry of draftEntries) {
      const m = await readSkillFile(draftsRoot, entry, true);
      if (!m) continue;
      // Don't let a draft shadow an approved skill of the same name.
      if (out.has(m.name)) continue;
      out.set(m.name, m);
    }
  } catch {
    /* drafts dir doesn't exist yet — fine */
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

/** Returns enabled-only manifests, applying DB enable/disable settings and
 *  excluding drafts. */
export async function listEnabledSkills(): Promise<SkillManifest[]> {
  const manifests = await readManifests();
  const settings = await loadSettingsMap(Array.from(manifests.keys()));
  const out: SkillManifest[] = [];
  for (const m of manifests.values()) {
    if (m.draft) continue;
    const s = settings.get(m.name);
    if (s && (s.enabled === false || s.draft === true)) continue;
    out.push(m);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Existing target returns the exact legacy objects. Sealed mode exposes only
 * skills whose sidecar has an approved capability/native resolution. */
export async function listEnabledSkillsForTarget(
  target: ZeroGenerationTarget,
): Promise<SkillManifest[]> {
  const enabled = await listEnabledSkills();
  if (target === "legacy-v1") return enabled;
  const eligible: SkillManifest[] = [];
  for (const skill of enabled) {
    const metadata = await resolveZeroIntegrationEligibility("skill", skill.name);
    if (metadata.cloudflare.status !== "eligible") continue;
    eligible.push({ ...skill, body: metadata.cloudflare.sealedGuidance });
  }
  return eligible;
}

/** Admin view: all approved skills (enabled + disabled) with settings + telemetry. */
export async function listAllSkillsForAdmin(): Promise<SkillSummary[]> {
  const manifests = await readManifests();
  const settings = await loadSettingsMap(Array.from(manifests.keys()));
  const out: SkillSummary[] = [];
  for (const m of manifests.values()) {
    if (m.draft) continue;
    const s = settings.get(m.name);
    if (s?.draft) continue;
    out.push(summaryFromManifest(m, s));
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Admin view: just the pending-review drafts. */
export async function listDraftSkillsForAdmin(): Promise<SkillSummary[]> {
  const manifests = await readManifests();
  const settings = await loadSettingsMap(Array.from(manifests.keys()));
  const out: SkillSummary[] = [];
  for (const m of manifests.values()) {
    const s = settings.get(m.name);
    if (!m.draft && !s?.draft) continue;
    out.push(summaryFromManifest(m, s));
  }
  out.sort((a, b) => (b.authoredAt ?? "").localeCompare(a.authoredAt ?? ""));
  return out;
}

function summaryFromManifest(m: SkillManifest, s: BuilderSkillRow | undefined): SkillSummary {
  return {
    name: m.name,
    description: m.description,
    triggers: m.triggers,
    enabled: s?.enabled ?? true,
    loadCount: s?.loadCount ?? 0,
    lastLoadedAt: s?.lastLoadedAt ? new Date(s.lastLoadedAt).toISOString() : null,
    bytes: m.body.length,
    draft: s?.draft ?? m.draft,
    authoredBy: s?.authoredBy ?? null,
    authoredAt: s?.authoredAt ? new Date(s.authoredAt).toISOString() : null,
    authoringContext: s?.authoringContext ?? null,
  };
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
 * Load a single skill's full body. Returns null when the skill is unknown,
 * disabled, or still in draft state. Increments the persistent load counter
 * on success.
 */
export async function loadSkillContent(name: string): Promise<SkillManifest | null> {
  const manifests = await readManifests();
  const m = manifests.get(name);
  if (!m) return null;
  if (m.draft) return null;
  const settings = await loadSettingsMap([name]);
  const s = settings.get(name);
  if (s && (s.enabled === false || s.draft === true)) return null;
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

export type TargetSkillLoadResult =
  | { ok: true; manifest: SkillManifest }
  | {
      ok: false;
      code: "zero_capability_gap";
      identitySha256: string;
      reasons: ZeroEligibilityReason[];
    };

export async function loadSkillContentForTarget(
  name: string,
  target: ZeroGenerationTarget,
): Promise<TargetSkillLoadResult | null> {
  if (target === "legacy-v1") {
    const manifest = await loadSkillContent(name);
    return manifest === null ? null : { ok: true, manifest };
  }
  const metadata = await resolveZeroIntegrationEligibility("skill", name);
  if (metadata.cloudflare.status !== "eligible") {
    const outcome = await resolveZeroIntegrationEligibilityOutcome("skill", name);
    if (outcome.ok) throw new Error("Zero skill metadata outcome disagrees with its contract");
    return {
      ok: false,
      code: outcome.code,
      identitySha256: outcome.identitySha256,
      reasons: [...outcome.reasons],
    };
  }
  const manifest = await loadSkillContent(name);
  if (manifest === null) return null;
  return { ok: true, manifest: { ...manifest, body: metadata.cloudflare.sealedGuidance } };
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,80}$/;

export function isValidSkillSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

/** Suggest skills whose triggers match the current user prompt. Used by both
 *  the index formatter (to bubble matches to the top) and as a public helper
 *  for callers that want the raw match list. Case-insensitive substring match. */
export function rankSkillsByPrompt(
  skills: SkillManifest[],
  prompt: string | null | undefined,
): { suggested: SkillManifest[]; rest: SkillManifest[] } {
  if (!prompt || !prompt.trim()) return { suggested: [], rest: skills };
  const lower = prompt.toLowerCase();
  const suggested: SkillManifest[] = [];
  const rest: SkillManifest[] = [];
  for (const s of skills) {
    const matched = s.triggers.some((t) => {
      const trig = t.trim().toLowerCase();
      if (trig.length < 2) return false;
      // Word-ish boundary: cheap regex escape for the trigger.
      const escaped = trig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
      return re.test(lower);
    });
    (matched ? suggested : rest).push(s);
  }
  return { suggested, rest };
}

/**
 * Format a compact index for injection into the agent system prompt. When a
 * user prompt is provided, skills whose triggers match are pulled to the top
 * under a "Suggested for this request" header so the model preferentially
 * loads them before guessing.
 */
export function formatSkillIndex(skills: SkillManifest[], userPrompt?: string | null): string {
  if (skills.length === 0) return "";
  const { suggested, rest } = rankSkillsByPrompt(skills, userPrompt ?? null);
  const fmt = (s: SkillManifest, marker = ""): string => {
    const trig = s.triggers.length > 0 ? `  (triggers: ${s.triggers.slice(0, 6).join(", ")})` : "";
    return `- ${s.name}${marker} — ${s.description}${trig}`;
  };
  const sections: string[] = [
    "## Available skills (load on demand)",
    "Each skill is a focused instruction set for a specific stack or feature.",
    "Call `load_skill(name)` to read the full guidance for a skill BEFORE generating code that uses it.",
    "",
  ];
  if (suggested.length > 0) {
    sections.push("### Suggested for this request");
    sections.push(...suggested.map((s) => fmt(s, " ⭐")));
    sections.push("");
    sections.push("### Other available skills");
  }
  sections.push(...rest.map((s) => fmt(s)));
  return sections.join("\n");
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

// ─── Drafts: author / approve / reject ──────────────────────────────────────

export interface AuthorSkillInput {
  slug: string;
  name?: string;
  description: string;
  triggers?: string[];
  body: string;
  authoredBy?: string | null;
  authoringContext?: string | null;
}

export interface AuthorSkillResult {
  slug: string;
  name: string;
  filePath: string;
  bytes: number;
}

/**
 * Persist an agent-authored skill draft. Writes
 * `skills/_drafts/<slug>/SKILL.md` and inserts (or updates) a
 * `builder_skills` row with `enabled=false, draft=true`.
 */
export async function authorSkillDraft(input: AuthorSkillInput): Promise<AuthorSkillResult> {
  const slug = (input.slug ?? "").trim().toLowerCase();
  if (!isValidSkillSlug(slug)) {
    throw new Error(
      "Invalid slug: must match [a-z0-9][a-z0-9-]{1,80} (lowercase letters, digits, dashes).",
    );
  }
  const name = (input.name ?? slug).trim();
  const description = (input.description ?? "").trim();
  if (!description) throw new Error("description is required");
  if (description.length > 240) {
    throw new Error("description must be ≤ 240 characters");
  }
  const body = (input.body ?? "").trim();
  if (!body) throw new Error("body is required");
  if (!/\n##\s+Examples\b/i.test("\n" + body)) {
    throw new Error("body must include an '## Examples' section");
  }
  const MAX_BYTES = 40_000;
  if (body.length > MAX_BYTES) {
    throw new Error(`body must be ≤ ${MAX_BYTES} characters (got ${body.length})`);
  }
  const triggers = Array.isArray(input.triggers)
    ? input.triggers
        .map((t) => String(t).trim())
        .filter((t) => t.length > 0)
        .slice(0, 24)
    : [];

  const root = await resolveSkillsDir();
  if (!root) throw new Error("skills/ directory not found");

  // Collision guard: refuse to overwrite an approved skill on disk or in DB.
  // Without this, authoring a draft whose `slug` matches an existing approved
  // directory, or whose `name` matches an existing approved DB row, would either
  // shadow the live skill or flip its `draft`/`enabled` flags, hiding it from
  // the active index with no recovery path through admin approval.
  const approvedDir = path.join(root, slug);
  try {
    await fs.stat(approvedDir);
    throw new Error(
      `Cannot author draft: an approved skill already exists at skills/${slug}. Choose a different slug.`,
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }
  const existingManifests = await readManifests();
  const existing = existingManifests.get(name);
  if (existing && !existing.draft) {
    throw new Error(
      `Cannot author draft: an approved skill named "${name}" already exists. Choose a different name.`,
    );
  }

  const draftDir = path.join(root, DRAFTS_DIRNAME, slug);
  await fs.mkdir(draftDir, { recursive: true });
  const filePath = path.join(draftDir, "SKILL.md");

  const frontmatter =
    `---\n` +
    `name: ${name}\n` +
    `description: ${description}\n` +
    `triggers: [${triggers.join(", ")}]\n` +
    `---\n\n`;
  const fileContent = frontmatter + body + "\n";
  await fs.writeFile(filePath, fileContent, "utf8");

  await db
    .insert(builderSkillsTable)
    .values({
      name,
      enabled: false,
      draft: true,
      authoredBy: input.authoredBy ?? null,
      authoredAt: new Date(),
      authoringContext: input.authoringContext ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: builderSkillsTable.name,
      set: {
        enabled: false,
        draft: true,
        authoredBy: input.authoredBy ?? null,
        authoredAt: new Date(),
        authoringContext: input.authoringContext ?? null,
        updatedAt: new Date(),
      },
    });

  invalidateSkillCache();
  return { slug, name, filePath, bytes: fileContent.length };
}

/** Update a draft's file contents in place (admin edit before approval). */
export async function updateDraftSkillBody(name: string, newRawFile: string): Promise<void> {
  const manifests = await readManifests();
  const m = manifests.get(name);
  if (!m || !m.draft) throw new Error(`No draft skill named "${name}"`);
  await fs.writeFile(m.filePath, newRawFile, "utf8");
  invalidateSkillCache();
}

/** Approve a draft: move the directory from skills/_drafts/<slug>/ to
 *  skills/<slug>/ and clear the draft flag in the DB. */
export async function approveDraftSkill(name: string): Promise<void> {
  const manifests = await readManifests();
  const m = manifests.get(name);
  if (!m || !m.draft) throw new Error(`No draft skill named "${name}"`);
  const draftDir = path.dirname(m.filePath);
  const root = await resolveSkillsDir();
  if (!root) throw new Error("skills/ directory not found");
  const slug = path.basename(draftDir);
  const targetDir = path.join(root, slug);
  try {
    await fs.stat(targetDir);
    throw new Error(`Cannot approve: skills/${slug} already exists on disk`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }
  await fs.rename(draftDir, targetDir);
  await db
    .insert(builderSkillsTable)
    .values({ name, enabled: true, draft: false, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: builderSkillsTable.name,
      set: { enabled: true, draft: false, updatedAt: new Date() },
    });
  invalidateSkillCache();
}

/** Reject a draft: delete the directory and remove the draft row. */
export async function rejectDraftSkill(name: string): Promise<void> {
  const manifests = await readManifests();
  const m = manifests.get(name);
  if (!m || !m.draft) throw new Error(`No draft skill named "${name}"`);
  const draftDir = path.dirname(m.filePath);
  await fs.rm(draftDir, { recursive: true, force: true });
  await db
    .delete(builderSkillsTable)
    .where(and(eq(builderSkillsTable.name, name), eq(builderSkillsTable.draft, true)));
  invalidateSkillCache();
}

/** Read raw file content for a draft (admin edit view). */
export async function readDraftRaw(name: string): Promise<string | null> {
  const manifests = await readManifests();
  const m = manifests.get(name);
  if (!m || !m.draft) return null;
  try {
    return await fs.readFile(m.filePath, "utf8");
  } catch {
    return null;
  }
}
