import { getAuthToken } from "@workspace/api-client-react";
import { authFetch } from "./api-fetch";

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  webm: "video/webm",
  mp4: "video/mp4",
};

export type AssetUploadResult = {
  assetId: number;
  name: string;
  mimeType: string;
  sizeBytes: number;
  contentUrl: string;
  resized: boolean;
};

export function formatAssetBytes(value: number): string {
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function assetMimeType(file: File): string | null {
  if (file.type) return file.type.toLowerCase();
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[extension] ?? null;
}

export async function prepareAssetFile(file: File): Promise<{
  body: Blob;
  mimeType: string;
  resized: boolean;
}> {
  const mimeType = assetMimeType(file);
  if (!mimeType) throw new Error("This file type is not supported yet.");
  if (!mimeType.startsWith("image/") || mimeType === "image/gif") {
    return { body: file, mimeType, resized: false };
  }
  const maxDimension = 2048;
  return new Promise((resolve) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      if (image.width <= maxDimension && image.height <= maxDimension) {
        resolve({ body: file, mimeType, resized: false });
        return;
      }
      const scale = Math.min(maxDimension / image.width, maxDimension / image.height);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(image.width * scale);
      canvas.height = Math.round(image.height * scale);
      const context = canvas.getContext("2d");
      if (!context) {
        resolve({ body: file, mimeType, resized: false });
        return;
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) => resolve({ body: blob ?? file, mimeType, resized: Boolean(blob) }),
        mimeType,
        0.92,
      );
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve({ body: file, mimeType, resized: false });
    };
    image.src = objectUrl;
  });
}

async function putWithProgress(input: {
  url: string;
  body: Blob;
  mimeType: string;
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
}): Promise<void> {
  const token = await getAuthToken();
  await new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", input.url);
    request.withCredentials = true;
    request.setRequestHeader("Content-Type", input.mimeType);
    if (token) request.setRequestHeader("Authorization", `Bearer ${token}`);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable)
        input.onProgress?.(Math.round((event.loaded / event.total) * 100));
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        resolve();
        return;
      }
      try {
        const body = JSON.parse(request.responseText) as { error?: string };
        reject(new Error(body.error ?? "The upload could not be completed."));
      } catch {
        reject(new Error("The upload could not be completed."));
      }
    };
    request.onerror = () => reject(new Error("The upload could not be completed."));
    request.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    input.signal?.addEventListener("abort", () => request.abort(), { once: true });
    request.send(input.body);
  });
}

async function uploadAsset(input: {
  projectId?: number;
  file: File;
  source: "picker" | "paste" | "drop" | "observe" | "recording";
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
}): Promise<AssetUploadResult> {
  const prepared = await prepareAssetFile(input.file);
  const reservePath =
    input.projectId === undefined
      ? "/api/assets/reserve"
      : `/api/projects/${input.projectId}/assets/reserve`;
  const reserve = await authFetch(reservePath, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: input.file.name,
      mimeType: prepared.mimeType,
      sizeBytes: prepared.body.size,
      kind: prepared.mimeType.startsWith("image/") ? "image" : "file",
      source: input.source,
      context: prepared.resized ? { resized: true } : null,
    }),
  });
  const reservation = (await reserve.json().catch(() => ({}))) as {
    assetId?: number;
    uploadUrl?: string;
    error?: string;
  };
  if (!reserve.ok || typeof reservation.assetId !== "number" || !reservation.uploadUrl) {
    throw new Error(reservation.error ?? "The upload could not be started.");
  }
  try {
    await putWithProgress({
      url: reservation.uploadUrl,
      body: prepared.body,
      mimeType: prepared.mimeType,
      signal: input.signal,
      onProgress: input.onProgress,
    });
  } catch (error) {
    await authFetch(`/api/assets/${reservation.assetId}/reservation`, {
      method: "DELETE",
    }).catch(() => undefined);
    throw error;
  }
  return {
    assetId: reservation.assetId,
    name: input.file.name,
    mimeType: prepared.mimeType,
    sizeBytes: prepared.body.size,
    contentUrl: `/api/assets/${reservation.assetId}/content`,
    resized: prepared.resized,
  };
}

export function uploadProjectAsset(
  input: Parameters<typeof uploadAsset>[0] & { projectId: number },
): Promise<AssetUploadResult> {
  return uploadAsset(input);
}

export function uploadAccountAsset(
  input: Omit<Parameters<typeof uploadAsset>[0], "projectId">,
): Promise<AssetUploadResult> {
  return uploadAsset(input);
}
