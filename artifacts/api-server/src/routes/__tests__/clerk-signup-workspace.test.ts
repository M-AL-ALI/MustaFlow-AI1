import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureUserSignupFoundation: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
});

vi.mock("../../lib/workspace-foundation", () => ({
  ensureUserSignupFoundation: mocks.ensureUserSignupFoundation,
}));

vi.mock("../../lib/logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: vi.fn(),
  },
}));

import { handleUserCreated } from "../clerk-webhook";

describe("Clerk user.created workspace foundation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureUserSignupFoundation.mockResolvedValue({
      workspace: { id: 71 },
      workspaceCreated: true,
    });
  });

  it("creates the signup foundation with the Clerk display name", async () => {
    await handleUserCreated({
      id: "clerk-user-a",
      first_name: "  Ada ",
      last_name: " Lovelace  ",
      username: "ignored-fallback",
    });

    expect(mocks.ensureUserSignupFoundation).toHaveBeenCalledWith({
      userId: "clerk-user-a",
      displayName: "Ada Lovelace",
    });
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      { userId: "clerk-user-a", workspaceId: 71, workspaceCreated: true },
      "Clerk user.created — signup foundation established",
    );
  });

  it("uses the username when first and last name are absent", async () => {
    await handleUserCreated({ id: "clerk-user-b", username: "builder" });

    expect(mocks.ensureUserSignupFoundation).toHaveBeenCalledWith({
      userId: "clerk-user-b",
      displayName: "builder",
    });
  });

  it("does not create rows for a malformed event without a user id", async () => {
    await handleUserCreated({ first_name: "Nobody" });

    expect(mocks.ensureUserSignupFoundation).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalled();
  });
});
