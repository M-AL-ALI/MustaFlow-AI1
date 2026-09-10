import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";

export interface PreviewMultipart {
  key: string;
  uploadId: string;
}

export type PreviewMultipartErrorCode =
  | "preview_multipart_unavailable"
  | "preview_multipart_invalid_descriptor"
  | "preview_multipart_invalid_part"
  | "preview_multipart_invalid_etag"
  | "preview_multipart_create_failed"
  | "preview_multipart_upload_failed"
  | "preview_multipart_complete_failed"
  | "preview_multipart_abort_failed"
  | "preview_multipart_verify_failed"
  | "preview_multipart_absence_unconfirmed"
  | "preview_multipart_cancelled"
  | "preview_multipart_timeout";

/** Deliberately carries no provider response, credentials, resource ID or cause. */
export class PreviewMultipartError extends Error {
  constructor(readonly code: PreviewMultipartErrorCode) {
    super(code);
    this.name = "PreviewMultipartError";
  }
}

const PROVIDER_TIMEOUT_MS = 30_000;
const MAX_PART_BYTES = 4 * 1024 * 1024;
const STAGING_PREFIX = "assets/automatic-preview-staging/";
const STAGING_KEY =
  /^assets\/automatic-preview-staging\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/preview\.png$/u;

function visibleAscii(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[^\x21-\x7e]/u.test(value)
  );
}

function checkedDescriptor(value: PreviewMultipart): PreviewMultipart {
  if (!value || typeof value !== "object") {
    throw new PreviewMultipartError("preview_multipart_invalid_descriptor");
  }
  const { key, uploadId } = value;
  if (!visibleAscii(key, 128) || !STAGING_KEY.test(key) || !visibleAscii(uploadId, 1024)) {
    throw new PreviewMultipartError("preview_multipart_invalid_descriptor");
  }
  // Snapshot selectors before any asynchronous boundary.
  return { key, uploadId };
}

function requireConfig(): { client: S3Client; bucket: string } {
  // Match asset-r2 exactly: CF_ACCOUNT_ID, not CF_R2_ACCOUNT_ID.
  const accountId = process.env.CF_ACCOUNT_ID;
  const accessKeyId = process.env.CF_R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.CF_R2_SECRET_ACCESS_KEY;
  const bucket = process.env.CF_R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new PreviewMultipartError("preview_multipart_unavailable");
  }
  try {
    return {
      bucket,
      client: new S3Client({
        region: "auto",
        endpoint: "https://" + accountId + ".r2.cloudflarestorage.com",
        credentials: { accessKeyId, secretAccessKey },
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
        maxAttempts: 1,
      }),
    };
  } catch {
    throw new PreviewMultipartError("preview_multipart_unavailable");
  }
}

function cancellation(signal?: AbortSignal): PreviewMultipartError {
  return new PreviewMultipartError(
    signal?.aborted ? "preview_multipart_cancelled" : "preview_multipart_timeout",
  );
}

/** One wall-clock bound per operation, including both cleanup requests. */
async function withProvider<T>(
  signal: AbortSignal | undefined,
  failureCode: PreviewMultipartErrorCode,
  action: (client: S3Client, bucket: string, boundedSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (signal?.aborted) throw cancellation(signal);
  const deadline = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
  const boundedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const { client, bucket } = requireConfig();
  let onAbort: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(cancellation(signal));
      boundedSignal.addEventListener("abort", onAbort, { once: true });
      if (boundedSignal.aborted) onAbort();
    });
    const operation = Promise.resolve().then(() => {
      if (boundedSignal.aborted) throw cancellation(signal);
      return action(client, bucket, boundedSignal);
    });
    // Bound even a provider promise that does not settle after cancellation.
    return await Promise.race([operation, aborted]);
  } catch (error) {
    if (boundedSignal.aborted) throw cancellation(signal);
    if (error instanceof PreviewMultipartError) throw error;
    throw new PreviewMultipartError(failureCode);
  } finally {
    if (onAbort) boundedSignal.removeEventListener("abort", onAbort);
    try {
      client.destroy();
    } catch {
      // Socket disposal must not replace a sanitized operation result.
    }
  }
}

function requestOptions(abortSignal: AbortSignal) {
  return { abortSignal, requestTimeout: PROVIDER_TIMEOUT_MS };
}

/** Neither a generic 404 nor an error-message substring proves MPU absence. */
function isNoSuchUpload(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return candidate.name === "NoSuchUpload" && candidate.$metadata?.httpStatusCode === 404;
}

/**
 * Creates an UNASSIGNED platform staging MPU with no image bytes or project/user
 * metadata. The parent must durably bind this descriptor to its asset row BEFORE
 * uploading part 1. This adapter cannot prove that SQL binding.
 *
 * A lost create response can leave an unknown EMPTY MPU. Provider lifecycle
 * cleanup for this staging prefix must reclaim it; it is not an identified
 * project resource. This adapter neither installs nor verifies lifecycle rules.
 * R2 encrypts at rest by default; unsupported SSE headers are intentionally absent.
 *
 * @dormantExport AP-2 is disabled and unintegrated. Requires durable descriptor
 * binding before image bytes, staging lifecycle cleanup, parent serial recovery
 * validation, and separately approved rollout activation.
 */
export async function createPreviewMultipart(signal?: AbortSignal): Promise<PreviewMultipart> {
  return withProvider(
    signal,
    "preview_multipart_create_failed",
    async (client, bucket, bounded) => {
      const key = STAGING_PREFIX + randomUUID() + "/preview.png";
      const response = await client.send(
        new CreateMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          ContentType: "image/png",
          CacheControl: "private, no-store",
        }),
        requestOptions(bounded),
      );
      if (
        !visibleAscii(response.UploadId, 1024) ||
        (response.Key !== undefined && response.Key !== key) ||
        (response.Bucket !== undefined && response.Bucket !== bucket)
      ) {
        throw new PreviewMultipartError("preview_multipart_create_failed");
      }
      return { key, uploadId: response.UploadId };
    },
  );
}

/**
 * Caller must first durably bind the descriptor; only part 1 can carry bytes.
 * @dormantExport AP-2 is disabled and unintegrated. Requires durable asset-row
 * ownership, current project/version/runtime admission, cancellation and writer
 * quiescence recovery, parent serial validation, and approved rollout activation.
 */
export async function uploadPreviewPart(
  descriptor: PreviewMultipart,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<string> {
  const { key, uploadId } = checkedDescriptor(descriptor);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_PART_BYTES) {
    throw new PreviewMultipartError("preview_multipart_invalid_part");
  }
  if (signal?.aborted) throw cancellation(signal);
  const body = Buffer.from(bytes);
  return withProvider(
    signal,
    "preview_multipart_upload_failed",
    async (client, bucket, bounded) => {
      const response = await client.send(
        new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: 1,
          Body: body,
          ContentLength: body.byteLength,
          ContentMD5: createHash("md5").update(body).digest("base64"),
        }),
        requestOptions(bounded),
      );
      if (!visibleAscii(response.ETag, 1024)) {
        throw new PreviewMultipartError("preview_multipart_upload_failed");
      }
      return response.ETag;
    },
  );
}

/**
 * @dormantExport AP-2 is disabled and unintegrated. Requires durable completing
 * state, serialized writers, and positive terminal completion acknowledgement.
 * Ambiguous Complete stays blocked; abort/ListParts absence cannot rule out a
 * later object. Requires parent serial recovery validation and approved rollout.
 */
export async function completePreviewMultipart(
  descriptor: PreviewMultipart,
  etag: string,
  signal?: AbortSignal,
): Promise<void> {
  const { key, uploadId } = checkedDescriptor(descriptor);
  if (!visibleAscii(etag, 1024)) {
    throw new PreviewMultipartError("preview_multipart_invalid_etag");
  }
  return withProvider(
    signal,
    "preview_multipart_complete_failed",
    async (client, bucket, bounded) => {
      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: [{ PartNumber: 1, ETag: etag }] },
        }),
        requestOptions(bounded),
      );
    },
  );
}

/**
 * Uses a fresh cleanup deadline, never the capture's aborted signal. No SDK or
 * local retries: a durable cleanup state may explicitly authorize another call.
 *
 * Quiesce part/complete writers before cleanup. Success proves only the specified
 * MPU's absence or successful abort with no remaining parts, NOT the absence of
 * a completed object. Ambiguous completion needs separate object reconciliation.
 * Any failure must retain the parent's durable cleanup state.
 *
 * @dormantExport AP-2 is disabled and unintegrated. Requires durable cleanup
 * ownership, quiesced writers and retries, separate ambiguous-completion/object
 * reconciliation, parent serial recovery validation, and approved rollout.
 */
export async function abortPreviewMultipart(descriptor: PreviewMultipart): Promise<void> {
  const { key, uploadId } = checkedDescriptor(descriptor);
  return withProvider(
    undefined,
    "preview_multipart_abort_failed",
    async (client, bucket, bounded) => {
      const target = { Bucket: bucket, Key: key, UploadId: uploadId };
      try {
        await client.send(new AbortMultipartUploadCommand(target), requestOptions(bounded));
      } catch (error) {
        if (isNoSuchUpload(error)) return;
        throw new PreviewMultipartError("preview_multipart_abort_failed");
      }

      bounded.throwIfAborted();
      let response;
      try {
        response = await client.send(
          new ListPartsCommand({ ...target, MaxParts: 1 }),
          requestOptions(bounded),
        );
      } catch (error) {
        if (isNoSuchUpload(error)) return;
        throw new PreviewMultipartError("preview_multipart_verify_failed");
      }
      if (
        response.IsTruncated !== false ||
        (response.Parts !== undefined &&
          (!Array.isArray(response.Parts) || response.Parts.length !== 0)) ||
        (response.NextPartNumberMarker !== undefined && response.NextPartNumberMarker !== "0") ||
        (response.Key !== undefined && response.Key !== key) ||
        (response.UploadId !== undefined && response.UploadId !== uploadId) ||
        (response.Bucket !== undefined && response.Bucket !== bucket)
      ) {
        throw new PreviewMultipartError("preview_multipart_absence_unconfirmed");
      }
      // An omitted Parts field represents an empty XML list, but IsTruncated must
      // still explicitly be false. A truncated or malformed response is no proof.
    },
  );
}
