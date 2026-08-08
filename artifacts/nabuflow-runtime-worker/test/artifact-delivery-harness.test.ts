import { describe, expect, it } from "vitest";
import {
  assertDeclaredEntrypointDelivered,
  deliverScratchArtifact,
} from "../scripts/artifact-delivery";

describe("artifact delivery harness entrypoint guard", () => {
  it("accepts a declared entrypoint present in the exact delivered file set", () => {
    expect(() =>
      assertDeclaredEntrypointDelivered(["node", "./server.mjs"], ["server.mjs", "asset.bin"]),
    ).not.toThrow();
  });

  it("fails before upload when the manifest entrypoint is absent", async () => {
    let signedRequests = 0;
    await expect(
      deliverScratchArtifact({
        runtimePath: "/_nabuflow/control/v1/runtimes/1/preview/primary",
        locator: { projectId: 1, role: "preview", slot: "primary" },
        deploymentVersion: "version-1",
        targetRuntimeIdentity: "nrf-0123456789abcdef-p1-preview-primary",
        manifestRevision: "manifest-1",
        artifactRevision: "artifact-1",
        sourceRevision: "source-1",
        manifestStartCommand: ["node", "server.mjs"],
        serverPath: "server.cjs",
        serverSource: "console.log('never uploaded')",
        send: () => {
          signedRequests += 1;
          throw new Error("upload must not begin");
        },
      }),
    ).rejects.toThrow(/^HARNESS_ENTRYPOINT_MISSING:/u);
    expect(signedRequests).toBe(0);
  });

  it("fails closed when a direct entrypoint cannot be resolved", () => {
    expect(() => assertDeclaredEntrypointDelivered(["npm", "start"], ["server.cjs"])).toThrow(
      /^HARNESS_ENTRYPOINT_UNRESOLVED:/u,
    );
  });
});
