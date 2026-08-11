import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  rows: [] as Array<{
    name: string;
    enabled: boolean;
    loadCount: number;
    lastLoadedAt: Date | null;
  }>,
  inserts: [] as Array<{ values: unknown; set: unknown }>,
  shouldThrowOnSelect: false,
}));

vi.mock("@workspace/db", () => {
  return {
    db: {
      select: () => ({
        from: () => ({
          where: () => {
            if (mockState.shouldThrowOnSelect) {
              return Promise.reject(new Error("db down"));
            }
            return Promise.resolve(mockState.rows);
          },
        }),
      }),
      insert: () => ({
        values: (v: unknown) => ({
          onConflictDoUpdate: (cfg: { set: unknown }) => {
            mockState.inserts.push({ values: v, set: cfg.set });
            return Promise.resolve();
          },
        }),
      }),
    },
    builderSkillsTable: {
      name: "name",
      enabled: "enabled",
      loadCount: "loadCount",
      lastLoadedAt: "lastLoadedAt",
      updatedAt: "updatedAt",
    },
  };
});

vi.mock("drizzle-orm", () => ({
  sql: (() => {
    const tag = (..._args: unknown[]) => ({ __sql: true });
    return tag;
  })(),
  inArray: () => ({ __inArray: true }),
}));

import {
  invalidateSkillCache,
  listEnabledSkills,
  listEnabledSkillsForTarget,
  listAllSkillsForAdmin,
  loadSkillContent,
  loadSkillContentForTarget,
  formatSkillIndex,
  getSkillManifest,
  __setManifestsForTesting,
  type SkillManifest,
} from "./builder-skills";

let tmpRoot = "";

async function writeSkill(name: string, body: string): Promise<void> {
  const dir = path.join(tmpRoot, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), body, "utf8");
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "builder-skills-"));
  process.env.BUILDER_SKILLS_DIR = tmpRoot;
  mockState.rows = [];
  mockState.inserts = [];
  mockState.shouldThrowOnSelect = false;
  invalidateSkillCache();
});

afterEach(async () => {
  delete process.env.BUILDER_SKILLS_DIR;
  invalidateSkillCache();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("builder-skills frontmatter parsing", () => {
  it("parses name, description, and bracketed triggers", async () => {
    await writeSkill(
      "react-vite",
      `---\nname: react-vite\ndescription: React + Vite guidance.\ntriggers: [react, vite, "tsx"]\n---\n\n# Body\nhello\n`,
    );
    const skills = await listEnabledSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "react-vite",
      description: "React + Vite guidance.",
      triggers: ["react", "vite", "tsx"],
    });
    expect(skills[0].body).toBe("# Body\nhello");
  });

  it("falls back to directory name when name field is missing", async () => {
    await writeSkill("fallback-name", `---\ndescription: no name field here\n---\nbody\n`);
    const skills = await listEnabledSkills();
    expect(skills[0].name).toBe("fallback-name");
    expect(skills[0].triggers).toEqual([]);
  });

  it("defaults description to '(no description)' when absent", async () => {
    await writeSkill("nodesc", `---\nname: nodesc\n---\nbody\n`);
    const skills = await listEnabledSkills();
    expect(skills[0].description).toBe("(no description)");
  });

  it("truncates very long descriptions to 240 chars", async () => {
    const longDesc = "x".repeat(500);
    await writeSkill("long", `---\nname: long\ndescription: ${longDesc}\n---\nbody\n`);
    const skills = await listEnabledSkills();
    expect(skills[0].description.length).toBe(240);
  });

  it("treats files without frontmatter as empty meta + full body", async () => {
    await writeSkill("plain", `no frontmatter here\nsecond line\n`);
    const skills = await listEnabledSkills();
    expect(skills[0].name).toBe("plain");
    expect(skills[0].description).toBe("(no description)");
    expect(skills[0].body).toBe("no frontmatter here\nsecond line");
  });

  it("ignores triggers that are not bracketed lists", async () => {
    await writeSkill(
      "weird-trig",
      `---\nname: weird-trig\ndescription: x\ntriggers: not-a-list\n---\nbody\n`,
    );
    const skills = await listEnabledSkills();
    expect(skills[0].triggers).toEqual([]);
  });
});

describe("listEnabledSkills — DB enable filter", () => {
  it("hides skills whose DB row is disabled", async () => {
    await writeSkill("on", `---\nname: on\ndescription: enabled one\n---\nbody\n`);
    await writeSkill("off", `---\nname: off\ndescription: disabled one\n---\nbody\n`);
    mockState.rows = [{ name: "off", enabled: false, loadCount: 0, lastLoadedAt: null }];
    const skills = await listEnabledSkills();
    expect(skills.map((s) => s.name)).toEqual(["on"]);
  });

  it("defaults to enabled when there is no DB row", async () => {
    await writeSkill("a", `---\nname: a\ndescription: x\n---\nbody\n`);
    await writeSkill("b", `---\nname: b\ndescription: x\n---\nbody\n`);
    const skills = await listEnabledSkills();
    expect(skills.map((s) => s.name)).toEqual(["a", "b"]);
  });

  it("treats a settings query failure as everything-enabled", async () => {
    await writeSkill("a", `---\nname: a\ndescription: x\n---\nbody\n`);
    mockState.shouldThrowOnSelect = true;
    const skills = await listEnabledSkills();
    expect(skills.map((s) => s.name)).toEqual(["a"]);
  });
});

describe("listAllSkillsForAdmin — telemetry merge", () => {
  it("returns enabled + disabled with load counts and bytes", async () => {
    await writeSkill("alpha", `---\nname: alpha\ndescription: a\n---\nbody-alpha\n`);
    await writeSkill("beta", `---\nname: beta\ndescription: b\n---\nbody-beta\n`);
    const loadedAt = new Date("2025-01-02T03:04:05Z");
    mockState.rows = [{ name: "beta", enabled: false, loadCount: 7, lastLoadedAt: loadedAt }];
    const all = await listAllSkillsForAdmin();
    const byName = Object.fromEntries(all.map((s) => [s.name, s]));
    expect(byName.alpha).toMatchObject({
      enabled: true,
      loadCount: 0,
      lastLoadedAt: null,
      bytes: "body-alpha".length,
    });
    expect(byName.beta).toMatchObject({
      enabled: false,
      loadCount: 7,
      lastLoadedAt: loadedAt.toISOString(),
      bytes: "body-beta".length,
    });
  });
});

describe("loadSkillContent — load-count behaviour", () => {
  it("returns null for unknown skill and never writes to db", async () => {
    const result = await loadSkillContent("does-not-exist");
    expect(result).toBeNull();
    expect(mockState.inserts).toHaveLength(0);
  });

  it("returns null for disabled skill and never writes to db", async () => {
    await writeSkill("dis", `---\nname: dis\ndescription: x\n---\nbody\n`);
    mockState.rows = [{ name: "dis", enabled: false, loadCount: 3, lastLoadedAt: null }];
    const result = await loadSkillContent("dis");
    expect(result).toBeNull();
    expect(mockState.inserts).toHaveLength(0);
  });

  it("returns manifest and writes an upsert that increments loadCount", async () => {
    await writeSkill("on", `---\nname: on\ndescription: x\n---\nbody-content\n`);
    const result = await loadSkillContent("on");
    expect(result?.name).toBe("on");
    expect(result?.body).toBe("body-content");
    expect(mockState.inserts).toHaveLength(1);
    const insert = mockState.inserts[0]!;
    const values = insert.values as { name: string; loadCount: number };
    expect(values.name).toBe("on");
    expect(values.loadCount).toBe(1);
    expect(insert.set).toMatchObject({ loadCount: expect.any(Object) });
  });
});

describe("sealed skill capability eligibility", () => {
  it("replaces eligible direct guidance and preserves the legacy body byte-for-byte", async () => {
    await writeSkill(
      "postgres-drizzle",
      `---\nname: postgres-drizzle\ndescription: database\n---\nlegacy DATABASE_URL driver guidance\n`,
    );
    const sealed = await loadSkillContentForTarget(
      "postgres-drizzle",
      "cloudflare-sealed-staging-v1",
    );
    expect(sealed).toMatchObject({ ok: true });
    if (!sealed?.ok) throw new Error("Expected sealed database guidance");
    expect(sealed.manifest.body).toContain("createNabuFlowDatabase");
    expect(sealed.manifest.body).not.toContain("DATABASE_URL");

    const legacy = await loadSkillContentForTarget("postgres-drizzle", "legacy-v1");
    expect(legacy).toMatchObject({ ok: true });
    if (!legacy?.ok) throw new Error("Expected legacy guidance");
    expect(legacy.manifest.body).toBe("legacy DATABASE_URL driver guidance");
  });

  it("returns a content-addressed typed gap and hides ineligible skills from the sealed index", async () => {
    await writeSkill(
      "firebase",
      `---\nname: firebase\ndescription: firebase\n---\nlegacy direct provider guidance\n`,
    );
    await writeSkill(
      "postgres-drizzle",
      `---\nname: postgres-drizzle\ndescription: database\n---\nlegacy database guidance\n`,
    );
    const gap = await loadSkillContentForTarget("firebase", "cloudflare-sealed-staging-v1");
    expect(gap).toMatchObject({
      ok: false,
      code: "zero_capability_gap",
      identitySha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    const sealedIndex = await listEnabledSkillsForTarget("cloudflare-sealed-staging-v1");
    expect(sealedIndex.map((skill) => skill.name)).toEqual(["postgres-drizzle"]);
    const legacyIndex = await listEnabledSkillsForTarget("legacy-v1");
    expect(legacyIndex.map((skill) => skill.name)).toEqual(["firebase", "postgres-drizzle"]);
  });
});

describe("formatSkillIndex", () => {
  it("returns empty string for no skills", () => {
    expect(formatSkillIndex([])).toBe("");
  });

  it("includes name, description, and first 6 triggers per skill", () => {
    const out = formatSkillIndex([
      {
        name: "react-vite",
        description: "A description",
        triggers: ["a", "b", "c", "d", "e", "f", "g"],
        body: "",
        filePath: "/x",
        draft: false,
      } satisfies SkillManifest,
    ]);
    expect(out).toContain("- react-vite — A description");
    expect(out).toContain("triggers: a, b, c, d, e, f");
    expect(out).not.toContain(" g)");
  });
});

describe("getSkillManifest + __setManifestsForTesting", () => {
  it("returns the injected manifest without disk I/O or db calls", async () => {
    const inject = new Map<string, SkillManifest>([
      [
        "injected",
        {
          name: "injected",
          description: "in-memory",
          triggers: [],
          body: "INJECTED",
          filePath: "(virtual)",
          draft: false,
        },
      ],
    ]);
    __setManifestsForTesting(inject);
    const m = await getSkillManifest("injected");
    expect(m?.body).toBe("INJECTED");
    expect(mockState.inserts).toHaveLength(0);
  });
});
