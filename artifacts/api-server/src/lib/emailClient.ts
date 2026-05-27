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
import {
  welcomeTemplate,
  buildFailedTemplate,
  domainVerifiedTemplate,
  lowCreditTemplate,
  domainRenewalWarningTemplate,
  orgInviteTemplate,
  domainRenewalFailureTemplate,
} from "./emailTemplates";

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
