import { describe, expect, it } from "vitest";
import {
  ZERO_SEALED_BUILD_PLATFORM,
  pantryCatalogShelfManifestHash,
  pantryCatalogShelfRecordSchema,
  trustedBuildDependencyIntentHash,
  verifyTrustedBuildRequest,
} from "@workspace/tenant-runtime-contracts";
import { makeZeroTrustedBuildRequest } from "../../api-server/src/lib/zero-generation-kitchen";
import { makePantryFixture } from "../scripts/pantry-catalog-fixture";

async function committedFixtureShelf() {
  const fixture = await makePantryFixture();
  const { assemblyId: _assemblyId, ...core } = fixture.commit;
  const committedAt = "2026-08-08T17:01:00.000Z";
  const unsigned = {
    ...core,
    state: {
      ...core.state,
      state: "committed" as const,
      stateRevision: 1,
      updatedAt: committedAt,
    },
    committedAt,
  };
  return pantryCatalogShelfRecordSchema.parse({
    ...unsigned,
    manifestSha256: await pantryCatalogShelfManifestHash(unsigned),
  });
}

const dependencyPlan = {
  format: "nabu-zero-generation/v1" as const,
  schemaVersion: 1 as const,
  target: "cloudflare-sealed-staging-v1" as const,
  intents: [{ ecosystem: "npm" as const, name: "@fixture/heavy-app", selector: "^1.0.0" }],
};

describe("Zero trusted-kitchen request", () => {
  it("turns generated source into a deterministic Pantry-only build request", async () => {
    const shelf = await committedFixtureShelf();
    const input = {
      files: [
        { path: "src/index.ts", content: "export const ok = true;\n", mimeType: "text/typescript" },
        {
          path: "package.json",
          content: '{"scripts":{"build":"tsc"}}\n',
          mimeType: "application/json",
        },
      ],
      dependencyPlan,
      shelf,
      createdAt: "2026-08-08T17:02:00.000Z",
    };
    const first = await makeZeroTrustedBuildRequest(input);
    const second = await makeZeroTrustedBuildRequest(input);

    expect(second).toEqual(first);
    expect(first.input.platform).toEqual(ZERO_SEALED_BUILD_PLATFORM);
    expect(first.input.buildCommand).toEqual(["npm", "run", "build"]);
    expect(first.output).toEqual({
      strategy: "bundle-first",
      dependencyPackaging: "layer",
      appDirectory: "dist",
      dependencyLayerMountPath: "node_modules",
    });
    expect(first.input.dependencyIntentSha256).toBe(
      await trustedBuildDependencyIntentHash(dependencyPlan.intents),
    );
    await expect(verifyTrustedBuildRequest(first)).resolves.toMatchObject({ ok: true });
    expect(JSON.stringify(first)).not.toMatch(/npmjs\.org|DATABASE_URL|STRIPE_SECRET_KEY/u);
  });
});
