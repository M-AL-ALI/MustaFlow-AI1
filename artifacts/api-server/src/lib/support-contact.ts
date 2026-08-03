export const SUPPORT_EMAIL_ADDRESS = "support@mustaflow.com";

export function resolveSupportRecipient(): string {
  return process.env.SUPPORT_EMAIL?.trim() || SUPPORT_EMAIL_ADDRESS;
}

export function resolveDefaultSender(envName: "SMTP_FROM" | "RESEND_FROM"): string {
  return process.env[envName]?.trim() || SUPPORT_EMAIL_ADDRESS;
}
