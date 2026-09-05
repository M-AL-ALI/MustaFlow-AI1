/**
 * emailClient — lightweight transactional email via Resend HTTP API.
 *
 * Reads env vars at call time (not module load) so hot-reload keeps working:
 *   RESEND_API_KEY  — required; without it every send is a graceful no-op
 *   SUPPORT_EMAIL   — recipient for support ticket notifications
 *   SMTP_FROM       — "From" address, default support@mustaflow.com
 *                     (reused so callers are unchanged)
 *
 * All sends are best-effort: errors are logged but never re-thrown.
 */

import { resolveDefaultSender, SUPPORT_EMAIL_ADDRESS } from "./support-contact";

import { Resend } from "resend";
import { logger } from "./logger";
import {
  welcomeTemplate,
  buildFailedTemplate,
  domainVerifiedTemplate,
  lowCreditTemplate,
  domainRenewalWarningTemplate,
  orgInviteTemplate,
  projectInviteTemplate,
  domainRenewalFailureTemplate,
  nabuflowUsageWarningTemplate,
  nabuflowPaymentFailedTemplate,
} from "./emailTemplates";

function resendEnabled(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

function createClient(): Resend {
  return new Resend(process.env.RESEND_API_KEY!);
}

export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text?: string;
}): Promise<void> {
  if (!resendEnabled()) {
    logger.debug(
      { to: opts.to, subject: opts.subject },
      "email: RESEND_API_KEY not configured; skipping",
    );
    return;
  }
  try {
    const from = resolveDefaultSender("SMTP_FROM");
    const client = createClient();
    const { error } = await client.emails.send({
      from,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    });
    if (error) {
      logger.warn(
        { err: error, to: opts.to, subject: opts.subject },
        "email: send failed (non-fatal)",
      );
    } else {
      logger.info({ to: opts.to, subject: opts.subject }, "email: sent");
    }
  } catch (err) {
    logger.warn({ err, to: opts.to, subject: opts.subject }, "email: send failed (non-fatal)");
  }
}

export type EmailDeliveryStatus = "sent" | "skipped" | "failed";

export const EMAIL_DELIVERY_FAILURE_KINDS = [
  "provider_unconfigured",
  "provider_rate_limited",
  "provider_quota_exceeded",
  "provider_rejected",
  "provider_transient",
  "provider_idempotency_conflict",
  "provider_request_in_progress",
  "provider_timeout",
  "provider_transport_error",
  "provider_response_invalid",
  "provider_failure_unclassified",
] as const;

export type EmailDeliveryReceipt = {
  status: EmailDeliveryStatus;
  /** Acceptance by Resend is not proof of delivery to the recipient's inbox. */
  acceptance: "accepted" | "not_accepted" | "unknown";
  providerMessageId: string | null;
  failureKind: (typeof EMAIL_DELIVERY_FAILURE_KINDS)[number] | null;
  retryable: boolean | null;
  providerStatusCode: number | null;
};

type EmailDeliveryOptions = {
  to: string;
  subject: string;
  html: string;
  text?: string;
  signal?: AbortSignal;
  idempotencyKey?: string;
};

function failedEmailReceipt(
  failureKind: NonNullable<EmailDeliveryReceipt["failureKind"]>,
  acceptance: "not_accepted" | "unknown",
  retryable: boolean | null,
  providerStatusCode: number | null = null,
): EmailDeliveryReceipt {
  return {
    status: "failed",
    acceptance,
    providerMessageId: null,
    failureKind,
    retryable,
    providerStatusCode,
  };
}

/** Classify only documented codes/statuses; never persist raw provider messages. */
function classifyEmailError(error: unknown): EmailDeliveryReceipt {
  const facts =
    error && typeof error === "object" && !Array.isArray(error)
      ? (error as { name?: unknown; statusCode?: unknown })
      : {};
  const status =
    typeof facts.statusCode === "number" &&
    Number.isInteger(facts.statusCode) &&
    facts.statusCode >= 400 &&
    facts.statusCode <= 599
      ? facts.statusCode
      : null;
  const name = typeof facts.name === "string" ? facts.name : "";
  // A conflicting or in-flight key may already identify an accepted request.
  if (name === "invalid_idempotent_request") {
    return failedEmailReceipt("provider_idempotency_conflict", "unknown", false, status);
  }
  if (name === "concurrent_idempotent_requests" || name === "resource_locked") {
    return failedEmailReceipt("provider_request_in_progress", "unknown", true, status);
  }
  if (["daily_quota_exceeded", "monthly_quota_exceeded"].includes(name)) {
    return failedEmailReceipt("provider_quota_exceeded", "not_accepted", true, status);
  }
  if (status === 429 || name === "rate_limit_exceeded") {
    return failedEmailReceipt("provider_rate_limited", "not_accepted", true, status);
  }
  if (status !== null && status >= 500) {
    return failedEmailReceipt("provider_transient", "unknown", true, status);
  }
  if (status === 408) return failedEmailReceipt("provider_timeout", "unknown", true, status);
  if (status !== null && status !== 409) {
    return failedEmailReceipt("provider_rejected", "not_accepted", false, status);
  }
  // SDK 6.16 also maps fetch failures to application_error with no status.
  // That does not establish whether the provider accepted the request.
  return failedEmailReceipt("provider_failure_unclassified", "unknown", null, status);
}

/**
 * Backward-compatible string API. "sent" requires a concrete acceptance ID;
 * it does not mean that the message reached an external inbox.
 */
export async function sendEmailWithStatus(
  opts: EmailDeliveryOptions,
): Promise<EmailDeliveryStatus> {
  return (await sendEmailWithReceipt(opts)).status;
}

/**
 * One provider request, with the original payload and idempotency key.
 * Callers own retry timing. Resend keys expire after 24 hours, so an old
 * uncertain outcome must not be treated as proof that a resend is safe.
 * https://resend.com/docs/dashboard/emails/idempotency-keys
 * https://resend.com/docs/api-reference/errors
 */
export async function sendEmailWithReceipt(
  opts: EmailDeliveryOptions,
): Promise<EmailDeliveryReceipt> {
  if (!resendEnabled()) {
    return {
      ...failedEmailReceipt("provider_unconfigured", "not_accepted", false),
      status: "skipped",
    };
  }
  try {
    const from = resolveDefaultSender("SMTP_FROM");
    const client = createClient();
    type ResendSendOptions = NonNullable<Parameters<typeof client.emails.send>[1]> & {
      signal?: AbortSignal;
    };
    const requestOptions: ResendSendOptions = {
      ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    };
    const { data, error } = await client.emails.send(
      {
        from,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
      },
      requestOptions,
    );
    if (error !== null && error !== undefined) {
      const receipt =
        data != null
          ? failedEmailReceipt("provider_response_invalid", "unknown", null)
          : opts.signal?.aborted
            ? failedEmailReceipt("provider_timeout", "unknown", true)
            : classifyEmailError(error);
      logger.warn(receipt, "email: provider acceptance not confirmed");
      return receipt;
    }
    if (
      !data ||
      typeof data.id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(data.id)
    ) {
      const receipt = failedEmailReceipt("provider_response_invalid", "unknown", null);
      logger.warn(receipt, "email: provider acceptance ID missing or invalid");
      return receipt;
    }
    logger.info({ providerMessageId: data.id }, "email: provider accepted");
    return {
      status: "sent",
      acceptance: "accepted",
      providerMessageId: data.id,
      failureKind: null,
      retryable: false,
      providerStatusCode: null,
    };
  } catch {
    const receipt = failedEmailReceipt(
      opts.signal?.aborted ? "provider_timeout" : "provider_transport_error",
      "unknown",
      true,
    );
    logger.warn(receipt, "email: provider acceptance not confirmed");
    return receipt;
  }
}

// ── Domain-specific email senders ─────────────────────────────────────────────

export async function sendWelcomeEmail(opts: {
  to: string;
  displayName: string | null;
  ctaUrl: string;
}): Promise<void> {
  const { to, ...rest } = opts;
  const tmpl = welcomeTemplate(rest);
  await sendEmail({ to, ...tmpl });
}

export async function sendBuildFailureEmail(opts: {
  to: string;
  projectName: string;
  agentMode: string;
  reason: string;
  projectUrl: string;
}): Promise<void> {
  const { to, ...rest } = opts;
  const tmpl = buildFailedTemplate(rest);
  await sendEmail({ to, ...tmpl });
}

export async function sendDomainVerifiedEmail(opts: {
  to: string;
  hostname: string;
  siteUrl: string;
}): Promise<void> {
  const { to, ...rest } = opts;
  const tmpl = domainVerifiedTemplate(rest);
  await sendEmail({ to, ...tmpl });
}

export async function sendLowCreditEmail(opts: {
  to: string;
  balance: number;
  topUpUrl: string;
}): Promise<void> {
  const { to, ...rest } = opts;
  const tmpl = lowCreditTemplate(rest);
  await sendEmail({ to, ...tmpl });
}

export async function sendDomainRenewalWarning(opts: {
  to: string;
  hostname: string;
  daysUntilExpiry: number;
  renewUrl: string;
}): Promise<void> {
  const { to, ...rest } = opts;
  const tmpl = domainRenewalWarningTemplate(rest);
  await sendEmail({ to, ...tmpl });
}

export async function sendOrgInvite(opts: {
  to: string;
  orgName: string;
  inviterName: string | null;
  role: string;
  acceptUrl: string;
  expiresAt: Date;
}): Promise<void> {
  const { to, ...rest } = opts;
  const tmpl = orgInviteTemplate(rest);
  await sendEmail({ to, ...tmpl });
}

export async function sendProjectInvite(opts: {
  to: string;
  projectName: string;
  inviterName: string | null;
  role: string;
  acceptUrl: string;
  expiresAt: Date;
}): Promise<EmailDeliveryStatus> {
  const { to, ...rest } = opts;
  return sendEmailWithStatus({ to, ...projectInviteTemplate(rest) });
}

export async function sendGdprDeletionConfirmation(opts: {
  to: string;
  userId: string;
  erasureDate: Date;
}): Promise<void> {
  const { to, userId, erasureDate } = opts;
  const erasureDateStr = erasureDate.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const subject = "Your account deletion request has been received";

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
  <h2 style="margin-top:0">We've received your deletion request</h2>
  <p>We have received your request to delete your MustaFlow account and all associated data.</p>
  <p>Your data will be permanently and irreversibly deleted on or before
     <strong>${erasureDateStr}</strong>.</p>
  <p>The following data will be removed:</p>
  <ul>
    <li>All your projects, files, and build history</li>
    <li>AI chat messages and knowledge vault entries</li>
    <li>Uploaded files and assets</li>
    <li>Workspace memberships and activity history</li>
    <li>Credit transaction history</li>
    <li>Custom domain records</li>
    <li>Deployment history</li>
  </ul>
  <p>If you did not make this request or wish to cancel it, please contact us within
     30 days at <a href="mailto:${SUPPORT_EMAIL_ADDRESS}">${SUPPORT_EMAIL_ADDRESS}</a>.</p>
  <p style="font-size:12px;color:#666">Reference ID: ${userId}</p>
</body>
</html>`;

  const text = [
    "We've received your account deletion request.",
    "",
    `Your data will be permanently deleted on or before ${erasureDateStr}.`,
    "",
    `To cancel this request, contact ${SUPPORT_EMAIL_ADDRESS} within 30 days.`,
    "",
    `Reference ID: ${userId}`,
  ].join("\n");

  await sendEmail({ to, subject, html, text });
}

export async function sendDomainRenewalFailure(opts: {
  to: string;
  hostname: string;
  reason: string;
  renewUrl: string;
}): Promise<void> {
  const { to, ...rest } = opts;
  const tmpl = domainRenewalFailureTemplate(rest);
  await sendEmail({ to, ...tmpl });
}

export async function sendNabuflowUsageWarningEmail(opts: {
  to: string;
  kind: "credits" | "spend_cap";
  level: number;
  planName: string;
  detail: string;
  billingUrl: string;
}): Promise<void> {
  const { to, ...rest } = opts;
  const tmpl = nabuflowUsageWarningTemplate(rest);
  await sendEmail({ to, ...tmpl });
}

export async function sendNabuflowPaymentFailedEmail(opts: {
  to: string;
  planName: string;
  attempt: number;
  paused: boolean;
  graceUntil: string;
  billingUrl: string;
}): Promise<void> {
  const { to, ...rest } = opts;
  const tmpl = nabuflowPaymentFailedTemplate(rest);
  await sendEmail({ to, ...tmpl });
}
