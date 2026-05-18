// ─────────────────────────────────────────────────────────────────────────────
// Encryption Service
//
// This module provides encrypt/decrypt for secret values stored in the database.
//
// CURRENT IMPLEMENTATION: Development-only passthrough (plaintext).
//   Values are stored as-is. This is marked DEV-ONLY and must be replaced
//   with real encryption before accepting real user secrets.
//
// TODO (before production):
//   Replace passthrough with AES-256-GCM encryption using a KMS-managed key.
//   Recommended approach:
//     1. Store ENCRYPTION_KEY as a 32-byte base64 env var (use Replit Secrets).
//     2. Generate a random 12-byte IV per encrypt call.
//     3. Encode as `<base64-iv>.<base64-ciphertext>.<base64-tag>`.
//     4. Migrate existing rows with a one-time encrypted-column backfill script.
//
// The interface is defined here so callers (secrets route) never import Node
// crypto directly — swapping the implementation is a one-file change.
// ─────────────────────────────────────────────────────────────────────────────

export interface EncryptionService {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
  isDevelopmentOnly: boolean;
}

class DevOnlyPassthroughEncryption implements EncryptionService {
  readonly isDevelopmentOnly = true;

  encrypt(plaintext: string): string {
    // DEV ONLY: no encryption. Replace before production.
    return plaintext;
  }

  decrypt(ciphertext: string): string {
    // DEV ONLY: no decryption. Replace before production.
    return ciphertext;
  }
}

// SWAP POINT: replace with AES256GcmEncryptionService before production launch.
export const encryptionService: EncryptionService = new DevOnlyPassthroughEncryption();

/** Mask a plaintext value for safe display: `••••••••XXXX` (last 4 chars). */
export function maskValue(value: string): string {
  if (value.length <= 4) return "•".repeat(8);
  return `${"•".repeat(8)}${value.slice(-4)}`;
}
