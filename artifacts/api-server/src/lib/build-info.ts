import { readFileSync } from "node:fs";

const GIT_OBJECT_ID = /^[0-9a-f]{40}$/;

export type ServedBuildInfo = Readonly<{
  commit: string;
  tree: string;
  builtAt: string;
}>;

export type UnknownBuildInfo = Readonly<{ identity: "unknown" }>;
export type ServedBuildIdentity = ServedBuildInfo | UnknownBuildInfo;

const UNKNOWN_BUILD_IDENTITY: UnknownBuildInfo = Object.freeze({ identity: "unknown" });

function isServedBuildInfo(value: unknown): value is ServedBuildInfo {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 3 &&
    typeof candidate.commit === "string" &&
    GIT_OBJECT_ID.test(candidate.commit) &&
    typeof candidate.tree === "string" &&
    GIT_OBJECT_ID.test(candidate.tree) &&
    typeof candidate.builtAt === "string" &&
    Number.isFinite(Date.parse(candidate.builtAt))
  );
}

export function readServedBuildIdentity(
  artifactUrl: URL = new URL("./build-info.json", import.meta.url),
): ServedBuildIdentity {
  try {
    const parsed = JSON.parse(readFileSync(artifactUrl, "utf8")) as unknown;
    return isServedBuildInfo(parsed) ? Object.freeze(parsed) : UNKNOWN_BUILD_IDENTITY;
  } catch {
    return UNKNOWN_BUILD_IDENTITY;
  }
}

const servedBuildIdentity = readServedBuildIdentity();

export function getServedBuildIdentity(): ServedBuildIdentity {
  return servedBuildIdentity;
}

export function getServedBuildCommit(): string {
  return "commit" in servedBuildIdentity ? servedBuildIdentity.commit : "unknown";
}
