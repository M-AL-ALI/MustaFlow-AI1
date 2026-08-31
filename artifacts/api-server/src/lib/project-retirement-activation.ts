export const PROJECT_RETIREMENT_EXECUTION_FLAG = "PROJECT_RETIREMENT_EXECUTION_ENABLED";

type RetirementActivationEnvironment = Readonly<
  Partial<Record<typeof PROJECT_RETIREMENT_EXECUTION_FLAG, string>>
>;

/**
 * Provider-destructive retirement is opt-in. Schema rollout and application
 * startup are therefore safe before every Worker surface has proven parity.
 */
export function isProjectRetirementExecutionEnabled(
  environment: RetirementActivationEnvironment = process.env,
): boolean {
  return environment[PROJECT_RETIREMENT_EXECUTION_FLAG] === "true";
}
