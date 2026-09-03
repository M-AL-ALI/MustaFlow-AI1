import { describe, expect, it, vi } from "vitest";

const findByEmail = vi.hoisted(() => vi.fn());

vi.mock("./clerk-users", () => ({ findClerkUserByEmail: findByEmail }));

import { isBillingPrivileged } from "./billing-privileges";

describe("billing privilege allowlist", () => {
  it("resolves the founder-approved billing identities without exposing them to Admin authority", async () => {
    findByEmail.mockImplementation(async (email: string) =>
      email === "alialmshhdany0@gmail.com" ? { userId: "user_billing_privileged" } : null,
    );

    await expect(isBillingPrivileged("user_billing_privileged")).resolves.toBe(true);
    expect(findByEmail.mock.calls.map(([email]) => email)).toEqual([
      "mus_192@yahoo.com",
      "alialmshhdany0@gmail.com",
    ]);
  });
});
