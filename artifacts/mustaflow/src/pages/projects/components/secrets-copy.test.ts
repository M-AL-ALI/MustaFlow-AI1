import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Secrets copy", () => {
  it("labels secret names and values and explains project versus account scope", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/pages/dev-workspace/components/secrets-panel.tsx"),
      "utf8",
    );
    expect(source).toContain('htmlFor="new-secret-name"');
    expect(source).toContain('htmlFor="new-secret-value"');
    expect(source).toContain('name="nabuflow-secret-identifier"');
    expect(source).toContain('autoComplete="off"');
    expect(source).toContain('name="nabuflow-secret-material"');
    expect(source).toContain('autoComplete="new-password"');
    expect(source).toContain("readOnly={valueInputReadOnly}");
    expect(source).toContain('aria-label="Add secret"');
    expect(source).toContain("Name:");
    expect(source).toContain("Value:");
    expect(source).toContain("Project secrets work only in this project");
    expect(source).toContain("Account secrets can be reused across all your projects");
  });
});
