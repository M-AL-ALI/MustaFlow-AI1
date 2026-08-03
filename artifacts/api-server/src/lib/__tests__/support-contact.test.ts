import { afterEach, describe, expect, it } from "vitest";
import {
  resolveDefaultSender,
  resolveSupportRecipient,
  SUPPORT_EMAIL_ADDRESS,
} from "../support-contact";

const originalSupportEmail = process.env.SUPPORT_EMAIL;
const originalSmtpFrom = process.env.SMTP_FROM;
const originalResendFrom = process.env.RESEND_FROM;

afterEach(() => {
  if (originalSupportEmail === undefined) delete process.env.SUPPORT_EMAIL;
  else process.env.SUPPORT_EMAIL = originalSupportEmail;
  if (originalSmtpFrom === undefined) delete process.env.SMTP_FROM;
  else process.env.SMTP_FROM = originalSmtpFrom;
  if (originalResendFrom === undefined) delete process.env.RESEND_FROM;
  else process.env.RESEND_FROM = originalResendFrom;
});

describe("support contact defaults", () => {
  it("uses the one company support address when recipient and sender env vars are absent", () => {
    delete process.env.SUPPORT_EMAIL;
    delete process.env.SMTP_FROM;
    delete process.env.RESEND_FROM;

    expect(resolveSupportRecipient()).toBe(SUPPORT_EMAIL_ADDRESS);
    expect(resolveDefaultSender("SMTP_FROM")).toBe(SUPPORT_EMAIL_ADDRESS);
    expect(resolveDefaultSender("RESEND_FROM")).toBe(SUPPORT_EMAIL_ADDRESS);
  });

  it("preserves explicit environment overrides", () => {
    process.env.SUPPORT_EMAIL = "support-override@example.com";
    process.env.SMTP_FROM = "smtp-override@example.com";
    process.env.RESEND_FROM = "resend-override@example.com";

    expect(resolveSupportRecipient()).toBe("support-override@example.com");
    expect(resolveDefaultSender("SMTP_FROM")).toBe("smtp-override@example.com");
    expect(resolveDefaultSender("RESEND_FROM")).toBe("resend-override@example.com");
  });
});
