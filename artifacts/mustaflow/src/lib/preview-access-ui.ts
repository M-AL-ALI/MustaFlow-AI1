import type { PreviewAccess } from "@workspace/api-client-react";

export function hasServerPreviewAccess(
  previewAccess: PreviewAccess | undefined,
): previewAccess is "direct" | "gateway" {
  return previewAccess === "direct" || previewAccess === "gateway";
}

/**
 * Server and WebContainer previews run on isolated origins and need their own
 * origin so browser-managed session and module loading work. Database-backed
 * static previews stay on the application origin and therefore remain opaque.
 */
export function getPreviewIframeSandbox(input: {
  serverPreviewLive: boolean;
  webContainerLive: boolean;
}): string {
  return input.serverPreviewLive || input.webContainerLive
    ? "allow-scripts allow-forms allow-popups allow-same-origin allow-modals"
    : "allow-scripts allow-forms allow-popups";
}

export type AgenticPreviewUnavailablePresentation = {
  title: string;
  message: string;
  action: "wake" | "retry" | null;
  actionLabel: string | null;
};

export type PreviewRuntimeStatus = "stopped" | "starting" | "running" | "hibernated" | "error";

export type PreviewRecoveryControl = {
  label: "Wake preview" | "Restart preview" | "Waking preview…";
  disabled: boolean;
};

/**
 * Keeps explicit preview recovery reachable even when provider metadata says
 * "running" while the accepted release is not yet serving. This control only
 * describes a user-initiated POST action; preview reads remain side-effect free.
 */
export function getPreviewRecoveryControl(input: {
  hasRuntime: boolean;
  status: PreviewRuntimeStatus | undefined;
}): PreviewRecoveryControl | null {
  if (!input.hasRuntime) return null;
  if (input.status === "starting") {
    return { label: "Waking preview…", disabled: true };
  }
  if (input.status === "running") {
    return { label: "Restart preview", disabled: false };
  }
  return { label: "Wake preview", disabled: false };
}

export function presentAgenticPreviewUnavailable(
  status: PreviewRuntimeStatus | undefined,
): AgenticPreviewUnavailablePresentation {
  if (status === "starting") {
    return {
      title: "Waking your preview…",
      message: "Your app will appear here as soon as it is ready.",
      action: null,
      actionLabel: null,
    };
  }
  if (status === "error") {
    return {
      title: "We could not check your preview",
      message: "Try the status check again. Your project files are safe.",
      action: "retry",
      actionLabel: "Try again",
    };
  }
  if (status === "stopped" || status === "hibernated") {
    return {
      title: "Your preview is offline",
      message: "Wake it to see and use your app again.",
      action: "wake",
      actionLabel: "Wake preview",
    };
  }
  return {
    title: "Checking your preview…",
    message: "We are confirming that the app is ready before showing it.",
    action: "retry",
    actionLabel: "Check again",
  };
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
