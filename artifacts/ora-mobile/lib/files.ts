import { getAuthToken } from "@workspace/api-client-react";
import * as FileSystem from "expo-file-system/legacy";
import * as MediaLibrary from "expo-media-library";
import * as Sharing from "expo-sharing";
import { Linking, Platform } from "react-native";

import { API_BASE } from "./api";
import type { OraAsset, OraGeneratedFile } from "./types";

export type SaveOutcome = "image-saved" | "shared" | "opened";

export class FileSaveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileSaveError";
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

async function shareFile(fileUri: string, mimeType?: string): Promise<void> {
  const available = await Sharing.isAvailableAsync();
  if (!available) {
    throw new FileSaveError("Sharing is not available on this device.");
  }
  await Sharing.shareAsync(fileUri, mimeType ? { mimeType } : undefined);
}

/**
 * Save or share a file delivered inline in the chat response (base64 bytes).
 * Images are saved to the photo library; documents open the native share sheet.
 * On web, the bytes are opened in a new tab as a data URI.
 */
export async function saveGeneratedFile(file: OraGeneratedFile): Promise<SaveOutcome> {
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
 * Download a Library asset (auth-protected) and save or share it. Images are
 * saved to the photo library; other files open the native share sheet. On web,
 * the download URL is opened in a new tab.
 */
export async function saveAsset(asset: OraAsset): Promise<SaveOutcome> {
  const downloadUrl = `${API_BASE}/api/ora/assets/${asset.id}/download`;

  if (Platform.OS === "web") {
    await Linking.openURL(downloadUrl);
    return "opened";
  }

  const token = await getAuthToken();
  const fileUri = cacheUri(asset.fileName);
  const result = await FileSystem.downloadAsync(downloadUrl, fileUri, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (result.status >= 400) {
    throw new FileSaveError(`Could not download file (HTTP ${result.status}).`);
  }

  if (asset.kind === "image" || isImageMime(asset.mimeType)) {
    await saveImageToLibrary(result.uri);
    return "image-saved";
  }
  await shareFile(result.uri, asset.mimeType);
  return "shared";
}

/**
 * Save an inline chat image (data: URI or remote URL) to the photo library.
 * On web, the image is opened in a new tab instead.
 */
export async function saveImageFromUrl(
  imageUrl: string,
  suggestedName = "ora-image",
): Promise<SaveOutcome> {
  if (Platform.OS === "web") {
    await Linking.openURL(imageUrl);
    return "opened";
  }

  let fileUri: string;
  const dataMatch = imageUrl.match(/^data:(.*?);base64,(.*)$/s);
  if (dataMatch) {
    const mime = dataMatch[1] || "image/png";
    const base64 = dataMatch[2];
    const ext = (mime.split("/")[1] || "png").split("+")[0];
    fileUri = cacheUri(`${suggestedName}.${ext}`);
    await FileSystem.writeAsStringAsync(fileUri, base64, {
      encoding: FileSystem.EncodingType.Base64,
    });
  } else {
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
    fileUri = result.uri;
  }

  await saveImageToLibrary(fileUri);
  return "image-saved";
}
