const REPLIT_DEPLOYMENT_PREVIEW_SUFFIX = ".kirk.prod.repl.run";

/**
 * Replit's database-change preview host does not participate in the canonical
 * Clerk proxy ingress. Clerk's browser client can use its publishable-key
 * endpoint directly there; canonical deployment and custom-domain hosts keep
 * the configured first-party proxy.
 */
export function resolveClerkProxyUrl(
  hostname: string,
  configuredProxyUrl: string | undefined,
): string | undefined {
  const configured = configuredProxyUrl?.trim();
  if (!configured) return undefined;

  const normalizedHostname = hostname.trim().toLowerCase().replace(/\.$/u, "");
  if (normalizedHostname.endsWith(REPLIT_DEPLOYMENT_PREVIEW_SUFFIX)) {
    return undefined;
  }

  return configured;
}
