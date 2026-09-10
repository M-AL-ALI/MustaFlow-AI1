import { Buffer } from "node:buffer";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  ListPartsCommand,
  UploadPartCommand,
  type ListPartsCommandOutput,
} from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: vi.fn<(options: Record<string, unknown>) => void>(),
  send: vi.fn<
    (
      command: { input: Record<string, unknown> },
      options: { abortSignal: AbortSignal; requestTimeout: number },
    ) => Promise<Record<string, unknown>>
  >(),
  destroy: vi.fn<() => void>(),
}));

vi.mock("@aws-sdk/client-s3", () => {
  class Command {
    constructor(readonly input: Record<string, unknown>) {}
  }
  return {
    S3Client: class {
      constructor(options: Record<string, unknown>) {
        mocks.config(options);
      }
      send = mocks.send;
      destroy = mocks.destroy;
    },
    CreateMultipartUploadCommand: class extends Command {},
    UploadPartCommand: class extends Command {},
    CompleteMultipartUploadCommand: class extends Command {},
    AbortMultipartUploadCommand: class extends Command {},
    ListPartsCommand: class extends Command {},
  };
});

import {
  abortPreviewMultipart,
  completePreviewMultipart,
  createPreviewMultipart,
  PreviewMultipartError,
  uploadPreviewPart,
  type PreviewMultipart,
  type PreviewMultipartErrorCode,
} from "./automatic-preview-r2-multipart";

const descriptor: PreviewMultipart = {
  key: "assets/automatic-preview-staging/8b2e64a1-cb45-4c9a-9e34-8d2ba479d518/preview.png",
  uploadId: "opaque-upload-id+/=",
};
const etag = '"900150983cd24fb0d6963f7d28e17f72"';
const bucket = "preview-private-bucket";
const providerError = (name: string, status: number) =>
  Object.assign(new Error("sensitive-provider-body"), {
    name,
    $metadata: { httpStatusCode: status },
  });

async function expectCode(pending: Promise<unknown>, code: PreviewMultipartErrorCode) {
  const error: unknown = await pending.then(
    () => null,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(PreviewMultipartError);
  expect(error).toMatchObject({ code, message: code });
  expect(String(error)).not.toContain("sensitive-provider-body");
  expect((error as Error).cause).toBeUndefined();
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CF_ACCOUNT_ID", "test-account");
  vi.stubEnv("CF_R2_ACCESS_KEY_ID", "test-access-key");
  vi.stubEnv("CF_R2_SECRET_ACCESS_KEY", "test-secret-key");
  vi.stubEnv("CF_R2_BUCKET", bucket);
  vi.stubEnv("AWS_MAX_ATTEMPTS", "9");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("bounded automatic preview R2 multipart adapter", () => {
  it("creates unique unassigned staging descriptors without bytes, identity metadata or SSE headers", async () => {
    mocks.send.mockResolvedValue({ UploadId: descriptor.uploadId });
    const first = await createPreviewMultipart();
    const second = await createPreviewMultipart();
    const keyPattern =
      /^assets\/automatic-preview-staging\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/preview\.png$/u;
    expect(first.key).toMatch(keyPattern);
    expect(second.key).toMatch(keyPattern);
    expect(first.key).not.toBe(second.key);
    expect(first).toEqual({ key: first.key, uploadId: descriptor.uploadId });
    expect(mocks.send).toHaveBeenCalledTimes(2);
    for (const [command, options] of mocks.send.mock.calls) {
      expect(command).toBeInstanceOf(CreateMultipartUploadCommand);
      expect(command.input).toEqual({
        Bucket: bucket,
        Key: expect.stringMatching(keyPattern),
        ContentType: "image/png",
        CacheControl: "private, no-store",
      });
      expect(command.input.Body).toBeUndefined();
      expect(command.input.Metadata).toBeUndefined();
      expect(command.input.ServerSideEncryption).toBeUndefined();
      expect(options.abortSignal).toBeInstanceOf(AbortSignal);
      expect(options.requestTimeout).toBe(30_000);
    }
    expect(mocks.config).toHaveBeenCalledWith({
      region: "auto",
      endpoint: "https://test-account.r2.cloudflarestorage.com",
      credentials: { accessKeyId: "test-access-key", secretAccessKey: "test-secret-key" },
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      maxAttempts: 1,
    });
    expect(mocks.destroy).toHaveBeenCalledTimes(2);
  });

  it.each(["CF_ACCOUNT_ID", "CF_R2_ACCESS_KEY_ID", "CF_R2_SECRET_ACCESS_KEY", "CF_R2_BUCKET"])(
    "fails without %s before provider I/O",
    async (name) => {
      vi.stubEnv(name, "");
      await expectCode(createPreviewMultipart(), "preview_multipart_unavailable");
      expect(mocks.config).not.toHaveBeenCalled();
      expect(mocks.send).not.toHaveBeenCalled();
    },
  );

  it("does not substitute a differently named account variable", async () => {
    vi.stubEnv("CF_ACCOUNT_ID", "");
    vi.stubEnv("CF_R2_ACCOUNT_ID", "wrong-variable");
    await expectCode(createPreviewMultipart(), "preview_multipart_unavailable");
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("sanitizes client construction failure", async () => {
    mocks.config.mockImplementation(() => {
      throw new Error("sensitive-provider-body");
    });
    await expectCode(createPreviewMultipart(), "preview_multipart_unavailable");
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "id\n", "id\u007f", "id\u00e9", "x".repeat(1025)])(
    "rejects malformed create upload IDs without uploading bytes",
    async (UploadId) => {
      mocks.send.mockResolvedValue({ UploadId });
      await expectCode(createPreviewMultipart(), "preview_multipart_create_failed");
      expect(mocks.send).toHaveBeenCalledTimes(1);
      expect(mocks.send.mock.calls[0]![0]).toBeInstanceOf(CreateMultipartUploadCommand);
    },
  );

  it("does not trust a provider create response selecting another key", async () => {
    mocks.send.mockResolvedValue({
      UploadId: descriptor.uploadId,
      Key: "assets/projects/51/preview.png",
    });
    await expectCode(createPreviewMultipart(), "preview_multipart_create_failed");
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("uploads only part 1 with the exact length, a byte snapshot and Content-MD5", async () => {
    mocks.send.mockResolvedValue({ ETag: etag });
    const bytes = Buffer.from("abc");
    const pending = uploadPreviewPart(descriptor, bytes);
    bytes.fill(0);
    expect(await pending).toBe(etag);
    const [command, options] = mocks.send.mock.calls[0]!;
    expect(command).toBeInstanceOf(UploadPartCommand);
    expect(command.input).toEqual({
      Bucket: bucket,
      Key: descriptor.key,
      UploadId: descriptor.uploadId,
      PartNumber: 1,
      Body: Buffer.from("abc"),
      ContentLength: 3,
      ContentMD5: "kAFQmDzST7DWlj99KOF/cg==",
    });
    expect(options.requestTimeout).toBe(30_000);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("accepts exactly 4 MiB", async () => {
    mocks.send.mockResolvedValue({ ETag: etag });
    await uploadPreviewPart(descriptor, new Uint8Array(4 * 1024 * 1024));
    expect(mocks.send.mock.calls[0]![0].input.ContentLength).toBe(4 * 1024 * 1024);
  });

  it.each([
    new Uint8Array(0),
    new Uint8Array(4 * 1024 * 1024 + 1),
    "not-bytes" as unknown as Uint8Array,
  ])("rejects empty, oversized or non-byte parts before I/O", async (bytes) => {
    await expectCode(uploadPreviewPart(descriptor, bytes), "preview_multipart_invalid_part");
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.config).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "etag\r\n", "\u00e9", "x".repeat(1025)])(
    "rejects missing or unsafe provider ETags",
    async (ETag) => {
      mocks.send.mockResolvedValue({ ETag });
      await expectCode(
        uploadPreviewPart(descriptor, Buffer.from("abc")),
        "preview_multipart_upload_failed",
      );
      expect(mocks.send).toHaveBeenCalledTimes(1);
    },
  );

  it("completes exactly one supplied part and performs no extra requests", async () => {
    mocks.send.mockResolvedValue({});
    await completePreviewMultipart(descriptor, etag);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const command = mocks.send.mock.calls[0]![0];
    expect(command).toBeInstanceOf(CompleteMultipartUploadCommand);
    expect(command.input).toEqual({
      Bucket: bucket,
      Key: descriptor.key,
      UploadId: descriptor.uploadId,
      MultipartUpload: { Parts: [{ PartNumber: 1, ETag: etag }] },
    });
  });

  it.each(["", "etag\n", "\u007f", "x".repeat(1025)])(
    "rejects unsafe completion ETags before I/O",
    async (value) => {
      await expectCode(
        completePreviewMultipart(descriptor, value),
        "preview_multipart_invalid_etag",
      );
      expect(mocks.send).not.toHaveBeenCalled();
    },
  );

  it.each<[string, () => Promise<unknown>, PreviewMultipartErrorCode]>([
    ["create", () => createPreviewMultipart(), "preview_multipart_create_failed"],
    [
      "part",
      () => uploadPreviewPart(descriptor, Buffer.from("abc")),
      "preview_multipart_upload_failed",
    ],
    [
      "complete",
      () => completePreviewMultipart(descriptor, etag),
      "preview_multipart_complete_failed",
    ],
  ])("does not retry or leak provider errors for %s", async (_stage, run, code) => {
    mocks.send.mockRejectedValue(providerError("ServiceUnavailable", 503));
    await expectCode(run(), code);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.config).toHaveBeenCalledWith(expect.objectContaining({ maxAttempts: 1 }));
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });

  it.each<[string, PreviewMultipart]>([
    ["project key", { ...descriptor, key: "assets/projects/51/preview.png" }],
    ["absolute URL", { ...descriptor, key: "https://external.example/preview.png" }],
    [
      "traversal",
      { ...descriptor, key: descriptor.key.replace("/preview.png", "/../preview.png") },
    ],
    ["query", { ...descriptor, key: descriptor.key + "?projectId=51" }],
    ["filename", { ...descriptor, key: descriptor.key.replace("preview.png", "other.png") }],
    ["key newline", { ...descriptor, key: descriptor.key + "\n" }],
    ["non-UUID", { ...descriptor, key: "assets/automatic-preview-staging/project-51/preview.png" }],
    ["non-v4 UUID", { ...descriptor, key: descriptor.key.replace("-4c9a-", "-1c9a-") }],
    ["empty upload ID", { ...descriptor, uploadId: "" }],
    ["control upload ID", { ...descriptor, uploadId: "id\r\n" }],
    ["DEL upload ID", { ...descriptor, uploadId: "id\u007f" }],
    ["non-ASCII upload ID", { ...descriptor, uploadId: "id\u00e9" }],
    ["oversized upload ID", { ...descriptor, uploadId: "x".repeat(1025) }],
  ])(
    "blocks hostile descriptor %s for all resource-addressing operations",
    async (_label, value) => {
      await expectCode(
        uploadPreviewPart(value, Buffer.from("abc")),
        "preview_multipart_invalid_descriptor",
      );
      await expectCode(
        completePreviewMultipart(value, etag),
        "preview_multipart_invalid_descriptor",
      );
      await expectCode(abortPreviewMultipart(value), "preview_multipart_invalid_descriptor");
      expect(mocks.config).not.toHaveBeenCalled();
      expect(mocks.send).not.toHaveBeenCalled();
    },
  );

  it("does not dispatch any already-cancelled capture operation", async () => {
    const controller = new AbortController();
    controller.abort("sensitive-provider-body");
    await expectCode(createPreviewMultipart(controller.signal), "preview_multipart_cancelled");
    await expectCode(
      uploadPreviewPart(descriptor, Buffer.from("abc"), controller.signal),
      "preview_multipart_cancelled",
    );
    await expectCode(
      completePreviewMultipart(descriptor, etag, controller.signal),
      "preview_multipart_cancelled",
    );
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.config).not.toHaveBeenCalled();
  });

  it("composes caller cancellation and bounds a provider that ignores the signal", async () => {
    mocks.send.mockImplementation(() => new Promise(() => undefined));
    const controller = new AbortController();
    const composed = vi.spyOn(AbortSignal, "any");
    const checked = expectCode(
      createPreviewMultipart(controller.signal),
      "preview_multipart_cancelled",
    );
    await Promise.resolve();
    controller.abort("sensitive-provider-body");
    await checked;
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(composed).toHaveBeenCalledWith(expect.arrayContaining([controller.signal]));
    expect(mocks.send.mock.calls[0]![1].abortSignal.aborted).toBe(true);
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });

  it("uses a 30-second deadline even when provider cancellation never settles", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    mocks.send.mockImplementation(() => new Promise(() => undefined));
    const checked = expectCode(createPreviewMultipart(), "preview_multipart_timeout");
    await Promise.resolve();
    deadline.abort("sensitive-provider-body");
    await checked;
    expect(timeout).toHaveBeenCalledExactlyOnceWith(30_000);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });

  it("aborts then verifies an empty non-truncated listing under one fresh deadline", async () => {
    const capture = new AbortController();
    capture.abort();
    await expectCode(createPreviewMultipart(capture.signal), "preview_multipart_cancelled");
    const timeout = vi.spyOn(AbortSignal, "timeout");
    mocks.send.mockResolvedValueOnce({}).mockResolvedValueOnce({ Parts: [], IsTruncated: false });
    await abortPreviewMultipart(descriptor);
    expect(mocks.send).toHaveBeenCalledTimes(2);
    const [abort, abortOptions] = mocks.send.mock.calls[0]!;
    const [list, listOptions] = mocks.send.mock.calls[1]!;
    expect(abort).toBeInstanceOf(AbortMultipartUploadCommand);
    expect(list).toBeInstanceOf(ListPartsCommand);
    expect(abort.input).toEqual({
      Bucket: bucket,
      Key: descriptor.key,
      UploadId: descriptor.uploadId,
    });
    expect(list.input).toEqual({ ...abort.input, MaxParts: 1 });
    expect(abortOptions.abortSignal).not.toBe(capture.signal);
    expect(abortOptions.abortSignal.aborted).toBe(false);
    expect(listOptions.abortSignal).toBe(abortOptions.abortSignal);
    expect(listOptions.requestTimeout).toBe(30_000);
    expect(timeout).toHaveBeenCalledExactlyOnceWith(30_000);
    expect(mocks.config).toHaveBeenCalledWith(expect.objectContaining({ maxAttempts: 1 }));
  });

  it("accepts omitted XML Parts only with explicit non-truncation", async () => {
    mocks.send.mockResolvedValueOnce({}).mockResolvedValueOnce({ IsTruncated: false });
    await expect(abortPreviewMultipart(descriptor)).resolves.toBeUndefined();
  });

  it("accepts the SDK string zero marker on an empty non-truncated list", async () => {
    const parts = {
      Parts: [],
      IsTruncated: false,
      NextPartNumberMarker: "0",
    } satisfies Partial<ListPartsCommandOutput>;
    mocks.send.mockResolvedValueOnce({}).mockResolvedValueOnce(parts);
    await expect(abortPreviewMultipart(descriptor)).resolves.toBeUndefined();
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it.each(["abort", "list"] as const)("accepts exact NoSuchUpload/404 at %s", async (stage) => {
    if (stage === "list") mocks.send.mockResolvedValueOnce({});
    mocks.send.mockRejectedValueOnce(providerError("NoSuchUpload", 404));
    await expect(abortPreviewMultipart(descriptor)).resolves.toBeUndefined();
    expect(mocks.send).toHaveBeenCalledTimes(stage === "abort" ? 1 : 2);
  });

  it.each<[string, number]>([
    ["AccessDenied", 403],
    ["NotFound", 404],
    ["NoSuchBucket", 404],
    ["NoSuchUpload", 403],
    ["NoSuchUpload", 500],
    ["ServiceUnavailable", 503],
  ])("never treats %s/%s as absence at either cleanup step", async (name, status) => {
    mocks.send.mockRejectedValueOnce(providerError(name, status));
    await expectCode(abortPreviewMultipart(descriptor), "preview_multipart_abort_failed");
    expect(mocks.send).toHaveBeenCalledTimes(1);
    mocks.send.mockClear();
    mocks.send.mockResolvedValueOnce({}).mockRejectedValueOnce(providerError(name, status));
    await expectCode(abortPreviewMultipart(descriptor), "preview_multipart_verify_failed");
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it("does not accept NoSuchUpload without its provider HTTP status", async () => {
    mocks.send.mockRejectedValueOnce({ name: "NoSuchUpload", message: "sensitive-provider-body" });
    await expectCode(abortPreviewMultipart(descriptor), "preview_multipart_abort_failed");
  });

  it.each<Record<string, unknown>>([
    { Parts: [{ PartNumber: 1 }], IsTruncated: false },
    { Parts: [], IsTruncated: true },
    { Parts: [] },
    {},
    { Parts: null, IsTruncated: false },
    {
      Parts: [],
      IsTruncated: false,
      NextPartNumberMarker: "1",
    } satisfies Partial<ListPartsCommandOutput>,
    { Parts: [], IsTruncated: false, Key: "assets/projects/51/preview.png" },
    { Parts: [], IsTruncated: false, UploadId: "other-upload" },
    { Parts: [], IsTruncated: false, Bucket: "other-bucket" },
  ])("keeps cleanup unconfirmed for remaining, truncated or malformed parts %j", async (parts) => {
    mocks.send.mockResolvedValueOnce({}).mockResolvedValueOnce(parts);
    await expectCode(abortPreviewMultipart(descriptor), "preview_multipart_absence_unconfirmed");
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it("allows only an explicit later durable cleanup call to retry an abort", async () => {
    mocks.send.mockRejectedValueOnce(providerError("ServiceUnavailable", 503));
    await expectCode(abortPreviewMultipart(descriptor), "preview_multipart_abort_failed");
    expect(mocks.send).toHaveBeenCalledTimes(1);
    mocks.send.mockResolvedValueOnce({}).mockRejectedValueOnce(providerError("NoSuchUpload", 404));
    await expect(abortPreviewMultipart(descriptor)).resolves.toBeUndefined();
    expect(mocks.send).toHaveBeenCalledTimes(3);
  });

  it("bounds the whole abort operation and does not list after its deadline", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    mocks.send.mockImplementation(() => new Promise(() => undefined));
    const checked = expectCode(abortPreviewMultipart(descriptor), "preview_multipart_timeout");
    await Promise.resolve();
    deadline.abort();
    await checked;
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0]![0]).toBeInstanceOf(AbortMultipartUploadCommand);
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });
});
