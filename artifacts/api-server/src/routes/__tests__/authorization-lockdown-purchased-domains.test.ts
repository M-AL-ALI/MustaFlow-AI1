import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  testDatabaseUrl: (process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test"),
  checkProjectAccess: vi.fn(),
  getUncachableStripeClient: vi.fn(),
}));

vi.mock("../../lib/auth", () => ({ checkProjectAccess: mocks.checkProjectAccess }));
vi.mock("../../lib/namecheap", () => ({
  namecheapEnabled: vi.fn(() => false),
  checkAvailability: vi.fn(),
  getPricing: vi.fn(),
  register: vi.fn(),
  renew: vi.fn(),
  getInfo: vi.fn(),
  setAutoRenew: vi.fn(),
  setWhoisContacts: vi.fn(),
  getAuthCode: vi.fn(),
  setRegistrarLock: vi.fn(),
  transferIn: vi.fn(),
}));
vi.mock("../../lib/stripeClient", () => ({
  getUncachableStripeClient: mocks.getUncachableStripeClient,
  stripeAvailable: vi.fn(),
  invalidateStripeCredentialCache: vi.fn(),
}));
vi.mock("../ssl", () => ({ activateSslForDomain: vi.fn() }));
vi.mock("../../lib/event-bus", () => ({ publishDomainEvent: vi.fn() }));
vi.mock("../../lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

function appFor(router: express.Router) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = "requesting-user";
    next();
  });
  app.use(router);
  return app;
}

describe("authorization lockdown: purchased-domain project association", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkProjectAccess.mockResolvedValue("not_member");
  });

  it.each([
    ["/domains/purchase", { hostname: "example.test", projectId: 801 }],
    [
      "/domains/purchase/confirm",
      { hostname: "example.test", paymentIntentId: "payment-intent", projectId: 802 },
    ],
    [
      "/domains/transfer-in",
      { hostname: "example.test", authCode: "transfer-code", projectId: 803 },
    ],
    [
      "/domains/transfer-in/confirm",
      {
        hostname: "example.test",
        authCode: "transfer-code",
        paymentIntentId: "payment-intent",
        projectId: 804,
      },
    ],
  ])("denies POST %s for another user's project before provider calls", async (path, body) => {
    const router = (await import("../purchased-domains")).default;
    const response = await request(appFor(router)).post(path).send(body);

    expect(response.status).toBe(404);
    expect(mocks.checkProjectAccess).toHaveBeenCalledWith(
      "requesting-user",
      expect.any(Number),
      "member",
    );
    expect(mocks.getUncachableStripeClient).not.toHaveBeenCalled();
  });
});
