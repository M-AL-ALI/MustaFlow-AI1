import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractNamedFunction } from "../../../../api-server/src/lib/source-ast-test-helper";

const here = dirname(fileURLToPath(import.meta.url));
const homeSource = readFileSync(resolve(here, "../home.tsx"), "utf8");
const appSource = readFileSync(resolve(here, "../../App.tsx"), "utf8");

describe("public brainstorm entry authentication boundary", () => {
  it("hands the signed-out prompt to the protected projects route without dispatching AI", () => {
    const handler = extractNamedFunction(homeSource, "handleBrainstorm", "tsx");

    expect(handler).toContain('sessionStorage.setItem("mustaflow_brainstorm_seed"');
    expect(handler).toContain('setLocation("/projects")');
    expect(handler).not.toContain("/api/brainstorm");
    expect(appSource).toMatch(/<Route path="\/projects">\s*<Protected>\s*<BuilderGuard>/);
  });
});
