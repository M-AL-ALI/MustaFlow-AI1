import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Normalize CRLF so source-string assertions pass on Windows checkouts too.
const read = (rel: string) =>
  readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

/**
 * Phase 7 — Memory Upgrades, website wiring:
 *  - Memory Center lists ALL scopes (global + project) with scope badges and a
 *    scope filter chip row.
 *  - The memories API helper supports the "all" scope.
 *  - "Remember this document" is project-aware (chip receives the active
 *    project and shows a retry label on failure).
 */
describe("Website Memory Center — all-scopes listing + scope filter (Phase 7)", () => {
  const page = read("../ora-memory.tsx");

  it("fetches memories across ALL scopes (not just user-level)", () => {
    expect(page).toContain('fetchOraMemories("all")');
  });

  it("has a tri-state scope filter (all / global / specific project)", () => {
    expect(page).toContain(
      'const [scopeFilter, setScopeFilter] = useState<"all" | "global" | number>("all");',
    );
    expect(page).toContain(
      'if (scopeFilter === "global" && m.oraProjectId !== null) return false;',
    );
    expect(page).toContain(
      'if (typeof scopeFilter === "number" && m.oraProjectId !== scopeFilter) return false;',
    );
  });

  it("renders a scope badge on memory rows, resolving project names with a safe fallback", () => {
    expect(page).toContain("function ScopeBadge({ label }: { label: string | null })");
    expect(page).toContain("<ScopeBadge label={scopeLabel} />");
    // Unknown/stale project ids must never crash the badge — generic fallback.
    expect(page).toContain('projectNameById.get(m.oraProjectId) ?? "Project"');
  });
});

describe("Website memories API helper — scope support (Phase 7)", () => {
  const lib = read("../../lib/ora-memories.ts");

  it("fetchOraMemories accepts a scope of number | 'all' | null", () => {
    expect(lib).toContain('scope?: number | "all" | null');
    expect(lib).toContain("/api/ora/memories?scope=all");
    expect(lib).toContain("/api/ora/memories?oraProjectId=${scope}");
  });

  it("rememberDocument forwards the project anchor only when set", () => {
    expect(lib).toContain("oraProjectId?: number | null");
    expect(lib).toContain('...(typeof oraProjectId === "number" ? { oraProjectId } : {})');
  });
});

describe("Website document-memory chip — project anchoring + retry (Phase 7)", () => {
  const chip = read("../../components/ora/ora-document-memory-chip.tsx");
  const panel = read("../../components/ora-panel.tsx");

  it("chip accepts an oraProjectId and passes it to rememberDocument", () => {
    expect(chip).toContain("oraProjectId?: number | null;");
    expect(chip).toContain("rememberDocument(fileRef, confirmSensitive, oraProjectId)");
  });

  it("failed saves surface a Try again action instead of a dead chip", () => {
    expect(chip).toContain('status === "error" ? "Try again"');
  });

  it("OraPanel wires the ACTIVE project into the chip", () => {
    expect(panel).toContain("oraProjectId={saveOraProjectId}");
  });
});
