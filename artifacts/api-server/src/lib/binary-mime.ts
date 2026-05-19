/**
 * Explicit allowlist of MIME types whose content is stored as raw base64 in
 * project_files.content.  Only truly binary formats belong here — text-based
 * image types (e.g. image/svg+xml) are NOT included because their content is
 * plain UTF-8 and must be written/sent without base64 decoding.
 *
 * Consumers must call Buffer.from(content, "base64") before sending HTTP
 * responses or writing to ZIP archives for any MIME type in this set.
 */
export const BINARY_MIME_TYPES = new Set<string>([
  // Raster images
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/ico",
  "image/x-icon",
  "image/tiff",
  "image/avif",
  // Audio
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/ogg",
  "audio/mp4",
  "audio/aac",
  // Video
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
  // Fonts
  "font/woff",
  "font/woff2",
  "font/ttf",
  "font/otf",
  "font/eot",
  // Generic binary
  "application/octet-stream",
]);

/** Returns true when project_files.content is base64-encoded binary data. */
export function isBinaryMime(mime: string): boolean {
  return BINARY_MIME_TYPES.has(mime);
}
