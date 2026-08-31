import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

type R2Config = { client: S3Client; bucket: string };

function config(): R2Config | null {
  const accountId = process.env.CF_ACCOUNT_ID;
  const accessKeyId = process.env.CF_R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.CF_R2_SECRET_ACCESS_KEY;
  const bucket = process.env.CF_R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return {
    client: new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    }),
    bucket,
  };
}

export function assetR2Configured(): boolean {
  return config() !== null;
}

function requireConfig(): R2Config {
  const value = config();
  if (!value) throw new Error("asset_storage_unavailable");
  return value;
}

export async function putAssetStream(input: {
  key: string;
  body: Readable;
  contentLength: number;
  contentType: string;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const { client, bucket } = requireConfig();
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: input.key,
      Body: input.body,
      ContentLength: input.contentLength,
      ContentType: input.contentType,
      CacheControl: "private, no-store",
      ServerSideEncryption: "AES256",
    }),
    { abortSignal: input.abortSignal },
  );
}

export async function putAssetBuffer(input: {
  key: string;
  body: Buffer;
  contentType: string;
  abortSignal?: AbortSignal;
}): Promise<void> {
  await putAssetStream({
    key: input.key,
    body: Readable.from(input.body),
    contentLength: input.body.length,
    contentType: input.contentType,
    abortSignal: input.abortSignal,
  });
}

export async function openAsset(key: string): Promise<{
  body: Readable;
  sizeBytes: number;
  contentType: string;
} | null> {
  const { client, bucket } = requireConfig();
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!response.Body) return null;
    const web = response.Body.transformToWebStream();
    return {
      body: Readable.fromWeb(web as ReadableStream<Uint8Array>),
      sizeBytes: Number(response.ContentLength ?? 0),
      contentType: response.ContentType ?? "application/octet-stream",
    };
  } catch (error) {
    if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw error;
  }
}

export async function readAssetBuffer(key: string, maxBytes: number): Promise<Buffer | null> {
  const opened = await openAsset(key);
  if (!opened) return null;
  if (opened.sizeBytes > maxBytes) return null;
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of opened.body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    received += buffer.length;
    if (received > maxBytes) throw new Error("asset_read_limit_exceeded");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, received);
}

export async function deleteAssetObject(key: string): Promise<void> {
  const { client, bucket } = requireConfig();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/** Read provider metadata without downloading or exposing object bytes. */
export async function headAssetObject(key: string): Promise<{ sizeBytes: number } | null> {
  const { client, bucket } = requireConfig();
  try {
    const response = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const sizeBytes = Number(response.ContentLength ?? 0);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      throw new Error("asset_storage_size_invalid");
    }
    return { sizeBytes };
  } catch (error) {
    if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw error;
  }
}
