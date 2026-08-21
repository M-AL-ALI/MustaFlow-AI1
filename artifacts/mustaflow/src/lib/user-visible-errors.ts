import {
  BILLING_USER_ERROR_FALLBACK,
  BILLING_USER_VISIBLE_MESSAGES,
  BLUEPRINT_INSTALL_USER_ERROR,
  BLUEPRINT_USER_VISIBLE_MESSAGES,
  DATABASE_USER_ERROR_FALLBACK,
  DATABASE_USER_VISIBLE_MESSAGES,
  GITHUB_USER_ERROR_FALLBACK,
  GITHUB_USER_VISIBLE_MESSAGES,
  WORKFLOW_USER_ERROR_FALLBACK,
  WORKFLOW_USER_VISIBLE_MESSAGES,
  selectUserVisibleError as selectSharedUserVisibleError,
  type UserVisibleErrorPolicy,
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
const USER_VISIBLE_GITHUB_MESSAGES = new Set<string>(GITHUB_USER_VISIBLE_MESSAGES);
const USER_VISIBLE_DATABASE_MESSAGES = new Set<string>(DATABASE_USER_VISIBLE_MESSAGES);
const USER_VISIBLE_WORKFLOW_MESSAGES = new Set<string>(WORKFLOW_USER_VISIBLE_MESSAGES);
const USER_VISIBLE_BLUEPRINT_MESSAGES = new Set<string>(BLUEPRINT_USER_VISIBLE_MESSAGES);

export function selectUserVisibleError(value: unknown, policy: UserVisibleErrorPolicy): string {
  return selectSharedUserVisibleError(value, policy);
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

export function selectGithubFailureError(
  value: unknown,
  fallback = GITHUB_USER_ERROR_FALLBACK,
): string {
  return selectUserVisibleError(value, {
    fallback,
    allowedMessages: USER_VISIBLE_GITHUB_MESSAGES,
  });
}

export function selectDatabaseFailureError(
  value: unknown,
  fallback = DATABASE_USER_ERROR_FALLBACK,
): string {
  return selectUserVisibleError(value, {
    fallback,
    allowedMessages: USER_VISIBLE_DATABASE_MESSAGES,
  });
}

export function selectWorkflowFailureError(
  value: unknown,
  fallback = WORKFLOW_USER_ERROR_FALLBACK,
): string {
  return selectUserVisibleError(value, {
    fallback,
    allowedMessages: USER_VISIBLE_WORKFLOW_MESSAGES,
  });
}

export function selectBlueprintFailureError(value: unknown): string {
  return selectUserVisibleError(value, {
    fallback: BLUEPRINT_INSTALL_USER_ERROR,
    allowedMessages: USER_VISIBLE_BLUEPRINT_MESSAGES,
  });
}
