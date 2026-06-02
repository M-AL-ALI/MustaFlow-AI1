import { describe, it, expect, vi, beforeEach } from "vitest";

// ── isPreviewSubdomainHost — pure hostname check ──────────────────────────────
// Import only the pure export; validatePreviewWebSocketUpgrade is DB-dependent
// and tested with mocked DB below.
import { isPreviewSubdomainHost } from "../previewSubdomainGateway";

const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN ?? "mustaflow.app";

describe("isPreviewSubdomainHost", () => {
  it("returns true for valid 16-char hex preview subdomain", () => {
    expect(isPreviewSubdomainHost(`abcdef1234567890.preview.${PLATFORM_DOMAIN}`)).toBe(true);
  });

  it("returns false for the platform root domain", () => {
    expect(isPreviewSubdomainHost(PLATFORM_DOMAIN)).toBe(false);
  });

  it("returns false for a published project slug subdomain", () => {
    expect(isPreviewSubdomainHost(`my-app-abc123.${PLATFORM_DOMAIN}`)).toBe(false);
  });

  it("returns false for an arbitrary subdomain", () => {
    expect(isPreviewSubdomainHost(`api.${PLATFORM_DOMAIN}`)).toBe(false);
  });

  it("returns false for undefined host", () => {
    expect(isPreviewSubdomainHost(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isPreviewSubdomainHost("")).toBe(false);
  });

  it("returns false when sessionId is too short (not 16 chars)", () => {
    expect(isPreviewSubdomainHost(`abc123.preview.${PLATFORM_DOMAIN}`)).toBe(false);
  });

  it("returns false when sessionId has non-hex characters", () => {
    expect(isPreviewSubdomainHost(`ZZZZZZZZZZZZZZZZ.preview.${PLATFORM_DOMAIN}`)).toBe(false);
  });

  it("returns true with port in host header (port stripped)", () => {
    expect(isPreviewSubdomainHost(`abcdef1234567890.preview.${PLATFORM_DOMAIN}:3000`)).toBe(true);
  });
});

// ── validatePreviewWebSocketUpgrade — DB-backed validation ──────────────────
// We mock @workspace/db so the test runs without a live Postgres connection.

vi.mock("@workspace/db", () => {
  const mockDb = {
    select: vi.fn(),
  };
  return { db: mockDb, projectsTable: {}, previewSessionsTable: {} };
});

import { validatePreviewWebSocketUpgrade } from "../previewSubdomainGateway";
import { db } from "@workspace/db";

// Build a valid HMAC cookie value matching what the gateway produces.
// We reproduce the signing logic here so we can generate valid test tokens.
import { createHmac } from "node:crypto";

function makeValidCookie(sessionId: string, secret: string): string {
  const sig = createHmac("sha256", secret).update(`preview:${sessionId}`).digest("hex");
  return `__prs=${sessionId}.${sig}`;
}

const SECRET = "test-encryption-key-32-chars-xxxx";
const SESSION_ID = "abcdef1234567890"; // 16-char hex

beforeEach(() => {
  process.env.ENCRYPTION_KEY = SECRET;
  vi.clearAllMocks();
});

describe("validatePreviewWebSocketUpgrade", () => {
  const validHost = `${SESSION_ID}.preview.${PLATFORM_DOMAIN}`;
  const validCookie = makeValidCookie(SESSION_ID, SECRET);

  function setupDbReturns(
    sessionRow: object | null,
    projectRow: object | null,
  ): void {
    let callCount = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      from: () => ({
        where: () => {
          callCount++;
          if (callCount === 1) return Promise.resolve(sessionRow ? [sessionRow] : []);
          return Promise.resolve(projectRow ? [projectRow] : []);
        },
      }),
    }));
  }

  it("returns null for non-preview host", async () => {
    const result = await validatePreviewWebSocketUpgrade(`my-app.${PLATFORM_DOMAIN}`, validCookie);
    expect(result).toBeNull();
  });

  it("returns null when cookie is missing", async () => {
    const result = await validatePreviewWebSocketUpgrade(validHost, undefined);
    expect(result).toBeNull();
  });

  it("returns null when cookie HMAC signature is invalid", async () => {
    const badCookie = `__prs=${SESSION_ID}.badhmacsignature`;
    const result = await validatePreviewWebSocketUpgrade(validHost, badCookie);
    expect(result).toBeNull();
  });

  it("returns null when session not found in DB", async () => {
    setupDbReturns(null, null);
    const result = await validatePreviewWebSocketUpgrade(validHost, validCookie);
    expect(result).toBeNull();
  });

  it("returns null when session is revoked", async () => {
    setupDbReturns(
      {
        id: 1,
        projectId: 10,
        expiresAt: new Date(Date.now() + 3_600_000),
        revokedAt: new Date(), // revoked
      },
      null,
    );
    const result = await validatePreviewWebSocketUpgrade(validHost, validCookie);
    expect(result).toBeNull();
  });

  it("returns null when session is expired", async () => {
    setupDbReturns(
      {
        id: 1,
        projectId: 10,
        expiresAt: new Date(Date.now() - 1000), // expired
        revokedAt: null,
      },
      null,
    );
    const result = await validatePreviewWebSocketUpgrade(validHost, validCookie);
    expect(result).toBeNull();
  });

  it("returns null when project has no testContainerUrl", async () => {
    setupDbReturns(
      { id: 1, projectId: 10, expiresAt: new Date(Date.now() + 3_600_000), revokedAt: null },
      { testContainerUrl: null, testContainerStatus: "running", deletedAt: null },
    );
    const result = await validatePreviewWebSocketUpgrade(validHost, validCookie);
    expect(result).toBeNull();
  });

  it("returns null when test container is not running", async () => {
    setupDbReturns(
      { id: 1, projectId: 10, expiresAt: new Date(Date.now() + 3_600_000), revokedAt: null },
      {
        testContainerUrl: "https://test.container.internal",
        testContainerStatus: "stopped",
        deletedAt: null,
      },
    );
    const result = await validatePreviewWebSocketUpgrade(validHost, validCookie);
    expect(result).toBeNull();
  });

  it("returns containerUrl when session is valid and container is running", async () => {
    setupDbReturns(
      { id: 1, projectId: 10, expiresAt: new Date(Date.now() + 3_600_000), revokedAt: null },
      {
        testContainerUrl: "https://test.container.internal",
        testContainerStatus: "running",
        deletedAt: null,
      },
    );
    const result = await validatePreviewWebSocketUpgrade(validHost, validCookie);
    expect(result).not.toBeNull();
    expect(result?.containerUrl).toBe("https://test.container.internal");
  });
});
