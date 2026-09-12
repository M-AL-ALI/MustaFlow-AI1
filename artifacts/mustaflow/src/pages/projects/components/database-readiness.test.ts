import { describe, expect, it } from "vitest";
import { resolveDatabaseReadiness } from "./database-readiness";

describe("project database readiness", () => {
  it.each([undefined, null, "", "ready", "failed", {}, false])(
    "keeps unrecognized or missing status %j unknown rather than absent",
    (status) => {
      expect(resolveDatabaseReadiness({ status, loading: false, queryFailed: false })).toBe(
        "unknown",
      );
    },
  );

  it.each(["none", "provisioning", "connected", "error"])(
    "preserves explicit connection metadata %s without upgrading its authority",
    (status) => {
      expect(resolveDatabaseReadiness({ status, loading: false, queryFailed: false })).toBe(status);
    },
  );

  it.each([undefined, "none", "connected", "error"])(
    "does not trust cached status %j after a failed status or project query",
    (status) => {
      expect(resolveDatabaseReadiness({ status, loading: false, queryFailed: true })).toBe(
        "unavailable",
      );
    },
  );

  it("keeps a retry visibly pending rather than exposing setup controls", () => {
    expect(resolveDatabaseReadiness({ status: "none", loading: true, queryFailed: false })).toBe(
      "loading",
    );
  });
});
