import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Acceptance Provisioner deployment contract", () => {
  it("binds Worker version metadata for durable-operation dispatch", async () => {
    const config = await readFile(
      fileURLToPath(new URL("../wrangler.acceptance.jsonc", import.meta.url)),
      "utf8",
    );

    expect(config).toMatch(/"version_metadata"\s*:\s*\{\s*"binding"\s*:\s*"CF_VERSION_METADATA"/u);
  });
});
