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
  const greeting = displayName ? `Hi ${displayName},` : "Welcome to MustaFlow,";
  const subject = "Welcome to MustaFlow — build your first app";

  const html = wrap(`
  <h2 style="margin-top:0;color:#111">You're all set.</h2>
  <p>${greeting}</p>
  <p>Your account is ready and you have <strong>100 credits</strong> to get started. Just describe what you want to build and MustaFlow will plan, write, and preview it for you — no code required.</p>
  ${ctaButton("Build your first app", ctaUrl)}
  <p style="font-size:13px;color:#4b5563">
    Not sure what to build? Try something like <em>"a personal expense tracker"</em> or <em>"a landing page for my bakery."</em>
  </p>`);

  const text = `${greeting}\n\nYour MustaFlow account is ready. You have 100 credits to start building.\n\nDescribe your first app idea here: ${ctaUrl}`;

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
  const subject = `You have ${balance} credits left on MustaFlow`;

  const html = wrap(`
  <h2 style="margin-top:0;color:#d97706">Running low on credits</h2>
  <p>Your MustaFlow account has <strong>${balance} credit${balance === 1 ? "" : "s"}</strong> remaining.</p>
  <p>Each build uses 1–10 credits depending on the mode you choose. Top up now to keep building without interruption.</p>
  ${ctaButton("Top up credits", topUpUrl, "#d97706")}
  <p style="font-size:13px;color:#4b5563">
    Current costs: Lite = 1, Eco = 2, Power = 5, Pro = 10 credits per build.
  </p>`);

  const text = `You have ${balance} credit${balance === 1 ? "" : "s"} left on MustaFlow.\n\nTop up here: ${topUpUrl}`;

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
  const subject = `You're invited to join ${orgName} on MustaFlow`;
  const inviter = inviterName ?? "A teammate";
  const expiresStr = expiresAt.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const html = wrap(`
  <h2 style="margin-top:0">You've been invited to ${orgName}</h2>
  <p>${inviter} invited you to join <strong>${orgName}</strong> on MustaFlow as a <strong>${role}</strong>.</p>
  ${ctaButton("Accept invitation", acceptUrl, "#4a90e2")}
  <p style="font-size:13px;color:#444">Or paste this link into your browser:<br><span style="color:#666">${acceptUrl}</span></p>
  <p style="font-size:12px;color:#666">This invitation expires on ${expiresStr}. If you didn't expect this email, you can safely ignore it.</p>`);

  const text = `${inviter} invited you to join ${orgName} on MustaFlow as a ${role}.\n\nAccept: ${acceptUrl}\n\nExpires: ${expiresStr}`;

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
