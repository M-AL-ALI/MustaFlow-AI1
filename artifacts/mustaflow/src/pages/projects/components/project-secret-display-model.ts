export interface ProjectSecretMetadata {
  id: number;
  projectId: number;
  name: string;
  environment: string;
  isPreviewSafe?: boolean;
  minRole?: string;
}
export const SECRET_ENVIRONMENTS = ["development", "testing", "staging", "production"] as const;
export type SecretEnvironment = (typeof SECRET_ENVIRONMENTS)[number];
export const SECRET_ENVIRONMENT_LABELS: Record<SecretEnvironment, string> = {
  development: "Development",
  testing: "Testing",
  staging: "Staging",
  production: "Production",
};
export const SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Display eligibility only. The API remains authoritative for authorization,
// decryption and injection; saved metadata is not a running-container receipt.
export function previewSecretDisposition(secret: ProjectSecretMetadata, projectId: number) {
  if (secret.projectId !== projectId) return { eligible: false, reason: "Different project" };
  if (secret.environment !== "development" && secret.environment !== "testing")
    return { eligible: false, reason: "Excluded from build and preview" };
  if (secret.isPreviewSafe === undefined)
    return { eligible: false, reason: "Preview access not confirmed" };
  if (!secret.isPreviewSafe) return { eligible: false, reason: "Preview access off" };
  if (secret.minRole === undefined) return { eligible: false, reason: "Role policy not confirmed" };
  if (secret.minRole !== "viewer") return { eligible: false, reason: "Restricted to higher roles" };
  return { eligible: true, reason: "Eligible for build and preview" };
}
export function previewSecretSummary(projectId: number, secrets: readonly ProjectSecretMetadata[]) {
  const entries = secrets
    .filter((secret) => secret.projectId === projectId)
    .map((secret) => ({
      id: secret.id,
      name: secret.name,
      environment: secret.environment,
      ...previewSecretDisposition(secret, projectId),
    }));
  return {
    entries,
    eligibleCount: entries.filter((entry) => entry.eligible).length,
    excludedCount: entries.filter((entry) => !entry.eligible).length,
  };
}
