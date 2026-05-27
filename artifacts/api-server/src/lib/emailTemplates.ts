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
