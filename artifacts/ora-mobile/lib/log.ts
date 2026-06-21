type LogContext = Record<string, unknown>;

/**
 * Reduce an unknown thrown value to a small, PII-free shape. We never log file
 * contents, request bodies, tokens, or full URLs — only an error name and a
 * short message so a future crash/telemetry hook has something actionable.
 */
function redactError(error: unknown): LogContext | undefined {
  if (error === undefined || error === null) return undefined;
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { error: String(error) };
}

function write(
  level: "warn" | "error",
  scope: string,
  message: string,
  context?: LogContext,
): void {
  if (!__DEV__) {
    // Production hook point: forward to a crash/telemetry provider here when one
    // is configured. Intentionally a no-op today so no PII leaves the device.
    return;
  }
  const line = `[ora:${scope}] ${message}`;
  const payload = context && Object.keys(context).length > 0 ? context : "";
  /* eslint-disable no-console -- dedicated dev-only logger; production path no-ops above */
  if (level === "error") console.error(line, payload);
  else console.warn(line, payload);
  /* eslint-enable no-console */
}

/** Log a non-fatal warning. Dev-only console; no-op in production. */
export function logWarn(scope: string, message: string, context?: LogContext): void {
  write("warn", scope, message, context);
}

/** Log an error with a redacted cause. Dev-only console; no-op in production. */
export function logError(
  scope: string,
  message: string,
  error?: unknown,
  context?: LogContext,
): void {
  const detail = redactError(error);
  write("error", scope, message, { ...context, ...(detail ? { detail } : {}) });
}
