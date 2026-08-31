export const PROJECT_RETIREMENT_EXECUTION_FLAG = "PROJECT_RETIREMENT_EXECUTION_ENABLED";
export const EDGE_SERVING_FLAG = "EDGE_SERVING_ENABLED";

const LEGACY_HOSTNAME_KV_BINDINGS = [
  "CF_ACCOUNT_ID",
  "CF_API_TOKEN",
  "CF_KV_NAMESPACE_ID",
  "CF_ZONE_ID",
] as const;

type LegacyHostnameKvBinding = (typeof LEGACY_HOSTNAME_KV_BINDINGS)[number];
type RetirementActivationKey =
  | typeof PROJECT_RETIREMENT_EXECUTION_FLAG
  | typeof EDGE_SERVING_FLAG
  | LegacyHostnameKvBinding;

type RetirementActivationEnvironment = Readonly<Partial<Record<RetirementActivationKey, string>>>;

export type LegacyHostnameKvPosture =
  | { state: "not_configured"; missingBindings: []; invalidInputs: [] }
  | { state: "configured"; missingBindings: []; invalidInputs: [] }
  | {
      state: "blocked";
      missingBindings: LegacyHostnameKvBinding[];
      invalidInputs: Array<typeof EDGE_SERVING_FLAG>;
    };

/**
 * The retired Snapshot Worker used Workers KV for hostname routing. Current
 * production routing lives in the runtime Control Durable Object, so an
 * intentionally absent legacy KV subsystem is not a cleanup failure. A
 * partially configured KV subsystem, or one required by EDGE_SERVING_ENABLED,
 * remains fail-closed because it could still hold a live hostname route.
 */
export function resolveLegacyHostnameKvPosture(
  environment: RetirementActivationEnvironment = process.env,
): LegacyHostnameKvPosture {
  const edgeServingValue = environment[EDGE_SERVING_FLAG]?.trim() ?? "";
  if (edgeServingValue !== "" && edgeServingValue !== "false" && edgeServingValue !== "true") {
    return { state: "blocked", missingBindings: [], invalidInputs: [EDGE_SERVING_FLAG] };
  }
  const kvWasConfigured = (environment.CF_KV_NAMESPACE_ID?.trim().length ?? 0) > 0;
  const kvIsRequired = edgeServingValue === "true";
  if (!kvWasConfigured && !kvIsRequired) {
    return { state: "not_configured", missingBindings: [], invalidInputs: [] };
  }

  const missingBindings = LEGACY_HOSTNAME_KV_BINDINGS.filter(
    (name) => (environment[name]?.trim().length ?? 0) === 0,
  );
  if (missingBindings.length > 0) {
    return { state: "blocked", missingBindings, invalidInputs: [] };
  }
  return { state: "configured", missingBindings: [], invalidInputs: [] };
}

/**
 * Provider-destructive retirement is opt-in. Schema rollout and application
 * startup are therefore safe before every Worker surface has proven parity.
 */
export function isProjectRetirementExecutionEnabled(
  environment: RetirementActivationEnvironment = process.env,
): boolean {
  return (
    environment[PROJECT_RETIREMENT_EXECUTION_FLAG] === "true" &&
    resolveLegacyHostnameKvPosture(environment).state !== "blocked"
  );
}
