import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { compareUtf8 } from "@workspace/tenant-runtime-contracts";
import {
  canonicalizePrimaryArtifactFiles,
  selectPrimaryArtifactFiles,
} from "./primary-artifact-files";

const PROJECT_52_ROWS = [
  {
    projectId: 52,
    artifactId: null,
    path: "nabuflow/runtime/index.ts",
    content: "legacy runtime adapter",
    mimeType: "text/typescript",
  },
  {
    projectId: 52,
    artifactId: null,
    path: "package.json",
    content: "legacy package",
    mimeType: "application/json",
  },
  {
    projectId: 52,
    artifactId: null,
    path: "src/index.ts",
    content: "legacy server",
    mimeType: "text/typescript",
  },
  {
    projectId: 52,
    artifactId: null,
    path: "tsconfig.json",
    content: "legacy compiler config",
    mimeType: "application/json",
  },
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
    path: "src/App.tsx",
    content: "sibling React app",
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
  it("canonicalizes a repeated staged path before trusted-build validation", () => {
    const selected = canonicalizePrimaryArtifactFiles([
      { path: "src/z.ts", content: "z", mimeType: "text/typescript" },
      { path: "src/a.ts", content: "old", mimeType: "text/typescript" },
      { path: "src/a.ts", content: "accepted", mimeType: "text/typescript" },
    ]);

    expect(selected).toEqual([
      { path: "src/a.ts", content: "accepted", mimeType: "text/typescript" },
      { path: "src/z.ts", content: "z", mimeType: "text/typescript" },
    ]);
  });

  it("routes reviewed staging snapshots through the canonicalizer", () => {
    const jobs = readFileSync(new URL("./jobs.ts", import.meta.url), "utf8");

    expect(jobs).toContain("canonicalizePrimaryArtifactFiles(");
    expect(jobs).toMatch(/canonicalizePrimaryArtifactFiles\(\s*stagingFiles\.map/);
  });

  it("composes Project 52's legacy base with primary overrides and excludes siblings", () => {
    const selected = selectPrimaryArtifactFiles(PROJECT_52_ROWS, 52, 100);

    expect(selected.map((file) => [file.path, file.content])).toEqual([
      ["nabuflow/runtime/index.ts", "legacy runtime adapter"],
      ["package.json", "primary package"],
      ["src/index.ts", "primary server"],
      ["src/é.ts", "utf8 path"],
      ["tsconfig.json", "legacy compiler config"],
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

  it("keeps primary overrides deterministic when database row order changes", () => {
    const forward = selectPrimaryArtifactFiles(PROJECT_52_ROWS, 52, 100);
    const reverse = selectPrimaryArtifactFiles([...PROJECT_52_ROWS].reverse(), 52, 100);

    expect(reverse).toEqual(forward);
  });

  it("treats the legacy null artifact as one complete scope when no primary exists", () => {
    const selected = selectPrimaryArtifactFiles(PROJECT_52_ROWS, 52, null);

    expect(selected.map((file) => file.path)).toEqual([
      "nabuflow/runtime/index.ts",
      "package.json",
      "src/index.ts",
      "tsconfig.json",
    ]);
  });

  it("keeps every message pipeline on the primary-artifact loader", () => {
    const source = readFileSync(new URL("../routes/messages.ts", import.meta.url), "utf8");

    expect(source.match(/loadPrimaryArtifactFiles\(project\.id\)/g)).toHaveLength(2);
    expect(source).not.toContain("projectFilesTable");
  });
});
