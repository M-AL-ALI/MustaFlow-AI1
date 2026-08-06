import { publishedHostnameSchema } from "./route-capability";
import {
  sha256Hex,
  signControlRequest,
  verifyControlRequestSignature,
  type ControlNonceStore,
  type ControlSignatureVerification,
} from "./request-signing";

const OVERRIDE_DOMAIN = "nabuflow-staging-host-override-v1";

export interface StagingHostOverrideFields {
  method: string;
  pathAndQuery: string;
  timestamp: string;
  nonce: string;
  actualHost: string;
  overrideHost: string;
}

export interface SignedStagingHostOverride extends StagingHostOverrideFields {
  signature: string;
}

function overrideBody(fields: Pick<StagingHostOverrideFields, "actualHost" | "overrideHost">) {
  const actualHost = publishedHostnameSchema.parse(fields.actualHost);
  const overrideHost = publishedHostnameSchema.parse(fields.overrideHost);
  return `${OVERRIDE_DOMAIN}\n${actualHost}\n${overrideHost}`;
}

async function controlFields(fields: StagingHostOverrideFields) {
  const body = overrideBody(fields);
  return {
    body,
    signatureFields: {
      method: fields.method,
      pathAndQuery: fields.pathAndQuery,
      timestamp: fields.timestamp,
      nonce: `${OVERRIDE_DOMAIN}:${fields.nonce}`,
      bodySha256: await sha256Hex(body),
      idempotencyKey: OVERRIDE_DOMAIN,
    },
  };
}

export async function signStagingHostOverride(
  secret: string | Uint8Array,
  fields: StagingHostOverrideFields,
): Promise<string> {
  const canonical = await controlFields(fields);
  return signControlRequest(secret, canonical.signatureFields);
}

export async function verifyStagingHostOverride(
  secret: string | Uint8Array,
  override: SignedStagingHostOverride,
  nonceStore: ControlNonceStore,
  options: { nowMs?: number; maxClockSkewMs?: number } = {},
): Promise<ControlSignatureVerification> {
  try {
    const canonical = await controlFields(override);
    return await verifyControlRequestSignature(
      secret,
      {
        ...canonical.signatureFields,
        signature: override.signature,
        body: canonical.body,
      },
      nonceStore,
      options,
    );
  } catch {
    return { ok: false, reason: "malformed" };
  }
}
