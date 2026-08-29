import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./visual-edit.ts", import.meta.url), "utf8");

describe("source-backed visual editing session", () => {
  it("requires one open actor-and-project-bound session before any source mutation", () => {
    const sessionCheck = source.indexOf("visual_edit_session_unavailable");
    const firstMutation = source.indexOf("persistVisualChange({");
    expect(sessionCheck).toBeGreaterThan(0);
    expect(firstMutation).toBeGreaterThan(sessionCheck);
    expect(source).toContain("session.projectId !== projectId");
    expect(source).toContain("session.actorUserId !== req.userId");
    expect(source).toContain('session.status !== "open"');
  });

  it("persists a typed intent receipt and provenance atomically with the file", () => {
    const persistence = source.slice(
      source.indexOf("async function persistVisualChange"),
      source.indexOf("function occurrences"),
    );
    expect(persistence).toContain("intentReceiptStore.persist");
    expect(persistence).toContain('intent: "mutate"');
    expect(persistence).toContain('reasonCode: "explicit_control"');
    expect(persistence).toContain("db.transaction");
    expect(persistence).toContain("eq(projectFilesTable.content, input.file.content)");
    expect(persistence).toContain("insert(visualEditChangesTable)");
  });

  it("batches every applied change into one restorable version and one timeline entry", () => {
    const closeRoute = source.slice(
      source.indexOf('"/projects/:id/visual-edit/sessions/:sessionId/close"'),
      source.indexOf('"/projects/:id/visual-edit/resolve"'),
    );
    expect(closeRoute.match(/insert\(projectVersionsTable\)/gu)).toHaveLength(1);
    expect(closeRoute.match(/insert\(projectActivityTable\)/gu)).toHaveLength(1);
    expect(closeRoute).toContain("filesSnapshot: files");
    expect(closeRoute).toContain("changes.map");
  });

  it("undo uses compare-and-swap so it cannot overwrite a newer source change", () => {
    const undoRoute = source.slice(
      source.indexOf('"/projects/:id/visual-edit/sessions/:sessionId/undo"'),
      source.indexOf('"/projects/:id/visual-edit/sessions/:sessionId/close"'),
    );
    expect(undoRoute).toContain("eq(projectFilesTable.content, change.afterContent)");
    expect(undoRoute).toContain("source changed after that edit");
  });
});
