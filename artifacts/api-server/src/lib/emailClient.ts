/**
 * emailClient — lightweight transactional email via Resend HTTP API.
 *
 * Reads env vars at call time (not module load) so hot-reload keeps working:
 *   RESEND_API_KEY  — required; without it every send is a graceful no-op
 *   SUPPORT_EMAIL   — recipient for support ticket notifications
 *   SMTP_FROM       — "From" address, default noreply@mustaflow.app
 *                     (reused so callers are unchanged)
 *
 * All sends are best-effort: errors are logged but never re-thrown.
 */

import { Resend } from "resend";
import { logger } from "./logger";
import {
  welcomeTemplate,
  buildFailedTemplate,
  domainVerifiedTemplate,
  lowCreditTemplate,
  domainRenewalWarningTemplate,
  orgInviteTemplate,
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
    const from = process.env.SMTP_FROM ?? "support@mustaflow.com";
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

/**
 * Like sendEmail, but reports the delivery outcome so callers (e.g. support
 * ticket escalation) can persist an accurate emailStatus. Never throws.
 *   - "skipped" — RESEND_API_KEY or SUPPORT_EMAIL is not configured.
 *   - "sent"    — the message was handed to Resend successfully.
 *   - "failed"  — Resend returned an error or threw.
 */
export async function sendEmailWithStatus(opts: {
  to: string;
  subject: string;
  html: string;
  text?: string;
}): Promise<EmailDeliveryStatus> {
  if (!resendEnabled()) {
    logger.debug(
      { to: opts.to, subject: opts.subject },
      "email: RESEND_API_KEY not configured; skipping",
    );
    return "skipped";
  }
  try {
    const from = process.env.SMTP_FROM ?? "support@mustaflow.com";
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
      return "failed";
    }
    logger.info({ to: opts.to, subject: opts.subject }, "email: sent");
    return "sent";
  } catch (err) {
    logger.warn({ err, to: opts.to, subject: opts.subject }, "email: send failed (non-fatal)");
    return "failed";
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
     30 days at <a href="mailto:privacy@mustaflow.app">privacy@mustaflow.app</a>.</p>
  <p style="font-size:12px;color:#666">Reference ID: ${userId}</p>
</body>
</html>`;

  const text = [
    "We've received your account deletion request.",
    "",
    `Your data will be permanently deleted on or before ${erasureDateStr}.`,
    "",
    "To cancel this request, contact privacy@mustaflow.app within 30 days.",
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
