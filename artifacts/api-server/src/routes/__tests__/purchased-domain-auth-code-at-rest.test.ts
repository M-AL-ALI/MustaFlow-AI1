import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEncryptionService } from "../../lib/encryption";

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 29).toString("base64");
  return {
    domainRow: null as Record<string, unknown> | null,
    update: vi.fn(),
  };
});

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  return {
    ...actual,
    db: {
      select: () => ({
        from: () => ({ where: async () => (mocks.domainRow ? [mocks.domainRow] : []) }),
      }),
      update: mocks.update,
    },
  };
});

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
  getUncachableStripeClient: vi.fn(),
  stripeAvailable: vi.fn(),
  invalidateStripeCredentialCache: vi.fn(),
}));
vi.mock("../ssl", () => ({ activateSslForDomain: vi.fn() }));
vi.mock("../../lib/event-bus", () => ({ publishDomainEvent: vi.fn() }));
vi.mock("../../lib/auth", () => ({ checkProjectAccess: vi.fn() }));
vi.mock("../../lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

describe("purchased-domain transfer credential at rest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const plaintext = "domain-transfer-code";
    mocks.domainRow = {
      id: 73,
      userId: "domain-owner",
      hostname: "example.test",
      transferAuthCode: createEncryptionService(Buffer.alloc(32, 29).toString("base64")).encrypt(
        plaintext,
      ),
    };
  });

  it("decrypts the stored code at the authorized transfer-code boundary", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.userId = "domain-owner";
      next();
    });
    app.use((await import("../purchased-domains")).default);

    const response = await request(app).get("/domains/purchased/73/auth-code");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ hostname: "example.test", authCode: "domain-transfer-code" });
    expect(mocks.domainRow!.transferAuthCode).toMatch(/^v1:/);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
