import type { Response } from "express";

// API-served project documents must not inherit the platform's browser origin.
// A response policy remains effective even if an embedding iframe has stale,
// permissive flags. Separate-origin runtime documents use their own policy.
const PREVIEW_DOCUMENT_SANDBOX = "sandbox allow-scripts allow-forms allow-popups";

export function previewDocumentCsp(existing: string | string[] | number | undefined): string[] {
  const policies = Array.isArray(existing)
    ? [...existing]
    : typeof existing === "string" && existing.trim()
      ? [existing]
      : [];
  if (!policies.includes(PREVIEW_DOCUMENT_SANDBOX)) policies.push(PREVIEW_DOCUMENT_SANDBOX);
  return policies;
}

export function protectPreviewDocument(res: Pick<Response, "getHeader" | "setHeader">): void {
  res.setHeader(
    "Content-Security-Policy",
    previewDocumentCsp(res.getHeader("Content-Security-Policy")),
  );
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
}
