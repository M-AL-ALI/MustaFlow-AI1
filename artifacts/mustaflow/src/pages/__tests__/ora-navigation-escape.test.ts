import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const readPage = (name: string) =>
  readFileSync(path.join(__dirname, "..", name), "utf8").replace(/\r\n/g, "\n");

describe("Ora website navigation escape paths", () => {
  it("secondary Ora pages expose a visible Back to Ora link", () => {
    for (const page of [
      "ora-settings.tsx",
      "ora-memory.tsx",
      "ora-library.tsx",
      "ora-new-project.tsx",
    ]) {
      const source = readPage(page);
      expect(source).toMatch(/href="\/ora"|setLocation\("\/ora"\)/);
      expect(source).toContain("Back to Ora");
    }
  });
});
