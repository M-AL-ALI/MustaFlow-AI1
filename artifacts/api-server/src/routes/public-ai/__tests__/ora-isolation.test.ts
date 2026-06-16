/**
 * Ora isolation enforcement — permanent rule.
 *
 * Ora is a STANDALONE AI assistant. It must have ZERO relationship with the AI
 * Builder product. This test suite runs on every CI/quality-gate pass and
 * intentionally fails if any forbidden Builder-relationship pattern is
 * reintroduced into an active Ora code path.
 *
 * ALLOWED exceptions (documented per test):
 *   handoff.ts         — permanently-disabled route that always returns 410
 *   phase6.test.ts     — disabled-route test; the only allowed reference to the 410 endpoint
 *   phase1.test.ts     — uses .not.toBe("builder_handoff") to prove isolation
 *   handoff-store.ts   — Builder-side exchange store; Ora never calls it
 *   build-intent.ts    — has /open in builder/i as a USER-INPUT detection regex, not rendered text
 *   Code comments      — lines beginning with "//" that explain what Ora is NOT
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, relative, resolve } from "path";

// Workspace root — navigate 6 levels up from this test file:
// __tests__ -> public-ai -> routes -> src -> api-server -> artifacts -> workspace
const WORKSPACE = resolve(__dirname, "../../../../../../");

// ── File collection helpers ──────────────────────────────────────────────────

function collectFiles(relDir: string, exclude: string[] = []): { path: string; src: string }[] {
  const abs = resolve(WORKSPACE, relDir);
  if (!existsSync(abs)) return [];
  const results: { path: string; src: string }[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const rel = relative(WORKSPACE, full).replace(/\\/g, "/");
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      if (exclude.some((ex) => rel.includes(ex))) continue;
      results.push({ path: rel, src: readFileSync(full, "utf-8") });
    }
  }
  walk(abs);
  return results;
}

function readOne(relPath: string): { path: string; src: string } {
  const abs = resolve(WORKSPACE, relPath);
  return { path: relPath, src: existsSync(abs) ? readFileSync(abs, "utf-8") : "" };
}

// ── Scoped file sets ─────────────────────────────────────────────────────────

/** Ora backend: lib/public-ai (excludes Builder-side handoff-store) */
const ORA_LIB = collectFiles("artifacts/api-server/src/lib/public-ai", ["handoff-store.ts"]);

/** Ora backend: routes/public-ai (excludes the permanently-disabled route and all tests —
 *  structural invariants for handoff.ts / orchestrator.ts / use-ora-chat.ts are
 *  checked via direct readOne() calls below) */
const ORA_ROUTES = collectFiles("artifacts/api-server/src/routes/public-ai", [
  "handoff.ts",
  "__tests__/",
]);

/** Ora message schema routes */
const ORA_SCHEMA_ROUTES = [
  readOne("artifacts/api-server/src/routes/ora-conversations.ts"),
  readOne("artifacts/api-server/src/routes/ora-transcript.ts"),
];

/** Ora frontend components */
const ORA_COMPONENTS = [
  ...collectFiles("artifacts/mustaflow/src/components/ora", ["__tests__"]),
  readOne("artifacts/mustaflow/src/components/ora-panel.tsx"),
  readOne("artifacts/mustaflow/src/components/ora-bubble.tsx"),
];

/** Ora frontend hooks */
const ORA_HOOKS = [
  readOne("artifacts/mustaflow/src/hooks/use-ora-chat.ts"),
  readOne("artifacts/mustaflow/src/hooks/ora-conversations-context.ts"),
];

/** Ora frontend lib helpers */
const ORA_LIB_FRONTEND = collectFiles("artifacts/mustaflow/src/lib", ["__tests__"]).filter((f) =>
  /\/ora-/.test(f.path),
);

/** Ora frontend pages */
const ORA_PAGES = collectFiles("artifacts/mustaflow/src/pages", ["__tests__"]).filter(
  (f) => /\/ora[.-]/.test(f.path) || f.path.endsWith("/ora.tsx") || f.path.endsWith("/orax.tsx"),
);

/** All active Ora files combined */
const ALL_ORA = [
  ...ORA_LIB,
  ...ORA_ROUTES,
  ...ORA_SCHEMA_ROUTES,
  ...ORA_COMPONENTS,
  ...ORA_HOOKS,
  ...ORA_LIB_FRONTEND,
  ...ORA_PAGES,
];

// ── Assertion helper ─────────────────────────────────────────────────────────

function findViolations(
  files: { path: string; src: string }[],
  pattern: RegExp,
  ignoreCommentLines = false,
): string[] {
  return files
    .filter((f) => {
      if (!ignoreCommentLines) return pattern.test(f.src);
      const lines = f.src.split("\n");
      return lines.some((line) => pattern.test(line) && !/^\s*\/\//.test(line));
    })
    .map((f) => f.path);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Ora isolation — permanent rule: zero AI Builder relationship", () => {
  it("handoffCta must not appear in any active Ora type, API response, or message schema", () => {
    const hits = findViolations(ALL_ORA, /handoffCta/);
    expect(hits, `handoffCta found in: ${hits.join(", ")}`).toHaveLength(0);
  });

  it("builder_handoff must not appear in active Ora tool types or routing (isolation-proof tests excluded)", () => {
    const hits = findViolations(ALL_ORA, /builder_handoff/);
    expect(hits, `builder_handoff found in: ${hits.join(", ")}`).toHaveLength(0);
  });

  it("'MustaFlow Builder' must not appear in active Ora prompts, routes, or UI", () => {
    const hits = findViolations(ALL_ORA, /MustaFlow Builder/);
    expect(hits, `'MustaFlow Builder' found in: ${hits.join(", ")}`).toHaveLength(0);
  });

  it("'Continue in Builder' must not appear in active Ora UI", () => {
    const hits = findViolations(ALL_ORA, /Continue in Builder/i);
    expect(hits, `'Continue in Builder' found in: ${hits.join(", ")}`).toHaveLength(0);
  });

  it("'ready to build' must not appear in active Ora UI", () => {
    const hits = findViolations(ALL_ORA, /ready to build/i);
    expect(hits, `'ready to build' found in: ${hits.join(", ")}`).toHaveLength(0);
  });

  it("'open in builder' must not appear as rendered/returned text in active Ora code (detection regex in build-intent.ts is allowed)", () => {
    const withoutDetection = ALL_ORA.filter((f) => !f.path.includes("build-intent"));
    const hits = findViolations(withoutDetection, /open in builder/i);
    expect(hits, `'open in builder' found in: ${hits.join(", ")}`).toHaveLength(0);
  });

  it("builder/handoff token creation URL must not be called from Ora frontend", () => {
    const hits = findViolations(
      [...ORA_COMPONENTS, ...ORA_HOOKS, ...ORA_LIB_FRONTEND, ...ORA_PAGES],
      /builder\/handoff/,
    );
    expect(hits, `builder/handoff found in Ora frontend: ${hits.join(", ")}`).toHaveLength(0);
  });

  it("handoff.ts route must always return 410 Gone and must never generate a token", () => {
    const { src } = readOne("artifacts/api-server/src/routes/public-ai/handoff.ts");
    expect(src, "handoff.ts no longer returns 410 — has it been re-enabled?").toMatch(
      /status\(410\)/,
    );
    expect(
      src,
      "storeHandoff found in handoff.ts — token generation must never be reintroduced",
    ).not.toMatch(/storeHandoff/);
    expect(
      src,
      "ORA_HANDOFF_ENABLED found in handoff.ts — no kill-switch allowed; route is permanently disabled",
    ).not.toMatch(/ORA_HANDOFF_ENABLED/);
  });

  it("OraTool type union must not include builder_handoff", () => {
    const { src } = readOne("artifacts/api-server/src/lib/public-ai/orchestrator.ts");
    expect(src, "orchestrator.ts OraTool union includes builder_handoff").not.toMatch(
      /"builder_handoff"/,
    );
    expect(src, "orchestrator.ts ORA_TOOLS registry has builder_handoff entry").not.toMatch(
      /builder_handoff\s*:/,
    );
  });

  it("OraMessage interface must not include a handoffCta field", () => {
    const { src } = readOne("artifacts/mustaflow/src/hooks/use-ora-chat.ts");
    expect(src, "use-ora-chat.ts OraMessage interface contains handoffCta").not.toMatch(
      /handoffCta/,
    );
  });

  it("Ora message schema (DB persistence) must not include handoffCta", () => {
    for (const { path, src } of ORA_SCHEMA_ROUTES) {
      expect(src, `${path} messageSchema contains handoffCta`).not.toMatch(/handoffCta/);
    }
  });
});
