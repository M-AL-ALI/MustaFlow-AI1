import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildZeroProjectChoiceProfile,
  presentZeroProjectChoices,
  ZERO_PROJECT_CHOICES_SEMANTICS,
} from "./zero-project-choices";

const at = (day: number) => `2026-08-${String(day).padStart(2, "0")}T00:00:00.000Z`;

describe("Zero project decisions and rejections", () => {
  it("distinguishes an explicitly saved decision from an explicitly saved rejection", () => {
    const profile = buildZeroProjectChoiceProfile({
      projectId: 52,
      userMessages: [
        {
          id: 900,
          occurredAt: at(25),
          content:
            "Save this as a project decision: keep the site static. Save this as a project rejection: never add a database or authentication unless I explicitly reverse it. Do not build or change files.",
        },
      ],
    });

    expect(profile.semantics).toBe(ZERO_PROJECT_CHOICES_SEMANTICS);
    expect(profile.choices).toEqual([
      {
        kind: "accepted-decision",
        text: "keep the site static",
        source: { kind: "user-message", id: 900 },
      },
      {
        kind: "explicit-rejection",
        text: "never add a database or authentication unless I explicitly reverse it",
        source: { kind: "user-message", id: 900 },
      },
    ]);
  });

  it("does not promote ordinary or temporary instructions into durable choices", () => {
    const profile = buildZeroProjectChoiceProfile({
      projectId: 52,
      userMessages: [
        {
          id: 901,
          occurredAt: at(25),
          content: "What does my app do? Do not build or change files. Never mind the preview.",
        },
      ],
    });
    expect(profile.choices).toEqual([]);
  });

  it("accepts typed project-knowledge choices with exact provenance", () => {
    const profile = buildZeroProjectChoiceProfile({
      projectId: 52,
      knowledgeEntries: [
        { id: 21, type: "decision", content: "Use a dark background", occurredAt: at(24) },
        { id: 22, type: "rejection", content: "No sign-in wall", occurredAt: at(25) },
      ],
    });
    expect(profile.choices.map(({ kind, source }) => ({ kind, source }))).toEqual([
      { kind: "explicit-rejection", source: { kind: "project-knowledge", id: 22 } },
      { kind: "accepted-decision", source: { kind: "project-knowledge", id: 21 } },
    ]);
  });

  it("uses the newest exact evidence, de-duplicates, bounds output, and is deterministic", () => {
    const userMessages = Array.from({ length: 20 }, (_, index) => ({
      id: 100 + index,
      occurredAt: at(index + 1),
      content: `Save this as a project decision: choice ${index}.`,
    })).reverse();
    userMessages.unshift({
      id: 999,
      occurredAt: at(25),
      content: "Save this as a project decision: choice 19.",
    });

    const first = buildZeroProjectChoiceProfile({ projectId: 52, userMessages });
    const second = buildZeroProjectChoiceProfile({
      projectId: 52,
      userMessages: [...userMessages].reverse(),
    });
    expect(first).toEqual(second);
    expect(first.choices).toHaveLength(12);
    expect(first.choices[0]).toMatchObject({
      text: "choice 19",
      source: { kind: "user-message", id: 999 },
    });
    const long = buildZeroProjectChoiceProfile({
      projectId: 52,
      knowledgeEntries: [
        { id: 1000, type: "decision", content: "x".repeat(1_000), occurredAt: at(25) },
      ],
    });
    expect(long.choices[0]?.text).toHaveLength(800);
  });

  it("presents human instructions that honor rejections without claiming inferred choices", () => {
    const text = presentZeroProjectChoices(
      buildZeroProjectChoiceProfile({
        projectId: 52,
        knowledgeEntries: [
          { id: 30, type: "rejection", content: "No tracking", occurredAt: at(25) },
        ],
      }),
    );
    expect(text).toContain("Explicit rejection [project-knowledge#30]: No tracking");
    expect(text).toContain("unless the user's newest message explicitly reverses one");
    expect(text).toContain("Do not infer an unrecorded choice");
  });

  it("fails closed on an invalid project subject", () => {
    expect(() => buildZeroProjectChoiceProfile({ projectId: 0 })).toThrow(
      "zero_project_choices_subject_invalid",
    );
  });

  it("keeps the decision engine and its store bounded and read-only", () => {
    const engine = readFileSync(
      fileURLToPath(new URL("./zero-project-choices.ts", import.meta.url)),
      "utf8",
    );
    const store = readFileSync(
      fileURLToPath(new URL("./zero-project-choice-store.ts", import.meta.url)),
      "utf8",
    );
    expect(engine).not.toMatch(/@workspace\/db|Date\.now|new Date|Math\.random|fetch\(/);
    expect(store).toContain(".limit(MESSAGE_READ_LIMIT)");
    expect(store).toContain(".limit(KNOWLEDGE_READ_LIMIT)");
    expect(store).toContain('ne(knowledgeEntriesTable.origin, "ora")');
    expect(store).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
  });
});
