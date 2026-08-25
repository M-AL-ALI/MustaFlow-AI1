import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildZeroProjectMemoryProfile,
  presentZeroProjectMemory,
  ZERO_PROJECT_MEMORY_FACT_KINDS,
  ZERO_PROJECT_MEMORY_SEMANTICS,
  zeroProjectMemoryContext,
} from "./zero-project-memory";

const completeInput = {
  projectId: 52,
  projectName: "IRQ TEL",
  description: "A public Iraqi flag site for visitors on mobile phones.",
  summary: "A Node and Express app now serves the animated flag page.",
  lastTaskSummary: "Make the flag wave smoothly.",
  conversationSummary: "The founder chose a dark background and no sign-in.",
} as const;

describe("Zero per-app memory", () => {
  it("assembles the four durable app-context facts with their sources", () => {
    const profile = buildZeroProjectMemoryProfile(completeInput);
    expect(profile.semantics).toBe(ZERO_PROJECT_MEMORY_SEMANTICS);
    expect(profile.subject).toEqual({ projectId: 52 });
    expect(profile.facts.map(({ kind }) => kind)).toEqual(ZERO_PROJECT_MEMORY_FACT_KINDS);
    expect(profile.facts.map(({ source }) => source)).toEqual([
      "project-description",
      "project-summary",
      "last-task-summary",
      "conversation-summary",
    ]);
  });

  it("presents human-readable continuity while keeping source truth explicit", () => {
    const text = zeroProjectMemoryContext(completeInput);
    expect(text).toContain("Purpose and audience [project-description]");
    expect(text).toContain("What is built now [project-summary]");
    expect(text).toContain("Latest work [last-task-summary]");
    expect(text).toContain("Earlier conversation [conversation-summary]");
    expect(text).toContain("without asking the user to repeat it");
    expect(text).toContain("Current project files");
    expect(text).toContain("Do not present an inference");
  });

  it("includes source-bound decisions and rejections in the one coherent project memory", () => {
    const text = zeroProjectMemoryContext({
      projectId: 52,
      projectName: "IRQ TEL",
      choices: {
        semantics: "zero-project-choices-v1",
        subject: { projectId: 52 },
        choices: [
          {
            kind: "explicit-rejection",
            text: "No database",
            source: { kind: "user-message", id: 900 },
          },
        ],
      },
    });
    expect(text).toContain("VERIFIED PROJECT DECISIONS AND REJECTIONS");
    expect(text).toContain("Explicit rejection [user-message#900]: No database");
  });

  it("fails closed when choice evidence belongs to another project", () => {
    const text = zeroProjectMemoryContext({
      projectId: 52,
      projectName: "IRQ TEL",
      choices: {
        semantics: "zero-project-choices-v1",
        subject: { projectId: 7 },
        choices: [
          {
            kind: "accepted-decision",
            text: "Wrong project",
            source: { kind: "project-knowledge", id: 1 },
          },
        ],
      },
    });
    expect(text).toBeUndefined();
  });

  it("is deterministic, serialization-ready, bounded, and does not mutate its input", () => {
    const input = {
      ...completeInput,
      summary: `  ${"built ".repeat(600)}  `,
    };
    const before = JSON.stringify(input);
    const first = buildZeroProjectMemoryProfile(input);
    const second = buildZeroProjectMemoryProfile({ ...input });
    expect(first).toEqual(second);
    expect(JSON.stringify(input)).toBe(before);
    expect(first.facts.find(({ kind }) => kind === "built-state")?.text.length).toBe(1_600);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });

  it("deduplicates identical persisted facts and emits nothing without evidence", () => {
    const same = buildZeroProjectMemoryProfile({
      projectId: 7,
      projectName: "Same",
      description: "One app",
      summary: " One   app ",
    });
    expect(same.facts).toHaveLength(1);
    expect(
      presentZeroProjectMemory(
        buildZeroProjectMemoryProfile({ projectId: 7, projectName: "Empty" }),
      ),
    ).toBeUndefined();
  });

  it("fails closed on an invalid project subject", () => {
    expect(() => buildZeroProjectMemoryProfile({ projectId: 0, projectName: "Invalid" })).toThrow(
      "zero_project_memory_subject_invalid",
    );
  });

  it("keeps profile construction pure and free of time, randomness, database, or network access", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./zero-project-memory.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toMatch(
      /@workspace\/db|Date\.now|new Date|Math\.random|fetch\(|\.insert\(|\.update\(|\.delete\(/,
    );
  });

  it("wires one coherent memory context into build and both converse paths", () => {
    const messages = readFileSync(
      fileURLToPath(new URL("../routes/messages.ts", import.meta.url)),
      "utf8",
    );
    const jobs = readFileSync(fileURLToPath(new URL("./jobs.ts", import.meta.url)), "utf8");
    const builder = readFileSync(fileURLToPath(new URL("./builder.ts", import.meta.url)), "utf8");

    expect(messages).toContain("zeroProjectMemoryContext({");
    expect(messages.match(/loadZeroProjectChoices\(project\.id\)/g)).toHaveLength(2);
    expect(messages.match(/conversationSummary: projectMemoryContext/g)).toHaveLength(2);
    expect(jobs).toContain("zeroProjectMemoryContext({");
    expect(jobs).toContain("loadZeroProjectChoices(projectId)");
    expect(builder).toContain("conversationSummary?: string;");
    expect(builder.match(/Earlier conversation context/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
