import type { RuntimeLocator } from "@workspace/tenant-runtime-contracts";
import { sealRuntimeArtifact } from "../../api-server/src/lib/runtime-artifact";

export interface ArtifactSignedRequestInput {
  path: string;
  method: string;
  body: unknown | Uint8Array;
  nonce: string;
  idempotencyKey: string;
}

interface ArtifactControlResult {
  response: Response;
  body: unknown;
}

export async function deliverScratchArtifact(input: {
  runtimePath: string;
  locator: RuntimeLocator;
  deploymentVersion: string;
  targetRuntimeIdentity: string;
  manifestRevision: string;
  artifactRevision: string;
  sourceRevision: string;
  manifestStartCommand: readonly string[];
  serverPath: string;
  serverSource: string;
  additionalFiles?: Array<{
    path: string;
    content: string | Uint8Array;
    mode?: 0o644 | 0o755;
  }>;
  send: (request: ArtifactSignedRequestInput, label: string) => Promise<ArtifactControlResult>;
}): Promise<{
  artifactRevision: string;
  sealedArtifactSha256: string;
  contentSha256: string;
}> {
  const files = [
    { path: input.serverPath, content: input.serverSource },
    ...(input.additionalFiles ?? []),
  ];
  assertDeclaredEntrypointDelivered(
    input.manifestStartCommand,
    files.map((file) => file.path),
  );
  const artifact = await sealRuntimeArtifact({
    targetRuntimeIdentity: input.targetRuntimeIdentity,
    manifestRevision: input.manifestRevision,
    artifactRevision: input.artifactRevision,
    sourceRevision: input.sourceRevision,
    files,
  });
  const artifactPath = `${input.runtimePath}/artifacts/${artifact.envelope.sealedArtifactSha256}`;
  const begin = await input.send(
    {
      path: `${artifactPath}/begin`,
      method: "POST",
      body: {
        locator: input.locator,
        expectedDeploymentVersion: input.deploymentVersion,
        envelope: artifact.envelope,
      },
      nonce: `artifact-begin-${crypto.randomUUID()}`,
      idempotencyKey: `artifact:${artifact.envelope.sealedArtifactSha256}:begin`,
    },
    "artifact.begin",
  );
  assertControlStatus("artifact.begin", begin, 200);

  for (let chunkIndex = 0; chunkIndex < artifact.chunks.length; chunkIndex += 1) {
    const chunk = await input.send(
      {
        path: `${artifactPath}/chunks/${chunkIndex}`,
        method: "PUT",
        body: artifact.chunks[chunkIndex],
        nonce: `artifact-chunk-${chunkIndex}-${crypto.randomUUID()}`,
        idempotencyKey: `artifact:${artifact.envelope.sealedArtifactSha256}:chunk:${chunkIndex}`,
      },
      `artifact.chunk.${chunkIndex}`,
    );
    assertControlStatus(`artifact.chunk.${chunkIndex}`, chunk, 200);
  }

  const commit = await input.send(
    {
      path: `${artifactPath}/commit`,
      method: "POST",
      body: {
        locator: input.locator,
        expectedDeploymentVersion: input.deploymentVersion,
        sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
      },
      nonce: `artifact-commit-${crypto.randomUUID()}`,
      idempotencyKey: `artifact:${artifact.envelope.sealedArtifactSha256}:commit`,
    },
    "artifact.commit",
  );
  assertControlStatus("artifact.commit", commit, 200);

  return {
    artifactRevision: artifact.envelope.artifactRevision,
    sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
    contentSha256: artifact.envelope.contentSha256,
  };
}

export function assertDeclaredEntrypointDelivered(
  manifestStartCommand: readonly string[],
  deliveredPaths: readonly string[],
): void {
  const [executable, rawEntrypoint] = manifestStartCommand;
  if (executable !== "node" || !rawEntrypoint || rawEntrypoint.startsWith("-")) {
    throw new Error(
      "HARNESS_ENTRYPOINT_UNRESOLVED: scratch artifact harness requires a direct node entrypoint",
    );
  }
  const entrypoint = rawEntrypoint.replace(/^\.\//u, "");
  if (!deliveredPaths.includes(entrypoint)) {
    throw new Error(
      `HARNESS_ENTRYPOINT_MISSING: manifest declares ${JSON.stringify(entrypoint)}, but the sealed file set does not contain it`,
    );
  }
}

function assertControlStatus(label: string, result: ArtifactControlResult, expected: number): void {
  if (result.response.status !== expected) {
    const code = (result.body as { code?: string } | null)?.code ?? "unknown";
    throw new Error(
      `${label}: expected HTTP ${expected}, received ${result.response.status} (${code})`,
    );
  }
}
