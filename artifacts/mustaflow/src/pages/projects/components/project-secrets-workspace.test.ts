import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const workspaceSource = readFileSync(
  path.resolve(process.cwd(), "src/pages/projects/[id].tsx"),
  "utf8",
);

describe("project Secrets workspace surface", () => {
  it("registers a dedicated lazy-mounted workspace tab", () => {
    expect(workspaceSource).toContain('{ label: "Secrets", value: "secrets", icon: KeyRound }');
    expect(workspaceSource).toContain('activeTab === "secrets"');
    expect(workspaceSource).toContain("<SecretsPanel");
    expect(workspaceSource).toContain("projectId={projectId}");
  });

  it("routes every add-key shortcut to the dedicated Secrets tab", () => {
    const addKeyBody = workspaceSource.match(/const handleAddKey[\s\S]*?\n {2}}, \[\]\);/)?.[0];
    expect(addKeyBody).toContain('setActiveTab("secrets")');
    expect(workspaceSource).toContain('onJumpToSecrets={() => setActiveTab("secrets")}');
  });
});
