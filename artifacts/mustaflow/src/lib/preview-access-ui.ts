import type { PreviewAccess } from "@workspace/api-client-react";

export function hasServerPreviewAccess(
  previewAccess: PreviewAccess | undefined,
): previewAccess is "direct" | "gateway" {
  return previewAccess === "direct" || previewAccess === "gateway";
}

export type AgenticPreviewUnavailablePresentation = {
  title: string;
  message: string;
  action: "wake" | "retry" | null;
  actionLabel: string | null;
};

export function presentAgenticPreviewUnavailable(
  status: "stopped" | "starting" | "running" | "hibernated" | "error" | undefined,
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
