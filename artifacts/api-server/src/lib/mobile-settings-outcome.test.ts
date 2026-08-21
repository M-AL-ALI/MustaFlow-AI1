import { describe, expect, it, vi } from "vitest";
import { saveMobileSettingsWithMetadata } from "./mobile-settings-outcome";

describe("mobile-settings outcome truth", () => {
  it("reports the committed save as successful and records later metadata failure", async () => {
    const durable: string[] = [];
    const failures: Array<{ stage: string; errorClass: string }> = [];
    const touchProject = vi.fn(async () => {
      durable.push("project-touched");
    });

    const response = await saveMobileSettingsWithMetadata({
      commitFilesAndVersion: async () => {
        durable.push("files-committed", "version-committed");
        return { saved: true };
      },
      metadata: [
        {
          stage: "task_completion",
          write: async () => {
            throw new TypeError("raw database detail");
          },
        },
        { stage: "project_touch", write: touchProject },
      ],
      recordFailure: (failure) => failures.push(failure),
    });

    expect(response).toEqual({ saved: true });
    expect(durable).toEqual(["files-committed", "version-committed", "project-touched"]);
    expect(touchProject).toHaveBeenCalledOnce();
    expect(failures).toEqual([{ stage: "task_completion", errorClass: "TypeError" }]);
    expect(JSON.stringify(failures)).not.toContain("raw database detail");
  });

  it("still rejects when the files and version do not commit", async () => {
    const writeMetadata = vi.fn(async () => undefined);

    await expect(
      saveMobileSettingsWithMetadata({
        commitFilesAndVersion: async () => {
          throw new Error("commit failed");
        },
        metadata: [{ stage: "task_completion", write: writeMetadata }],
        recordFailure: vi.fn(),
      }),
    ).rejects.toThrow("commit failed");

    expect(writeMetadata).not.toHaveBeenCalled();
  });

  it("does not let a diagnostics failure change the committed outcome", async () => {
    await expect(
      saveMobileSettingsWithMetadata({
        commitFilesAndVersion: async () => "saved",
        metadata: [
          {
            stage: "project_touch",
            write: async () => {
              throw new Error("metadata unavailable");
            },
          },
        ],
        recordFailure: () => {
          throw new Error("diagnostics unavailable");
        },
      }),
    ).resolves.toBe("saved");
  });
});
