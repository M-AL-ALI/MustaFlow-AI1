import {
  BILLING_USER_ERROR_FALLBACK,
  BILLING_USER_VISIBLE_MESSAGES,
} from "@workspace/ora-contracts";

export const BUILD_FAILURE_FALLBACK_ERROR = "I couldn't finish this step. Please try again.";
export const APPLY_FAILURE_FALLBACK_ERROR =
  "Your changes could not be applied. Nothing was changed; please try again.";
export const PROJECT_FILE_SCOPE_ERROR =
  "Project files could not be saved because their artifact scope is unavailable.";
export const PROJECT_FILE_WRITE_ERROR =
  "Your project changes could not be saved. Nothing was changed; please try again.";
export const PROJECT_FILE_VERSION_HANDOFF_ERROR =
  "Your files and version could not be saved together. Nothing was changed; please try again.";

const USER_VISIBLE_ERROR_MAX_LENGTH = 240;
const TECHNICAL_ERROR_PATTERN =
  /postgres|constraint|sqlstate|stack|23505|internal server|drizzle|database|deadlock|duplicate key|statement timeout|lock timeout|econn|syntax error at or near/i;

const USER_VISIBLE_BUILD_MESSAGES = new Set([
  PROJECT_FILE_SCOPE_ERROR,
  PROJECT_FILE_WRITE_ERROR,
  PROJECT_FILE_VERSION_HANDOFF_ERROR,
  "The preview did not start.",
  "The preview could not start because port 3000 was unavailable.",
  "This website needs to be converted to the supported production format before it can build.",
  "This website needs one compatibility repair before it can finish building.",
]);

const USER_VISIBLE_BUILD_PREFIXES: readonly string[] = [
  "Insufficient credits",
  "TypeScript check exited with code ",
  "Test check exited with code ",
  "Lint check exited with code ",
  "Build check exited with code ",
];

const USER_VISIBLE_BILLING_MESSAGES = new Set<string>(BILLING_USER_VISIBLE_MESSAGES);

type UserVisibleErrorPolicy = {
  fallback: string;
  allowedCodes?: ReadonlySet<string>;
  allowedMessages?: ReadonlySet<string>;
  allowedPrefixes?: readonly string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
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

export function selectBuildFailureError(
  value: unknown,
  fallback = BUILD_FAILURE_FALLBACK_ERROR,
): string {
  return selectUserVisibleError(value, {
    fallback,
    allowedMessages: USER_VISIBLE_BUILD_MESSAGES,
    allowedPrefixes: USER_VISIBLE_BUILD_PREFIXES,
  });
}

export function selectBillingFailureError(
  value: unknown,
  fallback = BILLING_USER_ERROR_FALLBACK,
): string {
  return selectUserVisibleError(value, {
    fallback,
    allowedMessages: USER_VISIBLE_BILLING_MESSAGES,
  });
}
