import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readPlusMenu(): string {
  const source = readFileSync(
    resolve(process.cwd(), "src/pages/projects/components/queue-composer.tsx"),
    "utf8",
  );
  const trigger = source.indexOf('title="More composer actions"');
  const start = source.indexOf("<DropdownMenuContent", trigger);
  const end = source.indexOf("</DropdownMenuContent>", start);
  expect(trigger).toBeGreaterThan(-1);
  expect(start).toBeGreaterThan(trigger);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("QueueComposer plus menu", () => {
  it("contains only the audited, plain-language action set", () => {
    const menu = readPlusMenu();

    for (const label of [
      "Create",
      "Generate image",
      "Brainstorm",
      "Templates",
      "Plan",
      "Plan first",
      "Plan history",
      "Explain my app",
      "Run",
      "Work in background",
      "Add queued task",
      "Fix or improve...",
    ]) {
      expect(menu).toContain(label);
    }

    for (const removed of [
      "Generate variants",
      "Debug project",
      "Review project",
      "Explain project",
      "Improve project",
      "Fix tests",
      "Fix TypeScript",
      "Fix lint",
    ]) {
      expect(menu).not.toContain(removed);
    }
  });

  it("keeps modes in the dedicated Mode control", () => {
    const menu = readPlusMenu();
    for (const mode of ["Lite", "Eco", "Power", "Pro", "Deep Reasoning"]) {
      expect(menu).not.toMatch(new RegExp(`>\\s*${mode}\\s*<`));
    }
  });

  it("keeps design variants reachable as a contextual action", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/pages/projects/components/queue-composer.tsx"),
      "utf8",
    );
    expect(source).toContain("!isBusy && isDesignIntent && !variantMode");
    expect(source).toContain("Generate 2 variants");
  });
});
