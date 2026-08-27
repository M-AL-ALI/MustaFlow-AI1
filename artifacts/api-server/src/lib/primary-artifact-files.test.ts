import { describe, expect, it } from "vitest";
import { compareUtf8 } from "@workspace/tenant-runtime-contracts";
import { selectPrimaryArtifactFiles } from "./primary-artifact-files";

const PROJECT_52_ROWS = [
  {
    projectId: 52,
    artifactId: 100,
    path: "src/index.ts",
    content: "primary server",
    mimeType: "text/typescript",
  },
  {
    projectId: 52,
    artifactId: 101,
    path: "src/index.ts",
    content: "sibling server",
    mimeType: "text/typescript",
  },
  {
    projectId: 52,
    artifactId: 101,
    path: "package.json",
    content: "sibling package",
    mimeType: "application/json",
  },
  {
    projectId: 52,
    artifactId: 100,
    path: "package.json",
    content: "primary package",
    mimeType: "application/json",
  },
  {
    projectId: 52,
    artifactId: 100,
    path: "src/é.ts",
    content: "utf8 path",
    mimeType: "text/typescript",
  },
  {
    projectId: 51,
    artifactId: 100,
    path: "other-project.ts",
    content: "wrong project",
    mimeType: "text/typescript",
  },
] as const;

describe("primary artifact file boundary", () => {
  it("keeps Project 52's overlapping sibling paths out of the executable file set", () => {
    const selected = selectPrimaryArtifactFiles(PROJECT_52_ROWS, 52, 100);

    expect(selected.map((file) => [file.path, file.content])).toEqual([
      ["package.json", "primary package"],
      ["src/index.ts", "primary server"],
      ["src/é.ts", "utf8 path"],
    ]);
    expect(new Set(selected.map((file) => file.path)).size).toBe(selected.length);
  });

  it("uses the trusted-build UTF-8 ordering without mutating the database rows", () => {
    const before = [...PROJECT_52_ROWS];
    const selected = selectPrimaryArtifactFiles(PROJECT_52_ROWS, 52, 100);

    expect(selected.map((file) => file.path)).toEqual(
      selected.map((file) => file.path).sort(compareUtf8),
    );
    expect(PROJECT_52_ROWS).toEqual(before);
  });

  it("treats the legacy null artifact as one scope, never as every artifact", () => {
    const selected = selectPrimaryArtifactFiles(
      [
        ...PROJECT_52_ROWS,
        {
          projectId: 52,
          artifactId: null,
          path: "legacy.html",
          content: "legacy",
          mimeType: "text/html",
        },
      ],
      52,
      null,
    );

    expect(selected).toEqual([{ path: "legacy.html", content: "legacy", mimeType: "text/html" }]);
  });
});
