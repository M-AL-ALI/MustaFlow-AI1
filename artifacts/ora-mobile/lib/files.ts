import { getAuthToken } from "./auth-client";
import * as FileSystem from "expo-file-system/legacy";
import * as MediaLibrary from "expo-media-library";
import * as Sharing from "expo-sharing";
import { Linking, Platform } from "react-native";

import { API_BASE } from "./api";
import type { GeneratedFile, OraAsset } from "./types";

export type SaveOutcome = "image-saved" | "shared" | "opened";

export class FileSaveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileSaveError";
  }
}

/**
 * Mirrors the server's multer upload cap (10 MB). This is a client-side UX
 * precheck only; `/api/public-ai/upload` remains the authoritative limit and
 * still returns 413 if a larger file slips through.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Best-effort byte size for a local file URI. Prefers a picker-provided size
 * (DocumentPicker `size` / ImagePicker `fileSize`) and falls back to a
 * filesystem stat, which is needed for camera captures where the picker omits
 * it. Returns null when the size genuinely cannot be determined.
 */
export async function getLocalFileSize(uri: string, known?: number | null): Promise<number | null> {
  if (typeof known === "number" && known > 0) return known;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists ? info.size : null;
  } catch {
    return null;
  }
}

function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_");
  return cleaned.replace(/^_+|_+$/g, "") || "ora-file";
}

function isImageMime(mimeType?: string): boolean {
  return !!mimeType && mimeType.toLowerCase().startsWith("image/");
}

function cacheUri(fileName: string): string {
  const dir = FileSystem.cacheDirectory ?? "";
  return `${dir}${sanitizeFileName(fileName)}`;
}

async function saveImageToLibrary(fileUri: string): Promise<void> {
  const perm = await MediaLibrary.requestPermissionsAsync();
  if (!perm.granted) {
    throw new FileSaveError(
      "Photo library access is needed to save images. Enable it in Settings.",
    );
  }
  await MediaLibrary.saveToLibraryAsync(fileUri);
}

async function shareFile(fileUri: string, mimeType?: string, uti?: string): Promise<void> {
  const available = await Sharing.isAvailableAsync();
  if (!available) {
    throw new FileSaveError("Sharing is not available on this device.");
  }
  const opts: { mimeType?: string; UTI?: string } = {};
  if (mimeType) opts.mimeType = mimeType;
  if (uti) opts.UTI = uti;
  await Sharing.shareAsync(fileUri, Object.keys(opts).length ? opts : undefined);
}

/**
 * Save or share a file delivered inline in the chat response (base64 bytes).
 * Images are saved to the photo library; documents open the native share sheet.
 * On web, the bytes are opened in a new tab as a data URI.
 */
export async function saveGeneratedFile(file: GeneratedFile): Promise<SaveOutcome> {
  // Persisted/reloaded messages drop the base64 bytes (only metadata survives).
  // For signed-in users the file was also saved to the durable library, so fall
  // back to downloading it by asset id; otherwise guide the user to regenerate.
  if (!file.fileData) {
    if (file.assetId != null) {
      return downloadAssetById(file.assetId, file.fileName, file.mimeType);
    }
    throw new FileSaveError(
      "These file contents are no longer available. Regenerate it to download.",
    );
  }

  if (Platform.OS === "web") {
    await Linking.openURL(`data:${file.mimeType};base64,${file.fileData}`);
    return "opened";
  }

  const fileUri = cacheUri(file.fileName);
  await FileSystem.writeAsStringAsync(fileUri, file.fileData, {
    encoding: FileSystem.EncodingType.Base64,
  });

  if (isImageMime(file.mimeType)) {
    await saveImageToLibrary(fileUri);
    return "image-saved";
  }
  await shareFile(fileUri, file.mimeType);
  return "shared";
}

/**
 * Save an arbitrary text reply (e.g. an assistant message) as a file. The bytes
 * are written as UTF-8 and handed to the native share sheet so the user can save
 * to Files, Notes, etc. On web the text is opened in a new tab as a data URI.
 */
export async function saveTextAsFile(
  text: string,
  fileName: string,
  mimeType = "text/markdown",
): Promise<SaveOutcome> {
  if (Platform.OS === "web") {
    await Linking.openURL(`data:${mimeType};charset=utf-8,${encodeURIComponent(text)}`);
    return "opened";
  }

  const fileUri = cacheUri(fileName);
  await FileSystem.writeAsStringAsync(fileUri, text, {
    encoding: FileSystem.EncodingType.UTF8,
  });
  await shareFile(fileUri, mimeType);
  return "shared";
}

type PrintModule = typeof import("expo-print");
let printModule: PrintModule | null | undefined;

/**
 * expo-print is a native module. On an older native build (one created before
 * expo-print was added) the native side is missing, so a static top-level
 * import throws at module-load time and crashes the entire app — not just PDF
 * export. Load it lazily and cache the outcome (including the "unavailable"
 * case) so the app always launches and only PDF export degrades.
 */
function getPrintModule(): PrintModule | null {
  if (printModule === undefined) {
    try {
      printModule = require("expo-print") as PrintModule;
    } catch {
      printModule = null;
    }
  }
  return printModule;
}

/**
 * Render an HTML report to a real PDF on device (via expo-print) and hand it to
 * the native share sheet. This mirrors the website's print-to-PDF export, but
 * writes an actual `.pdf` file instead of the portable `.html` stand-in.
 *
 * Requires a native build that includes expo-print. On web — or on an older
 * native build that is missing the module — it falls back to an HTML export so
 * the user still gets their report; a fresh native build restores real PDF.
 */
export async function saveHtmlAsPdf(
  html: string,
  fileName = "ora-report.pdf",
): Promise<SaveOutcome> {
  if (Platform.OS === "web") {
    await Linking.openURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return "opened";
  }

  const Print = getPrintModule();
  if (!Print) {
    // Native PDF module unavailable on this build — fall back to an HTML file so
    // the export still works. Rebuilding the app restores real PDF output.
    const htmlName = `${fileName.replace(/\.pdf$/i, "")}.html`;
    return saveTextAsFile(html, htmlName, "text/html");
  }

  const { uri } = await Print.printToFileAsync({ html });
  // printToFileAsync writes to a randomly named cache file; rename it so the
  // share sheet shows a friendly filename. Fall back to the original uri if the
  // move fails for any reason.
  let shareUri = uri;
  try {
    const target = cacheUri(fileName.toLowerCase().endsWith(".pdf") ? fileName : `${fileName}.pdf`);
    await FileSystem.deleteAsync(target, { idempotent: true });
    await FileSystem.moveAsync({ from: uri, to: target });
    shareUri = target;
  } catch {
    /* keep original uri */
  }
  await shareFile(shareUri, "application/pdf", "com.adobe.pdf");
  return "shared";
}

/**
 * Download a Library asset (auth-protected) and save or share it. Images are
 * saved to the photo library; other files open the native share sheet. On web,
 * the download URL is opened in a new tab.
 */
export async function saveAsset(asset: OraAsset): Promise<SaveOutcome> {
  return downloadAssetById(
    asset.id,
    asset.fileName,
    asset.mimeType,
    asset.kind === "image" || isImageMime(asset.mimeType),
  );
}

/**
 * Download a durable library asset by id and save/share it. Used both by the
 * Library (saveAsset) and by reloaded chat messages whose inline bytes were
 * dropped but that carry an asset id (saveGeneratedFile fallback). The bearer
 * token is attached so the owner-scoped /download route authorizes the request.
 */
async function downloadAssetById(
  id: number,
  fileName: string,
  mimeType: string,
  isImage = isImageMime(mimeType),
): Promise<SaveOutcome> {
  const downloadUrl = `${API_BASE}/api/ora/assets/${id}/download`;

  if (Platform.OS === "web") {
    await Linking.openURL(downloadUrl);
    return "opened";
  }

  const token = await getAuthToken();
  const fileUri = cacheUri(fileName);
  const result = await FileSystem.downloadAsync(downloadUrl, fileUri, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (result.status >= 400) {
    throw new FileSaveError(`Could not download file (HTTP ${result.status}).`);
  }

  if (isImage) {
    await saveImageToLibrary(result.uri);
    return "image-saved";
  }
  await shareFile(result.uri, mimeType);
  return "shared";
}

/**
 * Materialize an inline chat image (data: URI, a local file:// URI, or a remote
 * URL) into a real file in the cache directory and return its local URI. Remote
 * API-served URLs get the Clerk bearer token so the owner-scoped image route
 * authorizes the download. Shared by save and share so both operate on a real
 * on-disk file regardless of the source shape.
 */
async function materializeImageToCache(
  imageUrl: string,
  suggestedName = "ora-image",
): Promise<{ uri: string; mimeType?: string }> {
  const dataMatch = imageUrl.match(/^data:(.*?);base64,(.*)$/s);
  if (dataMatch) {
    const mime = dataMatch[1] || "image/png";
    const base64 = dataMatch[2];
    const ext = (mime.split("/")[1] || "png").split("+")[0];
    const fileUri = cacheUri(`${suggestedName}.${ext}`);
    await FileSystem.writeAsStringAsync(fileUri, base64, {
      encoding: FileSystem.EncodingType.Base64,
    });
    return { uri: fileUri, mimeType: mime };
  }

  // Already a local file (e.g. an uploaded image the user just picked) — no
  // download needed, hand back the URI as-is.
  if (imageUrl.startsWith("file://")) {
    return { uri: imageUrl };
  }

  const ext = imageUrl.split("?")[0].split(".").pop() || "png";
  const target = cacheUri(`${suggestedName}.${ext}`);
  const token = await getAuthToken();
  const result = await FileSystem.downloadAsync(imageUrl, target, {
    headers:
      token && imageUrl.startsWith(API_BASE) ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (result.status >= 400) {
    throw new FileSaveError(`Could not download image (HTTP ${result.status}).`);
  }
  return { uri: result.uri };
}

/**
 * Save an inline chat image (data: URI, local file:// URI, or remote URL) to
 * the photo library. Photo-library permission is requested lazily inside
 * saveImageToLibrary — only when this runs. On web, the image is opened in a
 * new tab instead.
 */
export async function saveImageFromUrl(
  imageUrl: string,
  suggestedName = "ora-image",
): Promise<SaveOutcome> {
  if (Platform.OS === "web") {
    await Linking.openURL(imageUrl);
    return "opened";
  }

  const { uri } = await materializeImageToCache(imageUrl, suggestedName);
  await saveImageToLibrary(uri);
  return "image-saved";
}

/**
 * Share an inline chat image (data: URI, local file:// URI, or remote URL) via
 * the native share sheet. Auth-gated / remote images are downloaded to a temp
 * file first so the share sheet receives a real file, not a URL that would
 * require the recipient to authenticate. On web, the image is opened in a new
 * tab instead.
 */
export async function shareImageFromUrl(
  imageUrl: string,
  suggestedName = "ora-image",
): Promise<SaveOutcome> {
  if (Platform.OS === "web") {
    await Linking.openURL(imageUrl);
    return "opened";
  }

  const { uri, mimeType } = await materializeImageToCache(imageUrl, suggestedName);
  const uti =
    mimeType === "image/png"
      ? "public.png"
      : mimeType === "image/jpeg" || mimeType === "image/jpg"
        ? "public.jpeg"
        : undefined;
  await shareFile(uri, mimeType, uti);
  return "shared";
}
