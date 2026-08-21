export const USER_VISIBLE_ERROR_MAX_LENGTH = 240;

const TECHNICAL_ERROR_PATTERN =
  /postgres|constraint|sqlstate|stack|23505|internal server|drizzle|database|deadlock|duplicate key|statement timeout|lock timeout|econn|syntax error at or near/i;

export type UserVisibleErrorPolicy = {
  fallback: string;
  allowedCodes?: ReadonlySet<string>;
  allowedMessages?: ReadonlySet<string>;
  allowedPrefixes?: readonly string[];
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorEnvelope(value: unknown): { code: string; message: string } {
  if (typeof value === "string") return { code: "", message: value };
  if (!isRecord(value)) return { code: "", message: "" };
  const payload = isRecord(value.data) ? value.data : value;
  const code = typeof payload.code === "string" ? payload.code : "";
  const message =
    typeof payload.error === "string"
      ? payload.error
      : typeof payload.message === "string"
        ? payload.message
        : "";
  return { code, message };
}

/**
 * Select one fixed, human-safe message from an untrusted error envelope.
 * Unknown, technical, and over-length text is denied by default.
 */
export function selectUserVisibleError(value: unknown, policy: UserVisibleErrorPolicy): string {
  const { code, message } = errorEnvelope(value);
  const allowed =
    (code.length > 0 && policy.allowedCodes?.has(code) === true) ||
    policy.allowedMessages?.has(message) === true ||
    policy.allowedPrefixes?.some((prefix) => message.startsWith(prefix)) === true;
  if (
    !allowed ||
    message.length === 0 ||
    message.length > USER_VISIBLE_ERROR_MAX_LENGTH ||
    TECHNICAL_ERROR_PATTERN.test(message)
  ) {
    return policy.fallback;
  }
  return message;
}

function errorRecord(value: unknown): UnknownRecord {
  if (!isRecord(value)) return {};
  const raw = isRecord(value.raw) ? value.raw : {};
  return { ...raw, ...value };
}

function normalizedMessage(value: unknown): string {
  const { message } = errorEnvelope(value);
  return message.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizedCode(value: unknown): string {
  const record = errorRecord(value);
  return typeof record.code === "string" ? record.code.trim().toLowerCase() : "";
}

export const GITHUB_USER_ERROR_FALLBACK =
  "We couldn't complete this GitHub request. Please try again.";
export const GITHUB_CREDENTIALS_ERROR =
  "GitHub couldn't sign in with those credentials. Connect GitHub again and try again.";
export const GITHUB_USER_VISIBLE_MESSAGES = [
  GITHUB_USER_ERROR_FALLBACK,
  GITHUB_CREDENTIALS_ERROR,
] as const;

export function githubProviderErrorMessage(value: unknown): string {
  return normalizedMessage(value) === "bad credentials"
    ? GITHUB_CREDENTIALS_ERROR
    : GITHUB_USER_ERROR_FALLBACK;
}

export const DATABASE_USER_ERROR_FALLBACK =
  "We couldn't complete this database request. Please try again.";
export const DATABASE_DUPLICATE_VALUE_ERROR =
  "That value is already in use. Try a different value.";
export const DATABASE_REQUIRED_VALUE_ERROR = "A required value is missing. Add it and try again.";
export const DATABASE_TABLE_NOT_FOUND_ERROR =
  "That table could not be found. Check the table name and try again.";
export const DATABASE_COLUMN_NOT_FOUND_ERROR =
  "That column could not be found. Check the column name and try again.";
export const DATABASE_QUERY_SYNTAX_ERROR = "That query has a syntax error. Check it and try again.";
export const DATABASE_USER_VISIBLE_MESSAGES = [
  DATABASE_USER_ERROR_FALLBACK,
  DATABASE_DUPLICATE_VALUE_ERROR,
  DATABASE_REQUIRED_VALUE_ERROR,
  DATABASE_TABLE_NOT_FOUND_ERROR,
  DATABASE_COLUMN_NOT_FOUND_ERROR,
  DATABASE_QUERY_SYNTAX_ERROR,
] as const;

export function databaseProviderErrorMessage(value: unknown): string {
  switch (normalizedCode(value)) {
    case "23505":
    case "unique_violation":
      return DATABASE_DUPLICATE_VALUE_ERROR;
    case "23502":
    case "not_null_violation":
      return DATABASE_REQUIRED_VALUE_ERROR;
    case "42p01":
    case "undefined_table":
      return DATABASE_TABLE_NOT_FOUND_ERROR;
    case "42703":
    case "undefined_column":
      return DATABASE_COLUMN_NOT_FOUND_ERROR;
    case "42601":
    case "syntax_error":
      return DATABASE_QUERY_SYNTAX_ERROR;
    default:
      return DATABASE_USER_ERROR_FALLBACK;
  }
}

export const WORKFLOW_USER_ERROR_FALLBACK = "We couldn't run that workflow. Please try again.";
export const WORKFLOW_USER_VISIBLE_MESSAGES = [WORKFLOW_USER_ERROR_FALLBACK] as const;

export function workflowProviderErrorMessage(_value: unknown): string {
  return WORKFLOW_USER_ERROR_FALLBACK;
}

export const BLUEPRINT_INSTALL_USER_ERROR =
  "Package installation failed. Check the package names and try again.";
export const BLUEPRINT_USER_VISIBLE_MESSAGES = [BLUEPRINT_INSTALL_USER_ERROR] as const;

const LEGACY_BLUEPRINT_FAILURE_PREFIXES = [
  "Package install failed:",
  "Dev package install failed:",
  "Package install error:",
] as const;

export function isBlueprintInstallFailureMessage(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return (
    value === BLUEPRINT_INSTALL_USER_ERROR ||
    LEGACY_BLUEPRINT_FAILURE_PREFIXES.some((prefix) => value.startsWith(prefix))
  );
}
