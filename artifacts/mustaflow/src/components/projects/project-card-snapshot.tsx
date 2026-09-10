import { useEffect, useState } from "react";
import { Monitor } from "lucide-react";
import { authFetch } from "@/lib/api-fetch";

type Snapshot = {
  id: number;
  createdAt: string;
  /** Present only for a dashboard-preview asset bound to the requested version. */
  matchedVersionId?: number;
};
type SnapshotState = {
  key: string;
  status: "loading" | "empty" | "ready" | "unavailable";
  url?: string;
  createdAt?: string;
  matchedVersionId?: number;
};
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

/**
 * Consumes the authenticated /api/assets response, which lists ready assets only.
 * Source and version metadata identify a saved image, not a live capture or runtime state.
 */
export function selectProjectSnapshot(
  value: unknown,
  projectId: number,
  requestedVersionId?: number | null,
): Snapshot | null {
  if (
    !Number.isSafeInteger(projectId) ||
    projectId <= 0 ||
    !value ||
    typeof value !== "object" ||
    !("assets" in value) ||
    !Array.isArray(value.assets)
  )
    return null;
  const candidates = value.assets
    .filter((asset: unknown): asset is Record<string, unknown> => {
      if (!asset || typeof asset !== "object") return false;
      const row = asset as Record<string, unknown>;
      const context = row.context;
      const partial =
        context && typeof context === "object" && ("region" in context || "annotation" in context);
      return (
        row.projectId === projectId &&
        row.kind === "snapshot" &&
        (row.source === "observe" || row.source === "dashboard-preview") &&
        Number.isSafeInteger(row.id) &&
        Number(row.id) > 0 &&
        ["image/png", "image/jpeg", "image/webp"].includes(String(row.mimeType)) &&
        typeof row.sizeBytes === "number" &&
        Number.isSafeInteger(row.sizeBytes) &&
        row.sizeBytes > 0 &&
        row.sizeBytes <= MAX_PREVIEW_BYTES &&
        typeof row.createdAt === "string" &&
        Number.isFinite(Date.parse(row.createdAt)) &&
        !partial
      );
    })
    .sort(
      (a, b) =>
        Date.parse(String(b.createdAt)) - Date.parse(String(a.createdAt)) ||
        Number(b.id) - Number(a.id),
    );
  const versionId =
    typeof requestedVersionId === "number" &&
    Number.isSafeInteger(requestedVersionId) &&
    requestedVersionId > 0
      ? requestedVersionId
      : null;
  const matched =
    versionId === null
      ? undefined
      : candidates.find((row) => row.source === "dashboard-preview" && row.versionId === versionId);
  if (matched && versionId !== null) {
    return {
      id: Number(matched.id),
      createdAt: String(matched.createdAt),
      matchedVersionId: versionId,
    };
  }
  const latest = candidates[0];
  return latest ? { id: Number(latest.id), createdAt: String(latest.createdAt) } : null;
}

async function readBoundedImage(response: Response): Promise<Blob> {
  const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
  if (!response.ok || !["image/png", "image/jpeg", "image/webp"].includes(type))
    throw new Error("Preview unavailable");
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_PREVIEW_BYTES || !response.body) throw new Error("Preview unavailable");
  const reader = response.body.getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_PREVIEW_BYTES) throw new Error("Preview exceeds size limit");
      parts.push(new Uint8Array(chunk.value));
    }
    if (bytes === 0) throw new Error("Preview is empty");
    return new Blob(parts, { type });
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Read existing private evidence only. Opening a dashboard must never wake runtimes or run AI. */
export function ProjectCardSnapshot({
  projectId,
  projectName,
  identity,
  revision,
  requestedVersionId,
}: {
  projectId: number;
  projectName: string;
  identity?: string | null;
  revision: string;
  /** An immutable project_versions ID; the revision timestamp is only a cache hint. */
  requestedVersionId?: number | null;
}) {
  const key = identity
    ? JSON.stringify([identity, projectId, revision, requestedVersionId ?? null])
    : "";
  const [state, setState] = useState<SnapshotState>({ key: "", status: "empty" });
  useEffect(() => {
    if (!key || !Number.isSafeInteger(projectId) || projectId <= 0) return;
    const controller = new AbortController();
    let current = true;
    let objectUrl: string | undefined;
    const timeout = setTimeout(() => controller.abort(), 15000);
    setState({ key, status: "loading" });
    void (async () => {
      try {
        const response = await authFetch("/api/assets?projectId=" + projectId + "&limit=100", {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Preview unavailable");
        const snapshot = selectProjectSnapshot(
          await response.json(),
          projectId,
          requestedVersionId,
        );
        if (!snapshot) {
          if (current) setState({ key, status: "empty" });
          return;
        }
        // Ignore URLs from metadata; only request this product's canonical asset endpoint.
        const image = await authFetch("/api/assets/" + snapshot.id + "/content", {
          signal: controller.signal,
        });
        const blob = await readBoundedImage(image);
        if (!current || controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ key, status: "ready", url: objectUrl, ...snapshot });
      } catch {
        if (current) setState({ key, status: "unavailable" });
      } finally {
        clearTimeout(timeout);
      }
    })();
    return () => {
      current = false;
      controller.abort();
      clearTimeout(timeout);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [key, projectId, requestedVersionId]);

  const visible = state.key === key ? state : { key, status: "empty" as const };
  if (visible.status === "ready" && visible.url) {
    return (
      <>
        <img
          src={visible.url}
          alt={
            visible.matchedVersionId
              ? `Saved snapshot of ${projectName} at version ${visible.matchedVersionId}`
              : "Last saved snapshot of " + projectName
          }
          className="absolute inset-0 h-full w-full object-cover object-top"
          decoding="async"
        />
        <span className="absolute inset-x-0 bottom-0 z-10 border-t border-border bg-card/95 px-3 py-2 text-left text-xs text-foreground">
          {visible.matchedVersionId
            ? `Saved snapshot / version ${visible.matchedVersionId}`
            : "Last saved snapshot"}
          {" / "}
          {new Date(visible.createdAt!).toLocaleDateString()}
          <span className="block text-muted-foreground">
            {visible.matchedVersionId
              ? "Saved for the requested version; not a live view."
              : "May not match the current project version."}
          </span>
          <span className="block text-muted-foreground">Open live preview</span>
        </span>
      </>
    );
  }
  return (
    <>
      <span className="nf-preview-mark" aria-hidden="true">
        <Monitor size={25} strokeWidth={1.3} />
      </span>
      <span>
        {visible.status === "loading" ? "Loading saved snapshot" : "Preview this project"}
      </span>
      <small>
        {visible.status === "unavailable"
          ? "Saved snapshot unavailable. You can still open the project."
          : "Open live preview without entering the editor"}
      </small>
    </>
  );
}
