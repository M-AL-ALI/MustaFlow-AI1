import type { PreviewAccess } from "@workspace/api-client-react";

export function hasServerPreviewAccess(
  previewAccess: PreviewAccess | undefined,
): previewAccess is "direct" | "gateway" {
  return previewAccess === "direct" || previewAccess === "gateway";
}

export function getServerPreviewBadge(previewAccess: PreviewAccess | undefined): {
  label: string;
  subtitle: string;
} | null {
  if (previewAccess === "direct") {
    return {
      label: "Full App Preview — Container",
      subtitle: "Live container; backend routes and server logs available",
    };
  }
  if (previewAccess === "gateway") {
    return {
      label: "Full App Preview — Gateway",
      subtitle: "Live gateway preview; backend routes available",
    };
  }
  return null;
}

export function getPreviewAddress(input: {
  previewAccess: PreviewAccess | undefined;
  containerUrl: string | null | undefined;
  webContainerUrl: string | null | undefined;
  projectId: number;
}): string {
  if (input.previewAccess === "direct" && input.containerUrl) {
    return input.containerUrl;
  }
  if (hasServerPreviewAccess(input.previewAccess)) {
    return `preview/${input.projectId}/`;
  }
  return input.webContainerUrl ?? `preview/${input.projectId}/`;
}
