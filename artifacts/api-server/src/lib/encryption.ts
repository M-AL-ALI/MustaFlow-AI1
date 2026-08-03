// ─────────────────────────────────────────────────────────────────────────────
// Encryption Service — AES-256-GCM
//
// Encrypted format:  v1:<base64-iv>:<base64-ciphertext>:<base64-tag>
//
// Migration: values that do NOT start with "v1:" are treated as legacy
// plaintext (created before encryption was active). On decrypt they are
// returned as-is; on the next update they will be re-encrypted automatically.
//
// Environment:
//   ENCRYPTION_KEY  — 32-byte random key, base64-encoded (44 chars).
//                     Generate once: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
//                     Store in Replit Secrets / env var, never commit.
//
// The interface is stable so callers never import Node crypto directly —
// swapping implementations is a one-file change.
// ─────────────────────────────────────────────────────────────────────────────

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { logger } from "./logger";

// ─── Encryption key health status ────────────────────────────────────────────

/** Observable health of the ENCRYPTION_KEY at startup. */
export type EncryptionKeyStatus = "ok" | "missing" | "invalid";

let _encryptionKeyStatus: EncryptionKeyStatus = "missing";

/** Returns the result of the startup encryption key health check. */
export function getEncryptionKeyStatus(): EncryptionKeyStatus {
  return _encryptionKeyStatus;
}

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const _TAG_BYTES = 16;
const VERSION_PREFIX = "v1:";

export interface EncryptionService {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
  readonly isDevelopmentOnly: boolean;
}

// ─── AES-256-GCM implementation ──────────────────────────────────────────────

class AES256GcmEncryptionService implements EncryptionService {
  readonly isDevelopmentOnly = false;
  private readonly key: Buffer;

  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, "base64");
    if (this.key.byteLength !== 32) {
      throw new Error(
        `ENCRYPTION_KEY must be 32 bytes (got ${this.key.byteLength}). ` +
          "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
      );
    }
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${VERSION_PREFIX}${iv.toString("base64")}:${ct.toString("base64")}:${tag.toString("base64")}`;
  }

  decrypt(stored: string): string {
    // Legacy plaintext — was stored before encryption was active
    if (!stored.startsWith(VERSION_PREFIX)) {
      return stored;
    }
    const parts = stored.slice(VERSION_PREFIX.length).split(":");
    if (parts.length !== 3) {
      throw new Error("Malformed encrypted value — expected v1:<iv>:<ct>:<tag>");
    }
    const [ivB64, ctB64, tagB64] = parts as [string, string, string];
    const iv = Buffer.from(ivB64, "base64");
    const ct = Buffer.from(ctB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ct) + decipher.final("utf8");
  }
}

/** Construct the production cipher directly (used by focused crypto tests). */
export function createEncryptionService(base64Key: string): EncryptionService {
  return new AES256GcmEncryptionService(base64Key);
}

// ─── Dev-only passthrough (never shipped to production) ──────────────────────

class DevOnlyPassthroughEncryption implements EncryptionService {
  readonly isDevelopmentOnly = true;

  encrypt(plaintext: string): string {
    return plaintext;
  }

  decrypt(ciphertext: string): string {
    // If a real key was active before, values start with "v1:". Passthrough
    // just returns the raw string — the caller will see garbled output, which
    // is the correct signal that ENCRYPTION_KEY is missing.
    return ciphertext;
  }
}

// ─── Active service ───────────────────────────────────────────────────────────

function buildEncryptionService(): EncryptionService {
  const rawKey = process.env.ENCRYPTION_KEY;
  if (!rawKey) {
    _encryptionKeyStatus = "missing";
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "ENCRYPTION_KEY environment variable is required in production. " +
          "Generate a 32-byte key and add it to Replit Secrets.",
      );
    }
    logger.warn(
      "ENCRYPTION_KEY not set — falling back to plaintext storage. " +
        "Set ENCRYPTION_KEY before accepting real user secrets.",
    );
    return new DevOnlyPassthroughEncryption();
  }
  try {
    const svc = createEncryptionService(rawKey);
    // Round-trip health probe — confirm the key actually encrypts and decrypts
    // correctly before accepting traffic. The probe string contains no secret
    // material and is never logged.
    const _probe = "enc-startup-probe";
    if (svc.decrypt(svc.encrypt(_probe)) !== _probe) {
      throw new Error("AES-256-GCM round-trip check failed — key may be corrupt");
    }
    _encryptionKeyStatus = "ok";
    logger.info("AES-256-GCM encryption active");
    return svc;
  } catch (err) {
    _encryptionKeyStatus = "invalid";
    if (process.env.NODE_ENV === "production") throw err;
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "ENCRYPTION_KEY invalid — falling back to plaintext. Fix before deploying.",
    );
    return new DevOnlyPassthroughEncryption();
  }
}

export const encryptionService: EncryptionService = buildEncryptionService();

/** Mask a plaintext value for safe display: `••••••••XXXX` (last 4 chars). */
export function maskValue(value: string): string {
  if (value.length <= 4) return "•".repeat(8);
  return `${"•".repeat(8)}${value.slice(-4)}`;
}
