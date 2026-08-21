import {
  BLUEPRINT_INSTALL_USER_ERROR,
  DATABASE_DUPLICATE_VALUE_ERROR,
  DATABASE_USER_ERROR_FALLBACK,
  GITHUB_CREDENTIALS_ERROR,
  GITHUB_USER_ERROR_FALLBACK,
  WORKFLOW_USER_ERROR_FALLBACK,
  isBlueprintInstallFailureMessage,
} from "@workspace/ora-contracts";
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
  selectBlueprintFailureError,
  selectDatabaseFailureError,
  selectGithubFailureError,
  selectWorkflowFailureError,
} from "./user-visible-errors";

const SRC = join(__dirname, "..");

function readSource(path: string): string {
  return readFileSync(join(SRC, path), "utf-8");
}

function occurrences(source: string, token: string): number {
  return source.split(token).length - 1;
}

describe("middle-tier user-visible errors", () => {
  it("keeps the fixed messages that give a person a useful next step", () => {
    expect(selectGithubFailureError({ error: GITHUB_CREDENTIALS_ERROR })).toBe(
      GITHUB_CREDENTIALS_ERROR,
    );
    expect(selectDatabaseFailureError({ error: DATABASE_DUPLICATE_VALUE_ERROR })).toBe(
      DATABASE_DUPLICATE_VALUE_ERROR,
    );
    expect(selectWorkflowFailureError({ error: WORKFLOW_USER_ERROR_FALLBACK })).toBe(
      WORKFLOW_USER_ERROR_FALLBACK,
    );
    expect(selectBlueprintFailureError(BLUEPRINT_INSTALL_USER_ERROR)).toBe(
      BLUEPRINT_INSTALL_USER_ERROR,
    );
    expect(isBlueprintInstallFailureMessage("Package install failed: raw package output")).toBe(
      true,
    );
    expect(selectBlueprintFailureError("Package install failed: raw package output")).toBe(
      BLUEPRINT_INSTALL_USER_ERROR,
    );
  });

  it("does not render raw identifiers, stack-like text, or over-length detail", () => {
    const internalId = ["provider", "object_example"].join("_");
    const hostile = [
      { error: `Validation Failed: ${internalId}` },
      { error: `stack at workflow.ts:77 ${internalId}` },
      { error: "x".repeat(500) },
    ];

    for (const value of hostile) {
      const github = selectGithubFailureError(value);
      const database = selectDatabaseFailureError(value);
      const workflow = selectWorkflowFailureError(value);
      expect(github).toBe(GITHUB_USER_ERROR_FALLBACK);
      expect(database).toBe(DATABASE_USER_ERROR_FALLBACK);
      expect(workflow).toBe(WORKFLOW_USER_ERROR_FALLBACK);
      expect(`${github}${database}${workflow}`).not.toContain(internalId);
      expect(`${github}${database}${workflow}`).not.toContain("stack");
    }
  });

  it("routes every commissioned client sink through the shared selectors", () => {
    const githubTab = readSource("pages/projects/components/github-tab.tsx");
    const publishingTab = readSource("pages/projects/components/publishing-tab.tsx");
    const codeEditor = readSource("pages/projects/components/code-editor-tab.tsx");
    const databaseTab = readSource("pages/projects/components/database-tab.tsx");
    const workflows = readSource("pages/projects/components/workflows-panel.tsx");
    const activity = readSource("pages/projects/components/activity-stream.tsx");

    expect(occurrences(githubTab, "selectGithubFailureError(")).toBe(5);
    expect(occurrences(publishingTab, "selectGithubFailureError(")).toBe(1);
    expect(occurrences(codeEditor, "selectGithubFailureError(")).toBe(2);
    expect(occurrences(databaseTab, "selectDatabaseFailureError(")).toBe(2);
    expect(occurrences(workflows, "selectWorkflowFailureError(")).toBe(2);
    expect(occurrences(activity, "selectBlueprintFailureError(")).toBe(1);
  });
});
