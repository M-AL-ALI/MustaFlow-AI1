import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clerk = vi.hoisted(() => ({
  getUserList: vi.fn(),
  getUser: vi.fn(),
  banUser: vi.fn(),
  unbanUser: vi.fn(),
}));

vi.mock("@clerk/express", () => ({ clerkClient: { users: clerk } }));
vi.mock("./logger", () => ({ logger: { warn: vi.fn() } }));

import {
  findClerkAccountAccessByEmail,
  getClerkAccountAccessById,
  setClerkAccountBanned,
} from "./clerk-users";

const clerkUser = {
  id: "user_target",
  firstName: "Target",
  lastName: "User",
  username: null,
  imageUrl: "https://images.example.test/user.png",
  primaryEmailAddressId: "email_1",
  emailAddresses: [{ id: "email_1", emailAddress: "target@example.com" }],
  banned: false,
  locked: false,
};

describe("Clerk account access adapter", () => {
  beforeEach(() => {
    vi.stubEnv("CLERK_SECRET_KEY", "configured-for-test");
    clerk.getUserList.mockReset();
    clerk.getUser.mockReset();
    clerk.banUser.mockReset();
    clerk.unbanUser.mockReset();
  });

  afterEach(() => vi.unstubAllEnvs());

  it("reads the provider's current access state without a local shadow", async () => {
    clerk.getUserList.mockResolvedValue({ data: [clerkUser] });
    clerk.getUser.mockResolvedValue({ ...clerkUser, locked: true });

    await expect(findClerkAccountAccessByEmail(" TARGET@EXAMPLE.COM ")).resolves.toMatchObject({
      userId: "user_target",
      email: "target@example.com",
      banned: false,
      locked: false,
    });
    await expect(getClerkAccountAccessById("user_target")).resolves.toMatchObject({
      banned: false,
      locked: true,
    });
    expect(clerk.getUserList).toHaveBeenCalledWith({
      emailAddress: ["target@example.com"],
      limit: 1,
    });
  });

  it("uses Clerk's native reversible ban and unban controls", async () => {
    clerk.banUser.mockResolvedValue({ ...clerkUser, banned: true });
    clerk.unbanUser.mockResolvedValue(clerkUser);

    await expect(setClerkAccountBanned("user_target", true)).resolves.toMatchObject({
      banned: true,
    });
    await expect(setClerkAccountBanned("user_target", false)).resolves.toMatchObject({
      banned: false,
    });
    expect(clerk.banUser).toHaveBeenCalledWith("user_target");
    expect(clerk.unbanUser).toHaveBeenCalledWith("user_target");
  });

  it("carries provider failure evidence without leaking it into the typed terminal", async () => {
    const providerError = new Error("private provider detail");
    clerk.banUser.mockRejectedValue(providerError);
    await expect(setClerkAccountBanned("user_target", true)).rejects.toMatchObject({
      message: "account_access_store_unavailable",
      cause: providerError,
    });
  });
});
