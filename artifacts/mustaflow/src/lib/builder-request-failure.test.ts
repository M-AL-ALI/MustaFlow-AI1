import { describe, expect, it } from "vitest";
import { describeBuilderRequestFailure } from "./builder-request-failure";

describe("builder request failures", () => {
  it("describes an HTML 403 without exposing the response body", () => {
    const failure = describeBuilderRequestFailure({
      status: 403,
      message: "<!doctype html><script>private-token</script>",
      data: "private-token",
    });
    expect(failure).toMatchObject({ status: 403, title: "Request blocked", tone: "error" });
    expect(JSON.stringify(failure)).not.toContain("private-token");
    expect(failure.description).toContain("no automatic retry");
  });

  it.each([
    [{ status: 401 }, "Sign-in needs attention"],
    [{ statusCode: 429 }, "Too many requests"],
    [{ response: { status: 403 } }, "Request blocked"],
  ])("recognizes bounded HTTP status metadata", (error, title) => {
    expect(describeBuilderRequestFailure(error).title).toBe(title);
  });

  it.each([
    new Error("network secret"),
    null,
    "private body",
    { status: 0 },
    { status: Infinity },
    { status: "403" },
  ])("keeps unknown admission uncertain instead of claiming nothing started", (error) => {
    const failure = describeBuilderRequestFailure(error);
    expect(failure.status).toBeNull();
    expect(failure.title).toBe("Request not confirmed");
    expect(failure.description).toContain("may still have started");
    expect(JSON.stringify(failure)).not.toContain("secret");
  });

  it("does not invent a no-side-effects guarantee for a server error", () => {
    expect(describeBuilderRequestFailure({ status: 500 })).toMatchObject({
      status: 500,
      title: "Request not confirmed",
      tone: "warning",
    });
  });
});
