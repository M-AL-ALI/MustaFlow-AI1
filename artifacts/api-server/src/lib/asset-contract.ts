import { extname } from "node:path";

export const BASE_ASSET_ALLOWANCE_BYTES = 500 * 1024 * 1024;

export const ASSET_ERROR_MESSAGES = {
  asset_empty: "This file is empty, so it was not uploaded.",
  asset_format_unsupported: "This file type is not supported yet.",
  asset_content_mismatch: "This file's contents do not match its file type.",
  asset_quota_exceeded: "This upload would exceed your 500 MB storage allowance.",
  asset_storage_unavailable: "Uploads are temporarily unavailable. Please try again shortly.",
  asset_not_found: "This upload could not be found.",
  asset_referenced: "This asset is still used by your project and cannot be deleted yet.",
  asset_size_mismatch: "The uploaded file size changed before it finished. Please try again.",
  asset_cancelled: "This upload was cancelled.",
} as const;

export type AssetErrorCode = keyof typeof ASSET_ERROR_MESSAGES;

export function humanBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function quotaMessage(input: { usedBytes: number; limitBytes: number }): string {
  return `This upload would exceed your ${humanBytes(input.limitBytes)} storage allowance. You are using ${humanBytes(input.usedBytes)}.`;
}

const MIME_BY_EXTENSION: Record<string, string[]> = {
  ".png": ["image/png"],
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
  ".webp": ["image/webp"],
  ".gif": ["image/gif"],
  ".pdf": ["application/pdf"],
  ".txt": ["text/plain"],
  ".md": ["text/markdown", "text/plain"],
  ".csv": ["text/csv", "text/plain", "application/vnd.ms-excel"],
  ".json": ["application/json", "text/plain"],
  ".docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ".xlsx": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ".pptx": ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ".webm": ["video/webm"],
  ".mp4": ["video/mp4"],
};

export function acceptsDeclaredAsset(filename: string, mimeType: string): boolean {
  const allowed = MIME_BY_EXTENSION[extname(filename).toLowerCase()];
  return Boolean(allowed?.includes(mimeType.toLowerCase()));
}

function isProbablyText(sample: Buffer): boolean {
  if (sample.includes(0)) return false;
  return sample.toString("utf8").includes("\ufffd") === false;
}

export function sniffAsset(sample: Buffer, filename: string, declaredMime: string): string | null {
  const ext = extname(filename).toLowerCase();
  const hex = sample.subarray(0, 16).toString("hex");
  const ascii = sample.subarray(0, 16).toString("ascii");
  if (hex.startsWith("89504e470d0a1a0a")) return declaredMime === "image/png" ? "image/png" : null;
  if (hex.startsWith("ffd8ff")) return declaredMime === "image/jpeg" ? "image/jpeg" : null;
  if (ascii.slice(0, 4) === "RIFF" && ascii.slice(8, 12) === "WEBP") {
    return declaredMime === "image/webp" ? "image/webp" : null;
  }
  if (ascii.slice(0, 3) === "GIF") return declaredMime === "image/gif" ? "image/gif" : null;
  if (ascii.startsWith("%PDF-"))
    return declaredMime === "application/pdf" ? "application/pdf" : null;
  if (hex.startsWith("1a45dfa3")) return declaredMime === "video/webm" ? "video/webm" : null;
  if (ascii.slice(4, 8) === "ftyp") return declaredMime === "video/mp4" ? "video/mp4" : null;
  if (hex.startsWith("504b0304")) {
    return [".docx", ".xlsx", ".pptx"].includes(ext) ? declaredMime : null;
  }
  if ([".txt", ".md", ".csv", ".json"].includes(ext) && isProbablyText(sample)) {
    return declaredMime;
  }
  return null;
}
