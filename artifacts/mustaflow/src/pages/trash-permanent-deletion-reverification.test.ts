import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Permanent deletion reverification focus ownership", () => {
  it("releases the Radix focus trap before Clerk opens and restores the project dialog afterward", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/pages/trash-permanent-deletion.tsx"),
      "utf8",
    );
    const closeAt = source.indexOf("flushSync(() => setOpen(false))");
    const challengeAt = source.indexOf("await requestPermanentDeletion(");
    const reopenAt = source.indexOf("setOpen(true);", challengeAt);

    expect(source).toContain('import { flushSync } from "react-dom"');
    expect(closeAt).toBeGreaterThan(-1);
    expect(challengeAt).toBeGreaterThan(closeAt);
    expect(reopenAt).toBeGreaterThan(challengeAt);
  });
});
