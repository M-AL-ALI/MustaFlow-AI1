import { authFetch } from "./api-fetch";

export type SnapshotObserveRequest = {
  path: string;
  previewSource: "server" | "webcontainer";
  viewport: { width: number; height: number };
};

export type SnapshotObserveResult =
  | { ok: true; previewClass: "db-static" | "runtime-proxy" | "cloudflare-grant" }
  | { ok: false; message: string };

type SnapshotTransport = (
  input: string,
  init: RequestInit,
) => Promise<Pick<Response, "ok" | "json">>;

const SNAPSHOT_UNAVAILABLE_MESSAGE = "I couldn't capture this preview safely. Please try again.";
const PREVIEW_CLASSES = new Set(["db-static", "runtime-proxy", "cloudflare-grant"]);

export async function requestSnapshotObservation(
  projectId: number,
  snapshot: SnapshotObserveRequest,
  transport: SnapshotTransport = authFetch,
): Promise<SnapshotObserveResult> {
  try {
    const response = await transport(`/api/projects/${projectId}/observe/snapshot`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshot),
    });
    const body = (await response.json().catch(() => null)) as {
      ok?: unknown;
      previewClass?: unknown;
    } | null;
    if (!response.ok || body?.ok !== true || !PREVIEW_CLASSES.has(String(body.previewClass))) {
      return { ok: false, message: SNAPSHOT_UNAVAILABLE_MESSAGE };
    }
    return {
      ok: true,
      previewClass: body.previewClass as "db-static" | "runtime-proxy" | "cloudflare-grant",
    };
  } catch {
    return { ok: false, message: SNAPSHOT_UNAVAILABLE_MESSAGE };
  }
}
