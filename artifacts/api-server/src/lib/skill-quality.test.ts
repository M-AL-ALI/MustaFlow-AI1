/**
 * Skill quality lint (Task #536).
 *
 * Walks every SKILL.md on disk (both `skills/<slug>/` and
 * `skills/_drafts/<slug>/`) and asserts:
 *   1. Valid YAML-ish frontmatter with required `name`, `description`, `triggers`.
 *   2. Body size between 200 chars and 40 KB.
 *   3. Body contains a top-level `## Examples` section.
 *   4. Description ≤ 240 chars (fits the index format).
 *   5. Slug (folder name) matches the safe pattern.
 *
 * Run with `pnpm --filter @workspace/api-server run test`.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseFrontmatter, isValidSkillSlug } from "./builder-skills";

function resolveSkillsRoot(): string {
  const candidates = [
    path.resolve(process.cwd(), "skills"),
    path.resolve(process.cwd(), "../../skills"),
    path.resolve(__dirname, "../../../../skills"),
  ];
  for (const c of candidates) {
    try {
      if (statSync(c).isDirectory()) return c;
    } catch {
      /* try next */
    }
  }
  throw new Error("skills/ directory not found in any candidate path");
}

function listSkillFiles(): { slug: string; filePath: string; draft: boolean }[] {
  const root = resolveSkillsRoot();
  const out: { slug: string; filePath: string; draft: boolean }[] = [];
  const walk = (dir: string, draft: boolean): void => {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".")) continue;
      const full = path.join(dir, entry);
      if (!statSync(full).isDirectory()) continue;
      if (!draft && entry === "_drafts") {
        walk(full, true);
        continue;
      }
      const md = path.join(full, "SKILL.md");
      try {
        statSync(md);
        out.push({ slug: entry, filePath: md, draft });
      } catch {
        /* no SKILL.md — skip */
      }
    }
  };
  walk(root, false);
  return out;
}

const MAX_BYTES = 40_000;
const MIN_BYTES = 200;

describe("SKILL.md library lint", () => {
  const files = listSkillFiles();

  it("library has at least 30 skills (Task #536 target)", () => {
    const approved = files.filter((f) => !f.draft);
    expect(approved.length).toBeGreaterThanOrEqual(30);
  });

  it.each(files)("$slug — well-formed SKILL.md", ({ slug, filePath }) => {
    expect(isValidSkillSlug(slug), `bad slug: ${slug}`).toBe(true);
    const raw = readFileSync(filePath, "utf8");
    expect(raw.startsWith("---"), `${slug}: missing frontmatter`).toBe(true);

    const { meta, body } = parseFrontmatter(raw);

    expect(typeof meta.name, `${slug}: 'name' must be string`).toBe("string");
    expect((meta.name as string).length, `${slug}: 'name' empty`).toBeGreaterThan(0);

    expect(typeof meta.description, `${slug}: 'description' must be string`).toBe("string");
    expect((meta.description as string).length, `${slug}: 'description' empty`).toBeGreaterThan(0);
    expect(
      (meta.description as string).length,
      `${slug}: 'description' must be ≤240 chars (got ${(meta.description as string).length})`,
    ).toBeLessThanOrEqual(240);

    expect(Array.isArray(meta.triggers), `${slug}: 'triggers' must be an array`).toBe(true);

    expect(body.length, `${slug}: body too small`).toBeGreaterThanOrEqual(MIN_BYTES);
    expect(
      body.length,
      `${slug}: body > ${MAX_BYTES} bytes (got ${body.length})`,
    ).toBeLessThanOrEqual(MAX_BYTES);

    expect(
      /\n##\s+Examples\b/.test("\n" + body),
      `${slug}: SKILL.md must contain a '## Examples' section`,
    ).toBe(true);
  });
});
