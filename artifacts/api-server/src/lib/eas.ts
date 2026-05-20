// ─────────────────────────────────────────────────────────────────────────────
// EAS (Expo Application Services) API client
//
// Wraps the EAS REST API v1 for triggering cloud builds and submissions.
// All calls require a user-provided EAS_ACCESS_TOKEN stored in project secrets.
//
// EAS API docs: https://api.expo.dev/v1
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "./logger";

const EAS_API_BASE = "https://api.expo.dev/v1";

export type EasPlatform = "ios" | "android";

export type EasBuildStatus =
  | "new"
  | "in-queue"
  | "in-progress"
  | "finished"
  | "errored"
  | "canceled"
  | "timed-out";

export interface EasBuild {
  id: string;
  status: EasBuildStatus;
  platform: EasPlatform;
  artifacts?: {
    buildUrl?: string | null;
    applicationArchiveUrl?: string | null;
  };
  error?: {
    errorCode?: string;
    message?: string;
  } | null;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
  expirationDate?: string | null;
}

export interface EasSubmission {
  id: string;
  status: string;
  platform: EasPlatform;
  createdAt: string;
}

export interface TriggerBuildInput {
  accessToken: string;
  appSlug: string;
  appOwner: string;
  platform: EasPlatform;
  profile?: string;
}

export interface TriggerSubmitInput {
  accessToken: string;
  buildId: string;
  platform: EasPlatform;
  appOwner: string;
}

async function easFetch<T>(
  path: string,
  accessToken: string,
  options?: RequestInit,
): Promise<T> {
  const url = `${EAS_API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...(options?.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`EAS API error ${res.status}: ${body.slice(0, 300)}`);
  }

  return res.json() as Promise<T>;
}

/**
 * Trigger an EAS cloud build.
 * Returns the EAS build object (with id, status, etc).
 */
export async function triggerEasBuild(input: TriggerBuildInput): Promise<EasBuild> {
  const { accessToken, appSlug, appOwner, platform, profile = "production" } = input;

  logger.info({ platform, appSlug, appOwner }, "Triggering EAS build");

  const body = {
    appId: `@${appOwner}/${appSlug}`,
    platform,
    buildProfile: profile,
    autoSubmit: false,
  };

  const result = await easFetch<{ data: EasBuild }>(
    "/builds",
    accessToken,
    { method: "POST", body: JSON.stringify(body) },
  );

  return result.data;
}

/**
 * Poll the status of an EAS build.
 */
export async function getEasBuildStatus(
  accessToken: string,
  buildId: string,
): Promise<EasBuild> {
  const result = await easFetch<{ data: EasBuild }>(
    `/builds/${buildId}`,
    accessToken,
  );
  return result.data;
}

/**
 * Trigger EAS Submit to send the build to TestFlight (iOS) or Play Store Internal Testing (Android).
 */
export async function triggerEasSubmit(input: TriggerSubmitInput): Promise<EasSubmission> {
  const { accessToken, buildId, platform } = input;

  logger.info({ buildId, platform }, "Triggering EAS submit");

  const body = {
    buildId,
    platform,
    submissionProfile: "production",
  };

  const result = await easFetch<{ data: EasSubmission }>(
    "/submissions",
    accessToken,
    { method: "POST", body: JSON.stringify(body) },
  );

  return result.data;
}

/**
 * Fetch build log chunks for a build.
 * Returns raw log text (may be empty if not yet available).
 */
export async function getEasBuildLogs(
  accessToken: string,
  buildId: string,
): Promise<string> {
  try {
    const result = await easFetch<{ data?: { logs?: string } }>(
      `/builds/${buildId}/logs`,
      accessToken,
    );
    return result.data?.logs ?? "";
  } catch (err) {
    logger.warn({ err, buildId }, "Failed to fetch EAS build logs");
    return "";
  }
}

/**
 * Map an EAS build status to a DeploymentLog status.
 */
export function mapEasStatusToDeploymentStatus(
  easStatus: EasBuildStatus,
): "queued" | "building" | "passed" | "failed" {
  switch (easStatus) {
    case "new":
    case "in-queue":
      return "queued";
    case "in-progress":
      return "building";
    case "finished":
      return "passed";
    case "errored":
    case "timed-out":
    case "canceled":
      return "failed";
    default:
      return "building";
  }
}
