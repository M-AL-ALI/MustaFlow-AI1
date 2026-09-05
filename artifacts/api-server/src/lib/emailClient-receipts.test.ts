import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendEmailWithReceipt, sendEmailWithStatus } from "./emailClient";

const transport = vi.hoisted(() => ({ send: vi.fn(), info: vi.fn(), warn: vi.fn() }));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: transport.send };
  },
}));
vi.mock("./logger", () => ({
  logger: { info: transport.info, warn: transport.warn, debug: vi.fn() },
}));
vi.mock("./support-contact", () => ({
  resolveDefaultSender: () => "sender@example.com",
  SUPPORT_EMAIL_ADDRESS: "support@example.com",
}));

const input = {
  to: "owner@example.com",
  subject: "Project moved to Trash",
  html: "<p>Exact body</p>",
  text: "Exact body",
  idempotencyKey: "project-purge-notification:160",
};
const providerId = "4aa759bf-1022-4c3b-a73a-d80a5e4e33c4";

beforeEach(() => {
  vi.stubEnv("RESEND_API_KEY", "test-only-secret-key");
  transport.send.mockReset();
  transport.info.mockReset();
  transport.warn.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("email provider acceptance receipts", () => {
  it("requires a concrete acceptance ID and preserves the exact payload, key and abort signal", async () => {
    transport.send.mockResolvedValue({ data: { id: providerId }, error: null });
    const signal = new AbortController().signal;
    expect(await sendEmailWithReceipt({ ...input, signal })).toEqual({
      status: "sent",
      acceptance: "accepted",
      providerMessageId: providerId,
      failureKind: null,
      retryable: false,
      providerStatusCode: null,
    });
    expect(transport.send).toHaveBeenCalledExactlyOnceWith(
      {
        from: "sender@example.com",
        to: input.to,
        subject: input.subject,
        html: input.html,
        text: input.text,
      },
      { idempotencyKey: input.idempotencyKey, signal },
    );
  });

  it.each([
    undefined,
    null,
    {},
    { id: "" },
    { id: " " },
    { id: 123 },
    { id: "x".repeat(129) },
    { id: "bad\r\nid" },
  ])("does not turn error-free data %j into false sent status", async (data) => {
    transport.send.mockResolvedValue({ data, error: null });
    expect(await sendEmailWithReceipt(input)).toMatchObject({
      status: "failed",
      acceptance: "unknown",
      providerMessageId: null,
      failureKind: "provider_response_invalid",
    });
    expect(transport.send).toHaveBeenCalledTimes(1);
  });

  it("does not call the provider when credentials are unconfigured", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    expect(await sendEmailWithReceipt(input)).toMatchObject({
      status: "skipped",
      acceptance: "not_accepted",
      providerMessageId: null,
      failureKind: "provider_unconfigured",
    });
    expect(transport.send).not.toHaveBeenCalled();
  });

  it.each([
    ["rate_limit_exceeded", 429, "provider_rate_limited", "not_accepted", true],
    ["daily_quota_exceeded", 429, "provider_quota_exceeded", "not_accepted", true],
    ["monthly_quota_exceeded", 429, "provider_quota_exceeded", "not_accepted", true],
    ["validation_error", 422, "provider_rejected", "not_accepted", false],
    ["missing_api_key", 401, "provider_rejected", "not_accepted", false],
    ["restricted_api_key", 403, "provider_rejected", "not_accepted", false],
    ["application_error", 500, "provider_transient", "unknown", true],
    ["service_unavailable", 503, "provider_transient", "unknown", true],
    ["invalid_idempotent_request", 409, "provider_idempotency_conflict", "unknown", false],
    ["concurrent_idempotent_requests", 409, "provider_request_in_progress", "unknown", true],
    ["application_error", null, "provider_failure_unclassified", "unknown", null],
    ["future_provider_code", null, "provider_failure_unclassified", "unknown", null],
  ])(
    "classifies %s/%s without leaking provider text or retrying internally",
    async (name, statusCode, failureKind, acceptance, retryable) => {
      transport.send.mockResolvedValue({
        data: null,
        error: { name, statusCode, message: "secret owner@example.com token=private" },
      });
      const receipt = await sendEmailWithReceipt(input);
      expect(receipt).toEqual({
        status: "failed",
        acceptance,
        providerMessageId: null,
        failureKind,
        retryable,
        providerStatusCode: statusCode,
      });
      expect(JSON.stringify([receipt, transport.warn.mock.calls])).not.toMatch(/secret|@|private/u);
      expect(transport.send).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps contradictory error and acceptance data uncertain", async () => {
    transport.send.mockResolvedValue({
      data: { id: providerId },
      error: { name: "rate_limit_exceeded", statusCode: 429 },
    });
    expect(await sendEmailWithReceipt(input)).toMatchObject({
      status: "failed",
      acceptance: "unknown",
      providerMessageId: null,
      failureKind: "provider_response_invalid",
    });
  });

  it("classifies an SDK-swallowed abort as uncertain timeout", async () => {
    const controller = new AbortController();
    transport.send.mockImplementation(async () => {
      controller.abort();
      return {
        data: null,
        error: { name: "application_error", statusCode: null, message: "secret" },
      };
    });
    expect(await sendEmailWithReceipt({ ...input, signal: controller.signal })).toMatchObject({
      status: "failed",
      acceptance: "unknown",
      failureKind: "provider_timeout",
      providerMessageId: null,
    });
  });

  it("does not claim rejection when transport throws after a possibly accepted send", async () => {
    transport.send.mockRejectedValue(new Error("secret-provider-token"));
    expect(await sendEmailWithReceipt(input)).toMatchObject({
      status: "failed",
      acceptance: "unknown",
      failureKind: "provider_transport_error",
      providerMessageId: null,
    });
    expect(JSON.stringify(transport.warn.mock.calls)).not.toContain("secret-provider-token");
  });

  it.each([
    [{ data: { id: providerId }, error: null }, "sent"],
    [{ data: null, error: null }, "failed"],
    [{ data: null, error: { name: "rate_limit_exceeded", statusCode: 429 } }, "failed"],
  ])("keeps the existing string status API: %j -> %s", async (result, status) => {
    transport.send.mockResolvedValue(result);
    expect(await sendEmailWithStatus(input)).toBe(status);
    expect(transport.send).toHaveBeenCalledTimes(1);
  });

  it("preserves the skipped string result for existing callers", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    expect(await sendEmailWithStatus(input)).toBe("skipped");
  });
});
