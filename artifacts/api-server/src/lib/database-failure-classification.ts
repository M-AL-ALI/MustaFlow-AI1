export const DATABASE_FAILURE_CAUSES = [
  "authentication_failed",
  "authorization_failed",
  "database_missing",
  "capacity_exhausted",
  "tls_failed",
  "name_resolution_failed",
  "connection_refused",
  "connection_timeout",
  "connection_lost",
  "configuration_invalid",
  "unknown",
] as const;

export type DatabaseFailureCause = (typeof DATABASE_FAILURE_CAUSES)[number];

type ErrorLike = {
  code?: unknown;
  message?: unknown;
  name?: unknown;
};

/**
 * Convert provider/transport errors into a closed, public-safe diagnostic.
 * Raw connection strings, hostnames, usernames and provider messages must
 * never cross the status boundary.
 */
export function classifyDatabaseFailure(error: unknown): DatabaseFailureCause {
  const candidate = error && typeof error === "object" ? (error as ErrorLike) : {};
  const code = typeof candidate.code === "string" ? candidate.code.toUpperCase() : "";
  const message = typeof candidate.message === "string" ? candidate.message.toLowerCase() : "";
  const name = typeof candidate.name === "string" ? candidate.name.toLowerCase() : "";

  if (code === "28P01") return "authentication_failed";
  if (code === "42501" || code === "28000") return "authorization_failed";
  if (code === "3D000") return "database_missing";
  if (code === "53300" || code === "53400" || code === "57P03") return "capacity_exhausted";

  if (
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "ERR_TLS_CERT_ALTNAME_INVALID" ||
    name.includes("tls") ||
    message.includes("certificate") ||
    message.includes("ssl")
  ) {
    return "tls_failed";
  }

  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || message.includes("getaddrinfo")) {
    return "name_resolution_failed";
  }
  if (code === "ECONNREFUSED" || message.includes("connection refused")) {
    return "connection_refused";
  }
  if (code === "ETIMEDOUT" || message.includes("timeout") || message.includes("timed out")) {
    return "connection_timeout";
  }
  if (
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    message.includes("connection terminated") ||
    message.includes("connection closed")
  ) {
    return "connection_lost";
  }
  if (
    code === "ERR_INVALID_URL" ||
    (name === "typeerror" && message.includes("url")) ||
    message.includes("connection string")
  ) {
    return "configuration_invalid";
  }

  return "unknown";
}
