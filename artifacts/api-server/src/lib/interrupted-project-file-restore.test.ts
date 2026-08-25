import { describe, expect, it, vi } from "vitest";

vi.mock("./project-file-writer", () => ({ writeProjectFilesAtomically: vi.fn() }));

import { restoreInterruptedProjectFiles } from "./interrupted-project-file-restore";

describe("interrupted project-file restore", () => {
  it("atomically restores the exact pre-run file set after a committed mutation", async () => {
    const writeFiles = vi.fn().mockResolvedValue({ authoritativeVersion: null });
    const restoreRuntime = vi.fn().mockResolvedValue(undefined);
    const preRunFiles = [
      { path: "src/index.ts", content: "before", mimeType: "application/typescript" },
      { path: "package.json", content: "{}", mimeType: "application/json" },
    ];

    await expect(
      restoreInterruptedProjectFiles(
        {
          projectId: 52,
          preRunFiles,
          databaseCommitted: true,
          runtimeMayHaveMutated: true,
          changedPaths: ["src/index.ts", "deleted.ts", "src/index.ts"],
        },
        { writeFiles, restoreRuntime },
      ),
    ).resolves.toEqual({ restored: true, remainingChangedPaths: [] });
    expect(writeFiles).toHaveBeenCalledWith({
      projectId: 52,
      scope: { kind: "artifact" },
      files: preRunFiles,
      replaceAll: true,
    });
    expect(restoreRuntime).toHaveBeenCalledWith({
      files: preRunFiles,
      removedPaths: ["deleted.ts"],
    });
  });

  it("carries the real changed paths when the restore cannot be proven", async () => {
    const writeFiles = () => {
      throw new Error("test restore unavailable");
    };

    const result = await restoreInterruptedProjectFiles(
      {
        projectId: 52,
        preRunFiles: [{ path: "index.html", content: "before", mimeType: "text/html" }],
        databaseCommitted: true,
        runtimeMayHaveMutated: false,
        changedPaths: ["z.ts", "a.ts"],
      },
      { writeFiles },
    );

    expect(result).toEqual({
      restored: false,
      remainingChangedPaths: ["a.ts", "z.ts"],
      errorClass: "Error",
    });
  });

  it("carries changed paths when database truth is restored but runtime convergence fails", async () => {
    const writeFiles = vi.fn().mockResolvedValue({ authoritativeVersion: null });
    const restoreRuntime = () => {
      throw new TypeError("test runtime restore unavailable");
    };

    const result = await restoreInterruptedProjectFiles(
      {
        projectId: 52,
        preRunFiles: [{ path: "index.html", content: "before", mimeType: "text/html" }],
        databaseCommitted: true,
        runtimeMayHaveMutated: true,
        changedPaths: ["index.html", "created.ts"],
      },
      { writeFiles, restoreRuntime },
    );

    expect(result).toEqual({
      restored: false,
      remainingChangedPaths: ["created.ts", "index.html"],
      errorClass: "TypeError",
    });
  });

  it("restores runtime-only writes made before the database commit boundary", async () => {
    const writeFiles = vi.fn();
    const restoreRuntime = vi.fn().mockResolvedValue(undefined);
    const preRunFiles = [{ path: "index.html", content: "before", mimeType: "text/html" }];

    await expect(
      restoreInterruptedProjectFiles(
        {
          projectId: 52,
          preRunFiles,
          databaseCommitted: false,
          runtimeMayHaveMutated: true,
          changedPaths: ["created.ts", "index.html"],
        },
        { writeFiles, restoreRuntime },
      ),
    ).resolves.toEqual({ restored: true, remainingChangedPaths: [] });
    expect(writeFiles).not.toHaveBeenCalled();
    expect(restoreRuntime).toHaveBeenCalledWith({
      files: preRunFiles,
      removedPaths: ["created.ts"],
    });
  });

  it("performs no write when the interruption happened before commit", async () => {
    const writeFiles = vi.fn();
    await expect(
      restoreInterruptedProjectFiles(
        {
          projectId: 52,
          preRunFiles: null,
          databaseCommitted: false,
          runtimeMayHaveMutated: false,
          changedPaths: [],
        },
        { writeFiles },
      ),
    ).resolves.toEqual({ restored: false, remainingChangedPaths: [] });
    expect(writeFiles).not.toHaveBeenCalled();
  });
});
