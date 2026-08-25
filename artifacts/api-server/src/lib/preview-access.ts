import { publishedHostnameSchema } from "@workspace/tenant-runtime-contracts";

export type PreviewAccess = "unavailable" | "direct" | "gateway";

export interface PreviewAccessInput {
  providerId: string;
  runtimeId: string | null | undefined;
  runtimeStatus: string | null | undefined;
  cloudflarePreviewConfigured: boolean;
}

/**
 * Derive browser-preview transport from the selected provider's contract.
 * Runtime ownership comes from provider identity, never a nullable URL field.
 */
export function derivePreviewAccess(input: PreviewAccessInput): PreviewAccess {
  if (!input.runtimeId || input.runtimeStatus !== "running") {
    return "unavailable";
  }

  if (input.providerId === "fly") {
    return "direct";
  }

  if (input.providerId === "cloudflare") {
    return input.cloudflarePreviewConfigured ? "gateway" : "unavailable";
  }

  return "unavailable";
}

export function isCloudflarePreviewDataPlaneConfigured(
  environment: Record<string, string | undefined> = process.env,
): boolean {
  const rawUrl = environment.CLOUDFLARE_RUNTIME_PREVIEW_URL;
  const privateKey = environment.CLOUDFLARE_RUNTIME_PREVIEW_PRIVATE_KEY;
  if (!rawUrl || !privateKey?.trim()) return false;

  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === "https:" &&
      publishedHostnameSchema.safeParse(url.hostname).success &&
      !/^\d+(?:\.\d+){3}$/u.test(url.hostname) &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      !url.port
    );
  } catch {
    return false;
  }
}

export function deriveConfiguredPreviewAccess(
  input: Pick<PreviewAccessInput, "runtimeId" | "runtimeStatus">,
  providerId: string,
  environment: Record<string, string | undefined> = process.env,
): PreviewAccess {
  return derivePreviewAccess({
    ...input,
    providerId,
    cloudflarePreviewConfigured:
      providerId === "cloudflare" && isCloudflarePreviewDataPlaneConfigured(environment),
  });
}
