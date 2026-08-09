import { sha256Hex } from "@workspace/tenant-runtime-contracts";

export function trustedBuildRequestObjectKey(requestId: string, sha256: string): string {
  return `quarantine/requests/${requestId}/${sha256}.json`;
}

export function trustedBuildSourceObjectKey(requestId: string, sha256: string): string {
  return `quarantine/requests/${requestId}/source/${sha256}`;
}

export function trustedBuildOutputMetadataKey(buildId: string, sha256: string): string {
  return `outputs/${buildId}/metadata/${sha256}.json`;
}

export function trustedBuildOutputChunkKey(
  buildId: string,
  scope: "app" | "layer",
  contentSha256: string,
  chunkIndex: number,
): string {
  return `outputs/${buildId}/${scope}/${contentSha256}/chunks/${chunkIndex}`;
}

export function trustedBuildStagingChunkKey(
  buildId: string,
  attempt: number,
  pass: 1 | 2,
  root: "app" | "dependencies",
  chunkIndex: number,
  sha256: string,
): string {
  return `outputs/${buildId}/staging/attempt-${attempt}/pass-${pass}/${root}/${chunkIndex}-${sha256}`;
}

export async function putTrustedBuildObject(
  bucket: R2Bucket,
  key: string,
  bytes: Uint8Array,
  expectedSha256: string,
): Promise<"stored" | "exists"> {
  if ((await sha256Hex(bytes)) !== expectedSha256) {
    throw new Error("Trusted-build object does not match its content address");
  }
  const existing = await bucket.get(key);
  if (existing !== null) {
    const existingBytes = new Uint8Array(await existing.arrayBuffer());
    if (existingBytes.byteLength !== bytes.byteLength) {
      throw new Error("Trusted-build content address conflicts with stored bytes");
    }
    for (let index = 0; index < bytes.byteLength; index += 1) {
      if (existingBytes[index] !== bytes[index]) {
        throw new Error("Trusted-build content address conflicts with stored bytes");
      }
    }
    return "exists";
  }
  await bucket.put(key, bytes.slice().buffer, {
    sha256: expectedSha256,
    onlyIf: { etagDoesNotMatch: "*" },
    customMetadata: { sha256: expectedSha256 },
  });
  const readback = await bucket.get(key);
  if (readback === null) throw new Error("Trusted-build object disappeared after write");
  const readbackBytes = new Uint8Array(await readback.arrayBuffer());
  if ((await sha256Hex(readbackBytes)) !== expectedSha256) {
    throw new Error("Trusted-build object failed readback verification");
  }
  return "stored";
}

export async function readTrustedBuildObject(
  bucket: R2Bucket,
  key: string,
  expectedSha256: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const object = await bucket.get(key);
  if (object === null || object.size > maxBytes) {
    throw new Error("Trusted-build object is unavailable");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if ((await sha256Hex(bytes)) !== expectedSha256) {
    throw new Error("Trusted-build object failed integrity verification");
  }
  return bytes;
}

export async function deleteTrustedBuildPrefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let cursor: string | undefined;
  let deleted = 0;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1_000 });
    if (page.objects.length > 0) {
      await bucket.delete(page.objects.map((object) => object.key));
      deleted += page.objects.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return deleted;
}

export async function listTrustedBuildObjects(bucket: R2Bucket): Promise<{
  objects: number;
  bytes: number;
  quarantineObjects: number;
}> {
  let cursor: string | undefined;
  let objects = 0;
  let bytes = 0;
  let quarantineObjects = 0;
  do {
    const page = await bucket.list({ cursor, limit: 1_000 });
    for (const object of page.objects) {
      objects += 1;
      bytes += object.size;
      if (object.key.startsWith("quarantine/")) quarantineObjects += 1;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return { objects, bytes, quarantineObjects };
}
