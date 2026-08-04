import { RUNTIME_ROLES, RUNTIME_SLOTS, slotIsValidForRole } from "./constants";
import type { RuntimeRole, RuntimeSlot } from "./constants";

const DEPLOYMENT_NAMESPACE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RUNTIME_IDENTITY_PATTERN =
  /^nrf-([0-9a-f]{16})-p([1-9][0-9]*)-(preview|production)-(primary|blue|green)$/;
const textEncoder = new TextEncoder();

export interface RuntimeIdentityParts {
  namespaceHash: string;
  projectId: number;
  role: RuntimeRole;
  slot: RuntimeSlot;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function validateDeploymentNamespace(namespace: string): string {
  if (!DEPLOYMENT_NAMESPACE_PATTERN.test(namespace)) {
    throw new Error(
      "Deployment namespace must be 1-63 characters of normalized lowercase ASCII letters, digits, or hyphens",
    );
  }
  return namespace;
}

export async function deriveNamespaceHash(namespace: string): Promise<string> {
  const normalized = validateDeploymentNamespace(namespace);
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(normalized));
  return bytesToHex(new Uint8Array(digest)).slice(0, 16);
}

export function validateProjectId(projectId: number): number {
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    throw new Error("Project ID must be a positive safe integer");
  }
  return projectId;
}

export function validateRoleAndSlot(role: RuntimeRole, slot: RuntimeSlot): void {
  if (!RUNTIME_ROLES.includes(role) || !RUNTIME_SLOTS.includes(slot)) {
    throw new Error("Unknown runtime role or slot");
  }
  if (!slotIsValidForRole(role, slot)) {
    throw new Error(`Runtime slot ${slot} is not valid for role ${role}`);
  }
}

export async function deriveRuntimeIdentity(input: {
  namespace: string;
  projectId: number;
  role: RuntimeRole;
  slot: RuntimeSlot;
}): Promise<string> {
  validateProjectId(input.projectId);
  validateRoleAndSlot(input.role, input.slot);
  const namespaceHash = await deriveNamespaceHash(input.namespace);
  return `nrf-${namespaceHash}-p${input.projectId}-${input.role}-${input.slot}`;
}

export function parseRuntimeIdentity(identity: string): RuntimeIdentityParts {
  const isAscii = Array.from(identity).every(
    (character) => (character.codePointAt(0) ?? 128) < 128,
  );
  if (identity !== identity.toLowerCase() || !isAscii) {
    throw new Error("Runtime identity must use normalized lowercase ASCII");
  }

  const match = RUNTIME_IDENTITY_PATTERN.exec(identity);
  if (!match) throw new Error("Malformed runtime identity");

  const projectId = Number(match[2]);
  validateProjectId(projectId);
  const role = match[3] as RuntimeRole;
  const slot = match[4] as RuntimeSlot;
  validateRoleAndSlot(role, slot);

  return { namespaceHash: match[1], projectId, role, slot };
}

export async function parseRuntimeIdentityForNamespace(
  identity: string,
  namespace: string,
): Promise<RuntimeIdentityParts> {
  const parsed = parseRuntimeIdentity(identity);
  const expectedHash = await deriveNamespaceHash(namespace);
  if (parsed.namespaceHash !== expectedHash) {
    throw new Error("Runtime identity deployment namespace mismatch");
  }
  return parsed;
}
