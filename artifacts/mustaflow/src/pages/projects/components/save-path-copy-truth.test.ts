import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const componentSource = (name: string) =>
  readFileSync(resolve(process.cwd(), `src/pages/projects/components/${name}`), "utf8");

const jobsSource = readFileSync(resolve(process.cwd(), "../api-server/src/lib/jobs.ts"), "utf8");
const knowledgeSource = readFileSync(
  resolve(process.cwd(), "../api-server/src/lib/knowledge.ts"),
  "utf8",
);

describe("save-path copy truth", () => {
  it("states separately when a checkpoint appears and when a change can finish without one", () => {
    const source = componentSource("version-timeline.tsx");

    expect(source).toContain("Saved versions appear here when a rollback checkpoint is created.");
    expect(source).toMatch(
      /A build or change can\s+still finish without one if checkpoint saving fails\./,
    );
    expect(source).not.toContain(
      "automatically snapshots a version after each successful build or change",
    );
    expect(jobsSource).toContain(
      "Failed to save project version snapshot (non-fatal — files already persisted)",
    );
  });

  it("narrates the atomic files-and-version save before post-write migrations", () => {
    const source = componentSource("chat-history.tsx");
    const savePattern = source.indexOf("/saving files and version/i");
    const migrationPattern = source.indexOf("/running database migrations/i");
    const labelBlock = source.indexOf("const APPLY_STEP_LABELS");
    const saveLabel = source.indexOf('"Saving files and version together…"', labelBlock);
    const migrationLabel = source.indexOf('"Running database migrations…"', labelBlock);
    const backendSaveNarration = jobsSource.indexOf('"Saving files and version…"');
    const backendAtomicWrite = jobsSource.indexOf(
      "writeProjectFilesAtomically({",
      backendSaveNarration,
    );
    const backendMigration = jobsSource.indexOf(
      '"Running database migrations…"',
      backendAtomicWrite,
    );

    expect(savePattern).toBeGreaterThan(-1);
    expect(savePattern).toBeLessThan(migrationPattern);
    expect(labelBlock).toBeGreaterThan(-1);
    expect(saveLabel).toBeGreaterThan(-1);
    expect(saveLabel).toBeLessThan(migrationLabel);
    expect(source).not.toContain('"Saving version snapshot…"');
    expect(backendSaveNarration).toBeGreaterThan(-1);
    expect(backendAtomicWrite).toBeGreaterThan(backendSaveNarration);
    expect(backendMigration).toBeGreaterThan(backendAtomicWrite);
  });

  it("describes history as successfully saved knowledge rather than guaranteed build output", () => {
    const source = componentSource("history-tab.tsx");

    expect(source).toContain("This history shows build notes and lessons that were saved.");
    expect(source).toMatch(
      /A completed build may\s+not appear if its history entry was not saved\./,
    );
    expect(source).not.toContain("Events are recorded automatically as you build");
    expect(knowledgeSource).toContain("Failed to write Knowledge Vault entry — non-fatal");
    expect(knowledgeSource).toContain("return null;");
  });
});
