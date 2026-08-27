import { describe, expect, it, vi } from "vitest";

vi.mock("./clerk-users", () => ({ findClerkUserByEmail: vi.fn(async () => null) }));

import { superuserEmails } from "./superusers";

describe("owner allowlist", () => {
  it("keeps both founder-approved accounts under the same owner rules", () => {
    expect(superuserEmails()).toEqual(["mus_192@yahoo.com", "alialmshhdany0@gmail.com"]);
  });
});
