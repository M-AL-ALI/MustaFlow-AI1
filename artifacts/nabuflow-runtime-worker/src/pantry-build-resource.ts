import {
  sha256Hex,
  type PantryCaptureBuildResourceRequest,
} from "@workspace/tenant-runtime-contracts";
import { PantryIngestError } from "./pantry-registry-client";

const MAX_REDIRECTS = 5;

export interface CapturedBuildResource {
  url: string;
  bytes: Uint8Array;
  contentSha256: string;
  mediaType: string;
  redirects: number;
}

function forbiddenHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  if (
    host === "localhost" ||
    host === "metadata.google.internal" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".home.arpa") ||
    host.includes(":") ||
    /^[0-9.]+$/u.test(host)
  ) {
    return true;
  }
  return host.length === 0 || host.length > 253 || !host.includes(".");
}

function validateUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PantryIngestError("integrity_mismatch", "Build resource URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    (url.port !== "" && url.port !== "443") ||
    forbiddenHostname(url.hostname) ||
    url.hash !== ""
  ) {
    throw new PantryIngestError("integrity_mismatch", "Build resource destination is forbidden");
  }
  return url;
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new PantryIngestError("stocking_size_limit", "Build resource exceeded its size limit");
  }
  if (response.body === null) {
    throw new PantryIngestError("upstream_unavailable", "Build resource response was empty", true);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new PantryIngestError("stocking_size_limit", "Build resource exceeded its size limit");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function capturePantryBuildResource(
  request: PantryCaptureBuildResourceRequest,
  fetcher: typeof fetch = fetch,
): Promise<CapturedBuildResource> {
  let url = validateUrl(request.url);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    let response: Response;
    try {
      response = await fetcher(url, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        headers: { accept: "application/octet-stream,application/json;q=0.9,*/*;q=0.1" },
      });
    } catch {
      throw new PantryIngestError("upstream_unavailable", "Build resource is unavailable", true);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location === null || redirects === MAX_REDIRECTS) {
        throw new PantryIngestError("upstream_unavailable", "Build resource redirect failed", true);
      }
      url = validateUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) {
      throw new PantryIngestError("upstream_unavailable", "Build resource is unavailable", true);
    }
    if (response.headers.has("set-cookie")) {
      throw new PantryIngestError("integrity_mismatch", "Build resource response set a cookie");
    }
    const bytes = await readCapped(response, request.maxBytes);
    const contentSha256 = await sha256Hex(bytes);
    if (request.expectedSha256 !== null && request.expectedSha256 !== contentSha256) {
      throw new PantryIngestError("integrity_mismatch", "Build resource integrity did not match");
    }
    const mediaType = (response.headers.get("content-type") ?? "application/octet-stream")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (!/^[\x20-\x7e]{1,200}$/u.test(mediaType)) {
      throw new PantryIngestError("integrity_mismatch", "Build resource media type was invalid");
    }
    return { url: url.toString(), bytes, contentSha256, mediaType, redirects };
  }
  throw new PantryIngestError("upstream_unavailable", "Build resource redirect failed", true);
}
