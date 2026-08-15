import { describe, expect, it } from "vitest";
import { ListTasksResponse } from "@workspace/api-zod";

describe("ListTasksResponse trusted-build failure evidence", () => {
  it("preserves sanitized terminal evidence in the task read contract", () => {
    const parsed = ListTasksResponse.parse([
      {
        id: 236,
        projectId: 51,
        title: "Run the production canary build",
        kind: "main",
        status: "failed",
        result: "Trusted build failed",
        report: {
          userRequest: "Run the production canary build.",
          filesCreated: [],
          filesChanged: [],
          filesRemoved: [],
          previewUpdated: false,
          warnings: [],
          failureEvidence: {
            code: "build_failed",
            message: "Trusted build failed",
            evidence: {
              stage: "trusted-build-wait",
              buildId: "pbuild_contract_evidence",
              attempt: 1,
            },
          },
        },
        createdAt: "2026-08-15T21:47:43.214Z",
      },
    ]);

    expect(parsed[0]?.report?.failureEvidence).toEqual({
      code: "build_failed",
      message: "Trusted build failed",
      evidence: {
        stage: "trusted-build-wait",
        buildId: "pbuild_contract_evidence",
        attempt: 1,
      },
    });
  });
});
