/**
 * emailClient — lightweight transactional email via SMTP (nodemailer).
 *
 * Reads env vars at call time (not module load) so hot-reload keeps working:
 *   SMTP_HOST      — required; without it every send is a graceful no-op
 *   SMTP_PORT      — default 587
 *   SMTP_USER      — SMTP auth user
 *   SMTP_PASS      — SMTP auth password
 *   SMTP_FROM      — "From" address, default noreply@mustaflow.app
 *   SMTP_SECURE    — "true" for port-465 TLS, otherwise STARTTLS
 *
 * All sends are best-effort: errors are logged but never re-thrown.
 */

import nodemailer from "nodemailer";
import { logger } from "./logger";

function smtpEnabled(): boolean {
  return Boolean(process.env.SMTP_HOST);
}

function createTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST!,
    port: parseInt(process.env.SMTP_PORT ?? "587", 10),
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? "" }
      : undefined,
  });
}

export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text?: string;
}): Promise<void> {
  if (!smtpEnabled()) {
    logger.debug({ to: opts.to, subject: opts.subject }, "email: SMTP not configured; skipping");
    return;
  }
  try {
    const from = process.env.SMTP_FROM ?? "noreply@mustaflow.app";
    const transport = createTransport();
    await transport.sendMail({ from, ...opts });
    logger.info({ to: opts.to, subject: opts.subject }, "email: sent");
  } catch (err) {
    logger.warn({ err, to: opts.to, subject: opts.subject }, "email: send failed (non-fatal)");
  }
}

// ── Domain-specific email templates ──────────────────────────────────────────

export async function sendDomainRenewalWarning(opts: {
  to: string;
  hostname: string;
  daysUntilExpiry: number;
  renewUrl: string;
}): Promise<void> {
  const { to, hostname, daysUntilExpiry, renewUrl } = opts;
  const urgency =
    daysUntilExpiry <= 7 ? "URGENT: " : daysUntilExpiry <= 30 ? "Action required: " : "";
  const subject = `${urgency}Your domain ${hostname} expires in ${daysUntilExpiry} day${daysUntilExpiry === 1 ? "" : "s"}`;

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
  <h2 style="margin-top:0">Domain renewal reminder</h2>
  <p>Your domain <strong>${hostname}</strong> will expire in
     <strong>${daysUntilExpiry} day${daysUntilExpiry === 1 ? "" : "s"}</strong>.</p>
  <p>If you'd like to keep it, renew now before it expires and becomes available to others.</p>
  <p style="margin:24px 0">
    <a href="${renewUrl}"
       style="background:#6366f1;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600">
      Renew ${hostname}
    </a>
  </p>
  <p style="font-size:12px;color:#666">
    If you no longer need this domain you can ignore this email.
    Auto-renewal will happen automatically if you have a saved payment method.
  </p>
</body>
</html>`;

  await sendEmail({ to, subject, html, text: `${subject}\n\nRenew at: ${renewUrl}` });
}

export async function sendDomainRenewalFailure(opts: {
  to: string;
  hostname: string;
  reason: string;
  renewUrl: string;
}): Promise<void> {
  const { to, hostname, reason, renewUrl } = opts;
  const subject = `Auto-renewal failed for ${hostname}`;

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
  <h2 style="margin-top:0;color:#dc2626">Auto-renewal failed</h2>
  <p>We were unable to automatically renew <strong>${hostname}</strong>.</p>
  <p><strong>Reason:</strong> ${reason}</p>
  <p>Please renew manually before your domain expires to avoid losing it.</p>
  <p style="margin:24px 0">
    <a href="${renewUrl}"
       style="background:#dc2626;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600">
      Renew ${hostname} now
    </a>
  </p>
  <p style="font-size:12px;color:#666">
    To ensure auto-renewal works in the future, update your payment method on the My Domains page.
  </p>
</body>
</html>`;

  await sendEmail({
    to,
    subject,
    html,
    text: `${subject}\n\nReason: ${reason}\n\nRenew at: ${renewUrl}`,
  });
}
