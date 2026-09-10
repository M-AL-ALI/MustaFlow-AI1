import { authFetch, getAuthTokenWithinBudget } from "./api-fetch";
import {
  createProjectReviewAccountFence,
  type ProjectReviewAccountFence,
  type ProjectReviewClerk,
} from "./project-review-account-fence";

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
  signal: AbortSignal;
  assertCurrent: () => void;
  onProgress?: (progress: number) => void;
}): Promise<void> {
  input.assertCurrent();
  const token = await duringUpload(getAuthTokenWithinBudget(), input.signal);
  input.assertCurrent();
  await new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener("abort", abort);
      request.onload = request.onerror = request.onabort = null;
      request.upload.onprogress = null;
      if (error !== undefined) reject(error);
      else resolve();
    };
    const abort = () => {
      request.abort();
      finish(uploadCancelled());
    };
    request.open("PUT", input.url);
    request.withCredentials = true;
    request.setRequestHeader("Content-Type", input.mimeType);
    if (token) request.setRequestHeader("Authorization", `Bearer ${token}`);
    request.upload.onprogress = (event) => {
      if (settled) return;
      try {
        input.assertCurrent();
        if (event.lengthComputable)
          input.onProgress?.(Math.round((event.loaded / event.total) * 100));
      } catch {
        abort();
      }
    };
    request.onload = () => {
      try {
        input.assertCurrent();
        if (request.status >= 200 && request.status < 300) {
          finish();
          return;
        }
        const body = JSON.parse(request.responseText) as { error?: string };
        finish(new Error(body.error ?? "The upload could not be completed."));
      } catch (error) {
        finish(
          input.signal.aborted
            ? uploadCancelled()
            : error instanceof SyntaxError
              ? new Error("The upload could not be completed.")
              : error,
        );
      }
    };
    request.onerror = () => finish(new Error("The upload could not be completed."));
    request.onabort = () => finish(uploadCancelled());
    input.signal.addEventListener("abort", abort, { once: true });
    try {
      input.assertCurrent();
      request.send(input.body);
    } catch (error) {
      finish(error);
    }
  });
}

function uploadCancelled(): DOMException {
  return new DOMException("Upload cancelled", "AbortError");
}

function duringUpload<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(uploadCancelled());
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    // Consume late rejection even when cancellation has already won.
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(uploadCancelled());
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function uploadAccountFence(onInvalidate: () => void): ProjectReviewAccountFence {
  const browser = window as unknown as {
    Clerk?: ProjectReviewClerk;
    __E2E_TEST_USER__?: string;
  };
  // Preserve App's existing development-only cookie/E2E identity contract.
  const testUser = import.meta.env.DEV ? browser.__E2E_TEST_USER__ : undefined;
  if (typeof testUser === "string" && testUser.length > 0) {
    let valid = true;
    return {
      isCurrent() {
        if (valid && browser.__E2E_TEST_USER__ !== testUser) {
          valid = false;
          onInvalidate();
        }
        return valid;
      },
      dispose() {
        valid = false;
      },
    };
  }
  return createProjectReviewAccountFence(browser.Clerk?.user?.id ?? "", onInvalidate);
}

export type AssetUploadLifetime = {
  readonly signal: AbortSignal;
  isCurrent: () => boolean;
  assertCurrent: () => void;
  dispose: () => void;
};

/** Capture at selection/recording start and retain across every file and await. */
export function createAssetUploadLifetime(): AssetUploadLifetime {
  const controller = new AbortController();
  const fence = uploadAccountFence(() => controller.abort());
  const isCurrent = () => {
    if (!fence.isCurrent()) controller.abort();
    return !controller.signal.aborted;
  };
  isCurrent();
  return {
    signal: controller.signal,
    isCurrent,
    assertCurrent() {
      if (!isCurrent()) throw uploadCancelled();
    },
    dispose() {
      controller.abort();
      fence.dispose();
    },
  };
}

async function uploadAsset(input: {
  projectId?: number;
  file: File;
  source: "picker" | "paste" | "drop" | "observe" | "recording";
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
}): Promise<AssetUploadResult> {
  const controller = new AbortController();
  const cleanupController = new AbortController();
  const fence = uploadAccountFence(() => {
    controller.abort();
    cleanupController.abort();
  });
  const cancel = () => controller.abort();
  input.signal?.addEventListener("abort", cancel, { once: true });
  if (input.signal?.aborted) cancel();
  const assertAccount = () => {
    if (!fence.isCurrent()) throw uploadCancelled();
  };
  const assertCurrent = () => {
    assertAccount();
    if (controller.signal.aborted) throw uploadCancelled();
  };
  let reservationId: number | null = null;
  try {
    assertCurrent();
    const prepared = await duringUpload(prepareAssetFile(input.file), controller.signal);
    assertCurrent();
    const reservePath =
      input.projectId === undefined
        ? "/api/assets/reserve"
        : `/api/projects/${input.projectId}/assets/reserve`;
    const reserve = await duringUpload(
      authFetch(
        reservePath,
        {
          method: "POST",
          signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: input.file.name,
            mimeType: prepared.mimeType,
            sizeBytes: prepared.body.size,
            kind: prepared.mimeType.startsWith("image/") ? "image" : "file",
            source: input.source,
            context: prepared.resized ? { resized: true } : null,
          }),
        },
        assertCurrent,
      ),
      controller.signal,
    );
    const reservation = (await reserve.json().catch(() => ({}))) as {
      assetId?: number;
      uploadUrl?: string;
      error?: string;
    };
    if (Number.isSafeInteger(reservation.assetId) && reservation.assetId! > 0)
      reservationId = reservation.assetId!;
    assertCurrent();
    if (!reserve.ok || reservationId === null || !reservation.uploadUrl)
      throw new Error(reservation.error ?? "The upload could not be started.");
    // The reservation API returns this exact same-origin proxy, never a provider URL.
    const uploadUrl = `/api/assets/${reservationId}/content`;
    if (reservation.uploadUrl !== uploadUrl)
      throw new Error("The upload destination could not be verified.");
    await putWithProgress({
      url: uploadUrl,
      body: prepared.body,
      mimeType: prepared.mimeType,
      signal: controller.signal,
      assertCurrent,
      onProgress: input.onProgress,
    });
    assertCurrent();
    return {
      assetId: reservationId,
      name: input.file.name,
      mimeType: prepared.mimeType,
      sizeBytes: prepared.body.size,
      contentUrl: uploadUrl,
      resized: prepared.resized,
    };
  } catch (error) {
    // Never compensate using a replacement account. If identity departed, the
    // durable reservation sweeper owns expiry; it is not proof of immediate deletion.
    if (reservationId !== null && fence.isCurrent()) {
      const timeout = setTimeout(() => cleanupController.abort(), 10_000);
      try {
        await duringUpload(
          authFetch(
            `/api/assets/${reservationId}/reservation`,
            {
              method: "DELETE",
              signal: cleanupController.signal,
            },
            assertAccount,
          ),
          cleanupController.signal,
        );
      } catch {
        // Preserve the upload failure; server expiry retains cleanup responsibility.
      } finally {
        clearTimeout(timeout);
      }
    }
    throw error;
  } finally {
    input.signal?.removeEventListener("abort", cancel);
    fence.dispose();
  }
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
