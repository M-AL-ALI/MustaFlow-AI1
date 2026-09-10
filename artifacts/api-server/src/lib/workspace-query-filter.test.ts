import { describe, expect, it } from "vitest";
import { parseWorkspaceQueryFilter } from "./workspace-query-filter";
describe("workspace query filter", () => {
  it("keeps an omitted scope compatible with account-wide callers", () => {
    expect(parseWorkspaceQueryFilter(undefined)).toEqual({ ok: true, workspaceId: null });
  });
  it.each(["1", "26", "2147483647"])("accepts canonical workspace %s", (value) => {
    expect(parseWorkspaceQueryFilter(value)).toEqual({ ok: true, workspaceId: Number(value) });
  });
  it.each([
    "",
    "0",
    "-1",
    "01",
    "1junk",
    "1.0",
    "1e2",
    " 1",
    "1 ",
    "2147483648",
    "1\n",
    ["1"],
    { id: "1" },
    null,
    1,
  ])("does not widen malformed scope %j to all projects", (value) => {
    expect(parseWorkspaceQueryFilter(value)).toEqual({ ok: false });
  });
});
