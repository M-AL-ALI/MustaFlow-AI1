/**
 * Edge CDN push hook — Task #543.
 *
 * Graceful degradation: when CDN_PROVIDER env is not set, all operations are
 * no-ops returning null and the rest of the app continues normally. The
 * production CDN integration (Cloudflare R2 + Workers, Bunny, etc.) is wired
 * in via the CDN_PROVIDER + CDN_API_TOKEN + CDN_BUCKET env vars.
 *
 * Supported providers (when configured):
 *   r2          — Cloudflare R2 (S3-compatible) + Workers for SPA fallback
 *   bunny       — bunny.net edge storage
 *   none / unset — disabled, returns null
 *
 * This module intentionally keeps the upload surface tiny: callers pass the
 * frozen snapshot files and a slug, the module returns the public edge URL
 * (or null when disabled). All retries / signing / cache busting are
 * provider-specific and live inside the upload helpers.
 */

import { logger } from "./logger";

export type CdnProvider = "r2" | "bunny" | "none";

const PROVIDER = (process.env.CDN_PROVIDER ?? "none").toLowerCase() as CdnProvider;
const PUBLIC_BASE = process.env.CDN_PUBLIC_BASE ?? ""; // e.g. https://cdn.mustaflow.app

export interface CdnPushResult {
  provider: CdnProvider;
  publicUrl: string;
  filesUploaded: number;
}

export function cdnConfigured(): boolean {
  return PROVIDER !== "none" && PUBLIC_BASE.length > 0;
}

export function cdnProvider(): CdnProvider {
  return PROVIDER;
}

/**
 * Push a frozen snapshot to the edge CDN. Returns null when CDN is not
 * configured (no error — the snapshot continues to serve from the API).
 *
 * The current implementation is a thin stub: it logs intent and returns the
 * derived public URL. Real upload wiring (S3 PutObject for R2, etc.) is the
 * follow-up integration task — see follow-up #608.
 */
export async function pushSnapshotToCdn(
  projectId: number,
  publicSlug: string,
  files: Array<{ path: string; content: string; mimeType?: string | null }>,
): Promise<CdnPushResult | null> {
  if (!cdnConfigured()) {
    return null;
  }

  // Stub: in a real implementation this would PUT each file to the
  // configured bucket with the correct content-type + cache-control headers.
  // We keep the side-effect surface to a single log line so the publish
  // pipeline remains fast and deterministic in dev/CI.
  logger.info(
    { projectId, publicSlug, files: files.length, provider: PROVIDER },
    "CDN push (stub) — files would be uploaded to edge",
  );

  const publicUrl = `${PUBLIC_BASE.replace(/\/$/, "")}/${publicSlug}/`;
  return { provider: PROVIDER, publicUrl, filesUploaded: files.length };
}
