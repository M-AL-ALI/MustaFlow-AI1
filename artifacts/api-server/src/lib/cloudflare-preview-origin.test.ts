import { generateKeyPairSync } from "node:crypto";
import { deriveRuntimeIdentity } from "@workspace/tenant-runtime-contracts";
import { describe, expect, it } from "vitest";
import { mintCloudflarePreviewGrant } from "./cloudflare-preview-grant";

function privateKey(): string {
  return generateKeyPairSync("ec", { namedCurve: "P-256" })
    .privateKey.export({
      format: "pem",
      type: "pkcs8",
    })
    .toString();
}

describe("Cloudflare production preview origin", () => {
  it("accepts a deployment-owned custom HTTPS origin and rejects non-origin or IP inputs", async () => {
    const runtimeId = await deriveRuntimeIdentity({
      namespace: "production",
      projectId: 42,
      role: "preview",
      slot: "primary",
    });
    const environment = {
      TENANT_RUNTIME_PROVIDER: "cloudflare",
      CLOUDFLARE_RUNTIME_CONTROL_URL: "https://runtime.mustaflow.com",
      CLOUDFLARE_RUNTIME_CONTROL_TOKEN: "runtime-control-token-built-at-runtime".repeat(2),
      CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE: "production",
      CLOUDFLARE_RUNTIME_PREVIEW_URL: "https://runtime.mustaflow.com",
      CLOUDFLARE_RUNTIME_PREVIEW_PRIVATE_KEY: privateKey(),
    };
    await expect(
      mintCloudflarePreviewGrant({ projectId: 42, runtimeId, servicePort: 8080 }, environment),
    ).resolves.toMatchObject({
      previewUrl: `https://runtime.mustaflow.com/_nabuflow/preview/v1/${runtimeId}/`,
    });
    await expect(
      mintCloudflarePreviewGrant(
        { projectId: 42, runtimeId, servicePort: 8080 },
        { ...environment, CLOUDFLARE_RUNTIME_PREVIEW_URL: "https://127.0.0.1" },
      ),
    ).rejects.toThrow(/public HTTPS hostname origin/u);
    await expect(
      mintCloudflarePreviewGrant(
        { projectId: 42, runtimeId, servicePort: 8080 },
        { ...environment, CLOUDFLARE_RUNTIME_PREVIEW_URL: "https://runtime.mustaflow.com/path" },
      ),
    ).rejects.toThrow(/only an HTTPS hostname origin/u);
  });
});
