import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@workspace/db", () => ({ pool: { query: mocks.query } }));
import { automaticPreviewAdmitted, automaticPreviewRollout } from "./automatic-preview-admission";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NABUFLOW_AUTOMATIC_PREVIEWS_ENABLED", "true");
  vi.stubEnv("NABUFLOW_AUTOMATIC_PREVIEWS_SINCE", "2026-01-01T00:00:00Z");
});
afterEach(() => vi.unstubAllEnvs());

describe("execution-time automatic preview admission", () => {
  it.each(["tomorrow", "2026-02-30T00:00:00Z", "2027-01-01T00:00:00Z", "2026-01-01"])(
    "rejects invalid or future epoch %s",
    (value) => {
      expect(
        automaticPreviewRollout(
          {
            NABUFLOW_AUTOMATIC_PREVIEWS_ENABLED: "true",
            NABUFLOW_AUTOMATIC_PREVIEWS_SINCE: value,
          },
          Date.parse("2026-09-09T00:00:00Z"),
        ),
      ).toBeNull();
    },
  );
  it("does not capture old queued work after the rollout is disabled", async () => {
    vi.stubEnv("NABUFLOW_AUTOMATIC_PREVIEWS_ENABLED", "false");
    expect(await automaticPreviewAdmitted({ projectId: 81, versionId: 100 })).toBe(false);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("checks the current epoch rather than the enqueue epoch", async () => {
    const target = { projectId: 81, versionId: 100 };
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 100 }] }).mockResolvedValueOnce({ rows: [] });
    expect(await automaticPreviewAdmitted(target)).toBe(true);
    vi.stubEnv("NABUFLOW_AUTOMATIC_PREVIEWS_SINCE", "2026-09-01T00:00:00Z");
    expect(await automaticPreviewAdmitted(target)).toBe(false);
    expect(mocks.query.mock.calls[1]![1]).toEqual([new Date("2026-09-01T00:00:00Z"), 81, 100]);
    const sql = mocks.query.mock.calls[1]![0];
    for (const predicate of [
      "v.created_at >= $1",
      "p.deleted_at IS NULL",
      "MAX(current.id)",
      "task.terminal->>'outcome'='mutation_succeeded'",
      "p.container_status='running'",
    ]) {
      expect(sql).toContain(predicate);
    }
  });
  it("never admits a cleanup-only delivery to renderer work", async () => {
    expect(
      await automaticPreviewAdmitted({ projectId: 81, versionId: 100, cleanupOnly: true }),
    ).toBe(false);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
