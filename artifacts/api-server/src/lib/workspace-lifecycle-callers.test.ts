import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
describe("all inventoried project creation writers use lifecycle admission", () => {
  it.each([
    ["../routes/projects.ts", 1],
    ["../routes/duplicate.ts", 1],
    ["../routes/v1/projects.ts", 1],
    ["../routes/templates.ts", 2],
    ["../test-part1.ts", 1],
  ] as const)(
    "%s holds the admission transaction through each project insertion",
    (path, count) => {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      expect(source.match(/withProjectWorkspaceAdmission\(/g)).toHaveLength(count);
      expect(source.match(/tx\s*\.insert\(projectsTable\)/g)).toHaveLength(count);
      expect(source).not.toMatch(/db\s*\.insert\(projectsTable\)/);
      if (!path.endsWith("test-part1.ts")) {
        expect(source.match(/error instanceof WorkspaceAdmissionError/g)).toHaveLength(count);
      }
    },
  );
});
