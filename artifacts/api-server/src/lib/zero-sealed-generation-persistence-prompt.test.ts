import { describe, expect, it } from "vitest";
import { ZERO_SEALED_NODE_PROMPT_EXTENSION } from "./zero-sealed-generation";

describe("sealed generation persistence guidance", () => {
  it("describes platform-owned Cloudflare capabilities rather than retired provider setup", () => {
    expect(ZERO_SEALED_NODE_PROMPT_EXTENSION).toContain("In Cloudflare capability mode");
    expect(ZERO_SEALED_NODE_PROMPT_EXTENSION).toContain(
      "the platform owns database provisioning and credentials",
    );
    expect(ZERO_SEALED_NODE_PROMPT_EXTENSION).not.toMatch(/\bFly\b/i);
  });

  it("preserves requested backend persistence instead of accepting a disposable demo", () => {
    expect(ZERO_SEALED_NODE_PROMPT_EXTENSION).toContain(
      "When the user requests persistent backend records, use createNabuFlowDatabase",
    );
    expect(ZERO_SEALED_NODE_PROMPT_EXTENSION).toContain(
      "Do not substitute an in-memory array, object, localStorage, or mock data",
    );
    expect(ZERO_SEALED_NODE_PROMPT_EXTENSION).toContain(
      "Records must survive a page refresh and runtime restart",
    );
    expect(ZERO_SEALED_NODE_PROMPT_EXTENSION).toContain(
      "report the app complete without verifying persistence",
    );
  });

  it("retains lazy initialization, typed unavailability and provider-neutral credential boundaries", () => {
    expect(ZERO_SEALED_NODE_PROMPT_EXTENSION).toContain("parameterized queries");
    expect(ZERO_SEALED_NODE_PROMPT_EXTENSION).toContain("CREATE TABLE IF NOT EXISTS");
    expect(ZERO_SEALED_NODE_PROMPT_EXTENSION).toContain("sanitized typed 503");
    expect(ZERO_SEALED_NODE_PROMPT_EXTENSION).toContain(
      "GET /healthz must return 200 without touching a database",
    );
    expect(ZERO_SEALED_NODE_PROMPT_EXTENSION).toContain(
      "Never import a database or payments provider SDK",
    );
    expect(ZERO_SEALED_NODE_PROMPT_EXTENSION).toContain("Do not read DATABASE_URL");
    expect(ZERO_SEALED_NODE_PROMPT_EXTENSION).toContain("../nabuflow/runtime/index.js");
  });
});
