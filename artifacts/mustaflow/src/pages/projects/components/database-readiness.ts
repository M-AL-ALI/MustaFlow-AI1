export type DatabaseReadiness =
  | "loading"
  | "unavailable"
  | "unknown"
  | "none"
  | "provisioning"
  | "connected"
  | "error";

/** Direct project-connection metadata is not proof of runtime-managed storage health. */
export function resolveDatabaseReadiness(input: {
  status: unknown;
  loading: boolean;
  queryFailed: boolean;
}): DatabaseReadiness {
  if (input.loading) return "loading";
  if (input.queryFailed) return "unavailable";
  switch (input.status) {
    case "none":
    case "provisioning":
    case "connected":
    case "error":
      return input.status;
    default:
      return "unknown";
  }
}
