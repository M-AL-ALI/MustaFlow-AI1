import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Normalize CRLF so source-string assertions pass on Windows checkouts too.
const read = (rel: string) =>
  readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

/**
 * Phase 7 — Memory Upgrades, mobile parity wiring:
 *  - lib/api.ts listMemories supports the "all" scope (website parity).
 *  - Memory screen lists ALL scopes, renders scope badges, and offers the same
 *    tri-state scope filter as the website.
 *  - The per-project memories tab keeps its single-project listing (no badge).
 */
describe("Mobile memories API — scope support (Phase 7)", () => {
  const api = read("../api.ts");

  it("listMemories accepts number | 'all' | null and maps 'all' to ?scope=all", () => {
    expect(api).toContain('listMemories(scope?: number | "all" | null)');
    expect(api).toContain('"/api/ora/memories?scope=all"');
    expect(api).toContain("`/api/ora/memories?oraProjectId=${scope}`");
  });
});

describe("Mobile Memory screen — all-scopes listing + scope filter (Phase 7)", () => {
  const screen = read("../../app/(home)/memory.tsx");

  it("MemoriesTab loads ALL scopes plus project names for badges", () => {
    expect(screen).toContain('listMemories("all")');
    expect(screen).toContain("listProjects(true).catch(() => [] as OraProjectSummary[])");
  });

  it("has the same tri-state scope filter as the website", () => {
    expect(screen).toContain(
      'const [scopeFilter, setScopeFilter] = useState<"all" | "global" | number>("all");',
    );
    expect(screen).toContain("? m.oraProjectId == null");
    expect(screen).toContain(": m.oraProjectId === scopeFilter;");
  });

  it("renders scope badges with a safe fallback for unknown project ids", () => {
    expect(screen).toContain("function ScopeBadge({ label }: { label: string | null })");
    expect(screen).toContain("scopeLabel={scopeLabelFor(m)}");
    expect(screen).toContain('projectNameById.get(m.oraProjectId) ?? "Project"');
  });

  it("scope chip row only appears when project-scoped memories exist", () => {
    expect(screen).toContain("{projectScopes.length > 0 && (");
    expect(screen).toContain('(["all", "global", ...projectScopes]');
  });

  it("per-project tab keeps its single-project listing (no scope badge)", () => {
    const tabStart = screen.indexOf("function ProjectMemoriesTab(");
    expect(tabStart).toBeGreaterThan(-1);
    const tabBody = screen.slice(tabStart);
    expect(tabBody).toContain("listMemories(projectId)");
    expect(tabBody).not.toContain("scopeLabel=");
  });
});
