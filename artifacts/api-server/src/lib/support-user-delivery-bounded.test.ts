import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  resendSend: vi.fn(),
  eq: vi.fn(() => ({ kind: "eq" })),
  insertResults: [] as unknown[][],
  updateResult: [] as unknown[],
}));

vi.mock("drizzle-orm", () => ({ eq: mocks.eq }));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mocks.resendSend };
  },
}));

vi.mock("@workspace/db", () => {
  const insert = vi.fn(() => ({
    values: vi.fn(() => ({ returning: vi.fn(async () => mocks.insertResults.shift() ?? []) })),
  }));
  const update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => ({ returning: vi.fn(async () => mocks.updateResult) })),
    })),
  }));
  const tx = { insert };
  mocks.insert = insert;
  mocks.update = update;
  mocks.transaction.mockImplementation(async (work: (value: typeof tx) => unknown) => work(tx));
  return {
    db: { transaction: mocks.transaction, update },
    notificationsTable: { id: "notification-id" },
    supportUserDeliveriesTable: { id: "delivery-id" },
  };
});

import { deliverSupportConsequence } from "./support-user-delivery";

const pending = {
  id: 44,
  ticketId: 17,
  projectId: 51,
  recipientUserId: "project-owner",
  recipientEmail: "owner@example.test",
  kind: "access_request",
  notificationId: 33,
  emailStatus: "pending",
  emailFailureReason: null,
  createdAt: new Date("2026-08-31T00:00:00.000Z"),
  completedAt: null,
};

function input() {
  return {
    ticketId: 17,
    projectId: 51,
    recipientUserId: "project-owner",
    recipientEmail: "owner@example.test",
    actorUserId: "support-user",
    actorName: "Support Person",
    kind: "access_request" as const,
    notification: {
      type: "support_access_requested",
      title: "Support Person is requesting project access",
      body: "Example project: investigate preview",
    },
    email: {
      subject: "Project access request",
      html: "<p>Project access request</p>",
      text: "Project access request",
    },
  };
}

describe("bounded support consequence delivery", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    process.env.RESEND_API_KEY = "test";
    mocks.insertResults = [[{ id: 33 }], [pending]];
    mocks.updateResult = [{ ...pending, emailStatus: "sent", completedAt: new Date() }];
    mocks.resendSend.mockResolvedValue({ data: { id: "email-1" }, error: null });
  });

  it("passes a deadline and stable idempotency key to the provider", async () => {
    const result = await deliverSupportConsequence(input());

    expect(result.emailStatus).toBe("sent");
    expect(mocks.resendSend).toHaveBeenCalledTimes(1);
    const requestOptions = mocks.resendSend.mock.calls[0]?.[1] as {
      signal?: AbortSignal;
      idempotencyKey?: string;
    };
    expect(requestOptions.signal).toBeInstanceOf(AbortSignal);
    expect(requestOptions.idempotencyKey).toBe("support-delivery:44");
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it("keeps an aborted provider result pending instead of inventing a terminal outcome", async () => {
    const controller = new AbortController();
    controller.abort();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    mocks.resendSend.mockResolvedValue({ data: null, error: { message: "unavailable" } });

    const result = await deliverSupportConsequence(input());

    expect(timeout).toHaveBeenCalledWith(8_000);
    expect(result.emailStatus).toBe("pending");
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
