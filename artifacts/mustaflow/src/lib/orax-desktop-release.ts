export type OraxDesktopReleaseManifest = {
  product: string;
  appId: string;
  platform: "win32";
  arch: "x64";
  channel: "internal" | "beta" | "stable" | string;
  version: string;
  installerFile: string;
  sizeBytes: number;
  sha256: string;
  downloadUrl: string;
  generatedAt: string;
};

export type OraxDesktopReleaseStatus = {
  publicDownloadEnabled: boolean;
  manifestUrl: string | null;
};

const readEnvString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

export const ORAX_DESKTOP_PUBLIC_DOWNLOAD_ENABLED =
  import.meta.env.VITE_ORAX_DESKTOP_PUBLIC_DOWNLOAD_ENABLED === "true";

export const ORAX_DESKTOP_RELEASE_MANIFEST_URL = readEnvString(
  import.meta.env.VITE_ORAX_DESKTOP_RELEASE_MANIFEST_URL,
);

export const ORAX_DESKTOP_RELEASE_DOWNLOAD_PREFIX =
  "https://downloads.mustaflow.com/orax/desktop/windows/";

export function getOraxDesktopReleaseStatus(): OraxDesktopReleaseStatus {
  return {
    publicDownloadEnabled: ORAX_DESKTOP_PUBLIC_DOWNLOAD_ENABLED,
    manifestUrl: ORAX_DESKTOP_RELEASE_MANIFEST_URL,
  };
}

export function isValidOraxDesktopManifest(value: unknown): value is OraxDesktopReleaseManifest {
  if (!value || typeof value !== "object") return false;

  const manifest = value as Record<string, unknown>;
  return (
    manifest.product === "Orax Desktop" &&
    manifest.appId === "ai.mustaflow.orax.desktop" &&
    manifest.platform === "win32" &&
    manifest.arch === "x64" &&
    typeof manifest.version === "string" &&
    typeof manifest.installerFile === "string" &&
    typeof manifest.sizeBytes === "number" &&
    typeof manifest.sha256 === "string" &&
    /^[a-f0-9]{64}$/i.test(manifest.sha256) &&
    typeof manifest.downloadUrl === "string" &&
    manifest.downloadUrl.startsWith(ORAX_DESKTOP_RELEASE_DOWNLOAD_PREFIX) &&
    typeof manifest.generatedAt === "string"
  );
}

export function formatOraxDesktopReleaseSize(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return "unknown size";
  const megabytes = sizeBytes / 1024 / 1024;
  return `${megabytes.toFixed(megabytes >= 100 ? 0 : 1)} MB`;
}
