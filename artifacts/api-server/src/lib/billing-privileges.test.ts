import { describe, expect, it, vi } from "vitest";

vi.mock("./clerk-users", () => ({ findClerkUserByEmail: vi.fn(async () => null) }));

import { billingPrivilegeEmails } from "./billing-privileges";

describe("billing privilege allowlist", () => {
  it("keeps both founder-approved accounts under the same owner rules", () => {
    expect(billingPrivilegeEmails()).toEqual(["mus_192@yahoo.com", "alialmshhdany0@gmail.com"]);
  });
});
