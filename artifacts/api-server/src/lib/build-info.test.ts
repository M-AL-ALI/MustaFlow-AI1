import { mkdir, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readServedBuildIdentity } from "./build-info";

const fixtureDirectory = path.resolve(".tmp-build-info-test");

afterEach(async () => {
  await rm(fixtureDirectory, { recursive: true, force: true });
});

describe("served build-info artifact", () => {
  it("reads a complete build identity verbatim", async () => {
    const identity = {
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      builtAt: "2026-08-22T12:34:56.000Z",
    };
    await mkdir(fixtureDirectory, { recursive: true });
    const artifactPath = path.join(fixtureDirectory, "build-info.json");
    await writeFile(artifactPath, JSON.stringify(identity), "utf8");

    expect(readServedBuildIdentity(pathToFileURL(artifactPath))).toEqual(identity);
  });

  it.each([
    ["absent", "missing-build-info.json"],
    ["malformed", "malformed-build-info.json"],
  ])("returns an honest unknown identity when the artifact is %s", async (kind, filename) => {
    await mkdir(fixtureDirectory, { recursive: true });
    const artifactPath = path.join(fixtureDirectory, filename);
    if (kind === "malformed") {
      await writeFile(artifactPath, '{"commit":"not-a-git-object"}', "utf8");
    }

    expect(readServedBuildIdentity(pathToFileURL(artifactPath))).toEqual({
      identity: "unknown",
    });
  });
});
