export type ProjectImageStatus = "pending" | "generating" | "completed" | "failed";

export type ProjectImageSource = "studio" | "zero" | "project";

export interface ProjectImageItem {
  key: string;
  source: ProjectImageSource;
  id?: number;
  jobId?: string;
  prompt: string;
  status: ProjectImageStatus;
  imageUrl?: string | null;
  thumbnailUrl?: string | null;
  path?: string;
  quality?: string;
  aspectRatio?: string;
  style?: string | null;
  purpose?: string | null;
  error?: string | null;
  createdAt: string;
}

export interface StudioImageRecord {
  id: number;
  prompt: string;
  quality: string;
  aspectRatio: string;
  style?: string | null;
  purpose?: string | null;
  status: string;
  fileUrl?: string | null;
  thumbnailUrl?: string | null;
  errorMessage?: string | null;
  createdAt: string;
}

export interface ProjectImageFile {
  id: number;
  path: string;
  mimeType: string;
  updatedAt: string;
}

export interface ProjectImageTaskEvent {
  id: number;
  taskId: number;
  eventType: string;
  message?: string | null;
  createdAt: string;
}

const IMAGE_EXTENSION = /\.(?:avif|gif|jpe?g|png|svg|webp)$/i;

function encodeProjectPath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function displayNameFromPath(path: string): string {
  const basename =
    path
      .split("/")
      .pop()
      ?.replace(/\.[^.]+$/, "") ?? "Generated image";
  const words = basename.replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Generated image";
}

export function projectImageAssetUrl(projectId: number, path: string): string {
  return `/api/projects/${projectId}/preview/${encodeProjectPath(path)}`;
}

export function isProjectImageFile(file: Pick<ProjectImageFile, "path" | "mimeType">): boolean {
  return file.mimeType.toLowerCase().startsWith("image/") || IMAGE_EXTENSION.test(file.path);
}

export function projectFileToImageItem(
  projectId: number,
  file: ProjectImageFile,
): ProjectImageItem | null {
  if (!isProjectImageFile(file)) return null;
  return {
    key: `asset:${file.path}`,
    source: "project",
    prompt: displayNameFromPath(file.path),
    status: "completed",
    imageUrl: projectImageAssetUrl(projectId, file.path),
    path: file.path,
    createdAt: file.updatedAt,
  };
}

export function studioImageToItem(image: StudioImageRecord): ProjectImageItem {
  const status: ProjectImageStatus = ["pending", "generating", "failed"].includes(image.status)
    ? (image.status as ProjectImageStatus)
    : "completed";
  return {
    key: `studio:${image.id}`,
    source: "studio",
    id: image.id,
    prompt: image.prompt,
    status,
    imageUrl: image.fileUrl,
    thumbnailUrl: image.thumbnailUrl,
    quality: image.quality,
    aspectRatio: image.aspectRatio,
    style: image.style,
    purpose: image.purpose,
    error: image.errorMessage,
    createdAt: image.createdAt,
  };
}

export function parseZeroGeneratedImageEvent(
  projectId: number,
  event: ProjectImageTaskEvent,
): ProjectImageItem | null {
  if (event.eventType !== "generate_image" || !event.message?.trim().startsWith("{")) return null;

  try {
    const payload = JSON.parse(event.message) as {
      tool?: string;
      path?: string;
      mimeType?: string;
      previewDataUri?: string | null;
    };
    const path = payload.path?.trim().replace(/^\/+/, "");
    if (
      payload.tool !== "generate_image" ||
      !path ||
      path.includes("..") ||
      !payload.mimeType?.startsWith("image/")
    ) {
      return null;
    }

    return {
      key: `asset:${path}`,
      source: "zero",
      prompt: displayNameFromPath(path),
      status: "completed",
      imageUrl: payload.previewDataUri || projectImageAssetUrl(projectId, path),
      path,
      createdAt: event.createdAt,
    };
  } catch {
    return null;
  }
}

export function studioInsertPath(imageId: number): string {
  return `assets/generated/image-studio-${imageId}.webp`;
}

export function mergeProjectImageItems(
  ...groups: ReadonlyArray<ReadonlyArray<ProjectImageItem>>
): ProjectImageItem[] {
  const byKey = new Map<string, ProjectImageItem>();

  for (const group of groups) {
    for (const image of group) {
      byKey.set(image.key, image);
    }
  }

  return [...byKey.values()].sort(
    (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
  );
}
