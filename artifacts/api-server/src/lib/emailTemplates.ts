/**
 * emailTemplates — typed email template functions.
 *
 * Each function returns { subject, html, text } so callers can pass them
 * directly to sendEmail(). All HTML uses inline styles for broad email-client
 * compatibility. No external CSS or images.
 */

export interface EmailTemplate {
  subject: string;
  html: string;
  text: string;
}

// ── Shared layout helpers ─────────────────────────────────────────────────────

function wrap(body: string): string {
  return `<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111;background:#fff">
${body}
<hr style="margin:32px 0;border:none;border-top:1px solid #e5e7eb"/>
<p style="font-size:11px;color:#9ca3af;margin:0">
  You're receiving this from MustaFlow. Questions? Reply to this email.
</p>
</body>
</html>`;
}

function ctaButton(label: string, href: string, color = "#6366f1"): string {
  return `<p style="margin:24px 0">
  <a href="${href}"
     style="background:${color};color:#fff;padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block">
    ${label}
  </a>
</p>`;
}

// ── Welcome ───────────────────────────────────────────────────────────────────

export function welcomeTemplate(opts: {
  displayName: string | null;
  ctaUrl: string;
}): EmailTemplate {
  const { displayName, ctaUrl } = opts;
  const greeting = displayName ? `Hi ${displayName},` : "Welcome to NabuFlow,";
  const subject = "Welcome to NabuFlow — build your first app";

  const html = wrap(`
  <h2 style="margin-top:0;color:#111">You're all set.</h2>
  <p>${greeting}</p>
  <p>Your account is ready to get started. Just describe what you want to build and NabuFlow will plan, write, and preview it for you — no code required.</p>
  ${ctaButton("Build your first app", ctaUrl)}
  <p style="font-size:13px;color:#4b5563">
    Not sure what to build? Try something like <em>"a personal expense tracker"</em> or <em>"a landing page for my bakery."</em>
  </p>`);

  const text = `${greeting}\n\nYour NabuFlow account is ready to start building.\n\nDescribe your first app idea here: ${ctaUrl}`;

  return { subject, html, text };
}

// ── Build failed ──────────────────────────────────────────────────────────────

export function buildFailedTemplate(opts: {
  projectName: string;
  agentMode: string;
  reason: string;
  projectUrl: string;
}): EmailTemplate {
  const { projectName, agentMode, reason, projectUrl } = opts;
  const shortReason = reason.split(/[.\n]/)[0]?.trim() ?? reason;
  const subject = `Build failed: "${projectName}"`;

  const html = wrap(`
  <h2 style="margin-top:0;color:#dc2626">Build failed</h2>
  <p>Your <strong>${agentMode}</strong> build of <strong>${projectName}</strong> didn't complete.</p>
  <p><strong>Reason:</strong> ${shortReason}</p>
  <p>Open the project to review the error details and try again. The AI's suggestions are already waiting in the chat.</p>
  ${ctaButton("Go to project", projectUrl, "#dc2626")}
  <p style="font-size:13px;color:#4b5563">
    Tip: if the same prompt keeps failing, try describing it differently or switch to Power mode for a more thorough attempt.
  </p>`);

  const text = `Your ${agentMode} build of "${projectName}" failed.\n\nReason: ${shortReason}\n\nOpen the project: ${projectUrl}`;

  return { subject, html, text };
}

// ── Domain verified ───────────────────────────────────────────────────────────

export function domainVerifiedTemplate(opts: { hostname: string; siteUrl: string }): EmailTemplate {
  const { hostname, siteUrl } = opts;
  const subject = `Your domain ${hostname} is live`;

  const html = wrap(`
  <h2 style="margin-top:0;color:#16a34a">Your domain is active.</h2>
  <p>SSL has been issued and <strong>${hostname}</strong> is now serving your published site.</p>
  ${ctaButton(`Visit ${hostname}`, siteUrl, "#16a34a")}
  <p style="font-size:13px;color:#4b5563">
    DNS changes can take a few more minutes to propagate globally — if you still see a warning in some regions, wait 5–10 minutes and refresh.
  </p>`);

  const text = `Good news — ${hostname} is live.\n\nSSL has been issued and your site is now accessible at: ${siteUrl}`;

  return { subject, html, text };
}

// ── Low credit balance ────────────────────────────────────────────────────────

export function lowCreditTemplate(opts: { balance: number; topUpUrl: string }): EmailTemplate {
  const { balance, topUpUrl } = opts;
  const subject = `You have ${balance} credits left on NabuFlow`;

  const html = wrap(`
  <h2 style="margin-top:0;color:#d97706">Running low on credits</h2>
  <p>Your NabuFlow account has <strong>${balance} credit${balance === 1 ? "" : "s"}</strong> remaining.</p>
  <p>Each build uses credits based on the mode you choose. Top up now to keep building without interruption.</p>
  ${ctaButton("Top up credits", topUpUrl, "#d97706")}
  <p style="font-size:13px;color:#4b5563">
    Check your plan's current credit costs in billing settings.
  </p>`);

  const text = `You have ${balance} credit${balance === 1 ? "" : "s"} left on NabuFlow.\n\nTop up here: ${topUpUrl}`;

  return { subject, html, text };
}

// ── Domain renewal warning ────────────────────────────────────────────────────

export function domainRenewalWarningTemplate(opts: {
  hostname: string;
  daysUntilExpiry: number;
  renewUrl: string;
}): EmailTemplate {
  const { hostname, daysUntilExpiry, renewUrl } = opts;
  const urgency =
    daysUntilExpiry <= 7 ? "URGENT: " : daysUntilExpiry <= 30 ? "Action required: " : "";
  const subject = `${urgency}Your domain ${hostname} expires in ${daysUntilExpiry} day${daysUntilExpiry === 1 ? "" : "s"}`;

  const html = wrap(`
  <h2 style="margin-top:0">Domain renewal reminder</h2>
  <p>Your domain <strong>${hostname}</strong> will expire in
     <strong>${daysUntilExpiry} day${daysUntilExpiry === 1 ? "" : "s"}</strong>.</p>
  <p>If you'd like to keep it, renew now before it expires and becomes available to others.</p>
  ${ctaButton(`Renew ${hostname}`, renewUrl)}
  <p style="font-size:12px;color:#666">
    If you no longer need this domain you can ignore this email.
    Auto-renewal will happen automatically if you have a saved payment method.
  </p>`);

  return { subject, html, text: `${subject}\n\nRenew at: ${renewUrl}` };
}

// ── Org invite ────────────────────────────────────────────────────────────────

export function orgInviteTemplate(opts: {
  orgName: string;
  inviterName: string | null;
  role: string;
  acceptUrl: string;
  expiresAt: Date;
}): EmailTemplate {
  const { orgName, inviterName, role, acceptUrl, expiresAt } = opts;
  const subject = `You're invited to join ${orgName} on NabuFlow`;
  const inviter = inviterName ?? "A teammate";
  const expiresStr = expiresAt.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const html = wrap(`
  <h2 style="margin-top:0">You've been invited to ${orgName}</h2>
  <p>${inviter} invited you to join <strong>${orgName}</strong> on NabuFlow as a <strong>${role}</strong>.</p>
  ${ctaButton("Accept invitation", acceptUrl, "#4a90e2")}
  <p style="font-size:13px;color:#444">Or paste this link into your browser:<br><span style="color:#666">${acceptUrl}</span></p>
  <p style="font-size:12px;color:#666">This invitation expires on ${expiresStr}. If you didn't expect this email, you can safely ignore it.</p>`);

  const text = `${inviter} invited you to join ${orgName} on NabuFlow as a ${role}.\n\nAccept: ${acceptUrl}\n\nExpires: ${expiresStr}`;

  return { subject, html, text };
}

// ── Domain renewal failure ────────────────────────────────────────────────────

export function domainRenewalFailureTemplate(opts: {
  hostname: string;
  reason: string;
  renewUrl: string;
}): EmailTemplate {
  const { hostname, reason, renewUrl } = opts;
  const subject = `Auto-renewal failed for ${hostname}`;

  const html = wrap(`
  <h2 style="margin-top:0;color:#dc2626">Auto-renewal failed</h2>
  <p>We were unable to automatically renew <strong>${hostname}</strong>.</p>
  <p><strong>Reason:</strong> ${reason}</p>
  <p>Please renew manually before your domain expires to avoid losing it.</p>
  ${ctaButton(`Renew ${hostname} now`, renewUrl, "#dc2626")}
  <p style="font-size:12px;color:#666">
    To ensure auto-renewal works in the future, update your payment method on the My Domains page.
  </p>`);

  return { subject, html, text: `${subject}\n\nReason: ${reason}\n\nRenew at: ${renewUrl}` };
}

// ── Support ticket (Task #1312) ───────────────────────────────────────────────

export function supportTicketTemplate(opts: {
  ticketId: number;
  userEmail: string | null;
  userId: string;
  plan: string;
  category: string;
  subject: string;
  transcript: { role: string; content: string }[];
  attachments: { fileName: string; mimeType: string; size: number; url: string }[];
  projectId: number | null;
  deviceInfo: Record<string, unknown> | null;
}): EmailTemplate {
  const {
    ticketId,
    userEmail,
    userId,
    plan,
    category,
    subject,
    transcript,
    attachments,
    projectId,
    deviceInfo,
  } = opts;

  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const transcriptHtml =
    transcript.length === 0
      ? '<p style="color:#9ca3af">(no transcript)</p>'
      : transcript
          .map(
            (m) =>
              `<p style="margin:0 0 10px"><strong style="color:${
                m.role === "user" ? "#111" : "#6366f1"
              }">${m.role === "user" ? "User" : "Ora"}:</strong><br/>${esc(m.content)}</p>`,
          )
          .join("\n");

  const attachmentsHtml =
    attachments.length === 0
      ? '<p style="color:#9ca3af;font-size:13px">No attachments.</p>'
      : `<ul style="font-size:13px;padding-left:18px">${attachments
          .map(
            (a) =>
              `<li><a href="${a.url}">${esc(a.fileName)}</a> (${a.mimeType}, ${Math.round(
                a.size / 1024,
              )} KB)</li>`,
          )
          .join("")}</ul>`;

  const emailSubject = `[Support #${ticketId}] ${subject}`;

  const html = wrap(`
  <h2 style="margin-top:0;color:#111">New support ticket #${ticketId}</h2>
  <p style="font-size:13px;color:#4b5563;margin:0 0 4px"><strong>From:</strong> ${
    userEmail ? esc(userEmail) : "(no email on file)"
  } (user ${esc(userId)})</p>
  <p style="font-size:13px;color:#4b5563;margin:0 0 4px"><strong>Plan:</strong> ${esc(
    plan,
  )} &nbsp;|&nbsp; <strong>Category:</strong> ${esc(category)}${
    projectId != null ? ` &nbsp;|&nbsp; <strong>Project:</strong> ${projectId}` : ""
  }</p>
  ${
    deviceInfo
      ? `<p style="font-size:12px;color:#9ca3af;margin:0 0 12px"><strong>Device:</strong> ${esc(
          JSON.stringify(deviceInfo),
        )}</p>`
      : ""
  }
  <h3 style="color:#111;margin:18px 0 8px;font-size:15px">Conversation</h3>
  <div style="font-size:13px;line-height:1.5;color:#111">${transcriptHtml}</div>
  <h3 style="color:#111;margin:18px 0 8px;font-size:15px">Attachments</h3>
  ${attachmentsHtml}`);

  const textLines = [
    `New support ticket #${ticketId}: ${subject}`,
    `From: ${userEmail ?? "(no email)"} (user ${userId})`,
    `Plan: ${plan} | Category: ${category}${projectId != null ? ` | Project: ${projectId}` : ""}`,
    "",
    "Conversation:",
    ...transcript.map((m) => `${m.role === "user" ? "User" : "Ora"}: ${m.content}`),
    "",
    "Attachments:",
    ...(attachments.length === 0
      ? ["(none)"]
      : attachments.map((a) => `- ${a.fileName} (${a.mimeType}): ${a.url}`)),
  ];

  return { subject: emailSubject, html, text: textLines.join("\n") };
}

// ── Support reply (staff → requester) ─────────────────────────────────────────

export function supportTicketConfirmationTemplate(opts: {
  ticketId: number;
  subject: string;
}): EmailTemplate {
  const { ticketId, subject } = opts;
  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const emailSubject = `Support ticket #${ticketId} received`;

  const html = wrap(`
  <h2 style="margin-top:0;color:#111">We received your support request</h2>
  <p>Thank you for reaching out to MustaFlow support. Your request has been logged and our team will review it shortly.</p>
  <p style="font-size:14px;background:#f9fafb;border-left:3px solid #6366f1;padding:12px 16px;margin:16px 0">
    <strong>Ticket #${ticketId}</strong> &mdash; ${esc(subject)}
  </p>
  <p>We'll reach out to you as soon as possible to help resolve your issue.</p>
  <p style="font-size:13px;color:#4b5563">If you have additional details to share, simply reply to this email.</p>`);

  const text = [
    `We received your support request — Ticket #${ticketId}`,
    "",
    `Thank you for reaching out to MustaFlow support. Your request has been logged and our team will review it shortly.`,
    "",
    `Ticket #${ticketId} — ${subject}`,
    "",
    `We'll reach out to you as soon as possible to help resolve your issue.`,
    "",
    `If you have additional details to share, simply reply to this email.`,
  ].join("\n");

  return { subject: emailSubject, html, text };
}

export function supportAccessRequestTemplate(opts: {
  ticketId: number;
  projectName: string;
  staffName: string;
  reason: string;
  requestExpiresAt: Date;
  decisionUrl: string;
}): EmailTemplate {
  const esc = (value: string): string =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const expires = opts.requestExpiresAt.toUTCString();
  const subject = `Project access request — ticket #${opts.ticketId}`;
  const html = wrap(`
  <h2 style="margin-top:0;color:#111">Your approval is required</h2>
  <p><strong>${esc(opts.staffName)}</strong> from NabuFlow Support is requesting temporary access to <strong>${esc(opts.projectName)}</strong>.</p>
  <p style="font-size:14px;background:#f9fafb;border-left:3px solid #6366f1;padding:12px 16px;margin:16px 0">${esc(opts.reason)}</p>
  <p>This request expires ${esc(expires)}. Opening the link does not grant access; sign in and choose Grant or Refuse inside NabuFlow.</p>
  ${ctaButton("Review request in NabuFlow", opts.decisionUrl)}
  <p style="font-size:12px;color:#6b7280">Ticket #${opts.ticketId}</p>`);
  const text = [
    `Your approval is required — ticket #${opts.ticketId}`,
    "",
    `${opts.staffName} from NabuFlow Support is requesting temporary access to ${opts.projectName}.`,
    `Reason: ${opts.reason}`,
    `Request expires: ${expires}`,
    "",
    "Opening this link does not grant access. Sign in and choose Grant or Refuse inside NabuFlow:",
    opts.decisionUrl,
  ].join("\n");
  return { subject, html, text };
}

export function supportProposalReadyTemplate(opts: {
  ticketId: number;
  projectName: string;
  staffName: string;
  summary: string;
  decisionUrl: string;
}): EmailTemplate {
  const esc = (value: string): string =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const subject = `Review Zero's proposal — ticket #${opts.ticketId}`;
  const html = wrap(`
  <h2 style="margin-top:0;color:#111">Zero prepared a proposal for your review</h2>
  <p><strong>${esc(opts.staffName)}</strong> completed a read-only diagnosis of <strong>${esc(opts.projectName)}</strong>.</p>
  <p style="font-size:14px;background:#f9fafb;border-left:3px solid #6366f1;padding:12px 16px;margin:16px 0">${esc(opts.summary)}</p>
  <p>Nothing has changed. Opening the link does not approve anything; sign in and review the proposal inside NabuFlow.</p>
  ${ctaButton("Review proposal in NabuFlow", opts.decisionUrl)}
  <p style="font-size:12px;color:#6b7280">Ticket #${opts.ticketId}</p>`);
  const text = [
    `Zero prepared a proposal — ticket #${opts.ticketId}`,
    "",
    `${opts.staffName} completed a read-only diagnosis of ${opts.projectName}.`,
    opts.summary,
    "",
    "Nothing has changed. Sign in to review and approve or decline:",
    opts.decisionUrl,
  ].join("\n");
  return { subject, html, text };
}

export function supportClassificationTemplate(opts: {
  ticketId: number;
  subject: string;
  classification: "project" | "platform" | "external";
  explanation: string;
  ticketUrl: string;
}): EmailTemplate {
  const esc = (value: string): string =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const label =
    opts.classification === "project"
      ? "a project issue"
      : opts.classification === "platform"
        ? "a NabuFlow platform issue"
        : "blocked on a third party";
  const emailSubject = `Ticket #${opts.ticketId} update: ${label}`;
  const html = wrap(`
  <h2 style="margin-top:0;color:#111">We classified your support request</h2>
  <p><strong>Ticket #${opts.ticketId}</strong> — ${esc(opts.subject)}</p>
  <p>We classified this as <strong>${esc(label)}</strong>.</p>
  <p style="font-size:14px;background:#f9fafb;border-left:3px solid #6366f1;padding:12px 16px;margin:16px 0">${esc(opts.explanation)}</p>
  ${ctaButton("View ticket in NabuFlow", opts.ticketUrl)}`);
  const text = [
    `Ticket #${opts.ticketId} update`,
    opts.subject,
    "",
    `We classified this as ${label}.`,
    opts.explanation,
    "",
    opts.ticketUrl,
  ].join("\n");
  return { subject: emailSubject, html, text };
}

export function supportReplyTemplate(opts: {
  ticketId: number;
  subject: string;
  replyBody: string;
}): EmailTemplate {
  const { ticketId, subject, replyBody } = opts;
  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const emailSubject = `Re: [Support #${ticketId}] ${subject}`;
  const bodyHtml = esc(replyBody).replace(/\n/g, "<br/>");

  const html = wrap(`
  <h2 style="margin-top:0;color:#111">A reply from MustaFlow Support</h2>
  <p style="font-size:13px;color:#4b5563;margin:0 0 16px">Regarding your request: <strong>${esc(
    subject,
  )}</strong> (ticket #${ticketId})</p>
  <div style="font-size:14px;line-height:1.6;color:#111;border-left:3px solid #6366f1;padding-left:14px">${bodyHtml}</div>
  <p style="font-size:13px;color:#4b5563;margin-top:20px">You can reply directly to this email to continue the conversation.</p>`);

  const text = [
    `A reply from MustaFlow Support — ticket #${ticketId}`,
    `Regarding: ${subject}`,
    "",
    replyBody,
    "",
    "You can reply directly to this email to continue the conversation.",
  ].join("\n");

  return { subject: emailSubject, html, text };
}

// ── NabuFlow billing (Task #1516) ─────────────────────────────────────────────

export function nabuflowUsageWarningTemplate(opts: {
  kind: "credits" | "spend_cap";
  level: number;
  planName: string;
  detail: string;
  billingUrl: string;
}): EmailTemplate {
  const what = opts.kind === "credits" ? "included build credits" : "monthly spend cap";
  const subject =
    opts.level >= 100
      ? `You've reached 100% of your NabuFlow ${what}`
      : `You've used ${opts.level}% of your NabuFlow ${what}`;

  const html = wrap(`
  <h2 style="margin-top:0;color:#111">${subject}</h2>
  <p>Your <strong>${opts.planName}</strong> plan: ${opts.detail}</p>
  ${ctaButton("Review usage & billing", opts.billingUrl)}
  <p style="font-size:13px;color:#4b5563">In-flight builds are never interrupted — this only affects new builds.</p>`);

  const text = `${subject}\n\n${opts.planName} plan: ${opts.detail}\n\nReview usage & billing: ${opts.billingUrl}`;
  return { subject, html, text };
}

export function nabuflowPaymentFailedTemplate(opts: {
  planName: string;
  attempt: number;
  paused: boolean;
  graceUntil: string;
  billingUrl: string;
}): EmailTemplate {
  const subject = opts.paused
    ? "NabuFlow builds paused — payment failed"
    : "NabuFlow payment failed — we'll retry";

  const body = opts.paused
    ? `<p>Your <strong>${opts.planName}</strong> payment couldn't be processed after ${opts.attempt} attempt${opts.attempt === 1 ? "" : "s"}. <strong>New builds are paused</strong> until your payment method is updated. In-flight builds were not interrupted.</p>`
    : `<p>Your <strong>${opts.planName}</strong> payment couldn't be processed (attempt ${opts.attempt}). We'll retry automatically. If payment keeps failing, new builds pause on <strong>${opts.graceUntil}</strong>.</p>`;

  const html = wrap(`
  <h2 style="margin-top:0;color:#111">${subject}</h2>
  ${body}
  ${ctaButton("Update payment method", opts.billingUrl, "#dc2626")}`);

  const text = `${subject}\n\nYour ${opts.planName} payment couldn't be processed (attempt ${opts.attempt}).${opts.paused ? " New builds are paused until your payment method is updated." : ` New builds pause on ${opts.graceUntil} if payment keeps failing.`}\n\nUpdate your payment method: ${opts.billingUrl}`;
  return { subject, html, text };
}
