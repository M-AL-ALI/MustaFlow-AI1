#!/usr/bin/env npx tsx
/**
 * ENCRYPTION KEY ROTATION SCRIPT — PLACEHOLDER
 *
 * This script re-encrypts all project secrets from the old ENCRYPTION_KEY
 * to a new one. Until this script is run, all secrets encrypted with the
 * old key will be unreadable.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * OPERATOR INSTRUCTIONS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * BEFORE ROTATING:
 *   1. Back up ENCRYPTION_KEY securely (password manager, cloud secrets vault).
 *   2. Back up the database: pg_dump $DATABASE_URL > backup_$(date +%s).sql
 *   3. Schedule a maintenance window — secrets will be inaccessible briefly.
 *
 * ROTATION PROCEDURE:
 *   1. Set OLD_ENCRYPTION_KEY to the current value.
 *   2. Generate a new 32-byte base64 key:
 *        node -e "require('crypto').randomBytes(32).toString('base64')"  | pbcopy
 *   3. Set NEW_ENCRYPTION_KEY to the new value.
 *   4. Run this script in a TEST environment first.
 *   5. Verify secrets decrypt correctly in the app.
 *   6. Set ENCRYPTION_KEY to the new value in Replit Secrets.
 *   7. Remove OLD_ENCRYPTION_KEY and NEW_ENCRYPTION_KEY from env.
 *
 * IF ENCRYPTION_KEY IS LOST:
 *   - Existing secrets CANNOT be decrypted. The AES-256-GCM tag will not verify.
 *   - Users must re-enter all secrets manually.
 *   - Set ENCRYPTION_KEY to a new value, then ask users to re-add their secrets.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import crypto from "crypto";
import { pool } from "@workspace/db";

function encrypt(key: Buffer, plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${ct.toString("base64")}:${tag.toString("base64")}`;
}

function decrypt(key: Buffer, value: string): string {
  if (!value.startsWith("v1:")) return value; // legacy plaintext
  const parts = value.slice(3).split(":");
  if (parts.length !== 3) throw new Error("Malformed v1 encrypted value");
  const iv = Buffer.from(parts[0]!, "base64");
  const ct = Buffer.from(parts[1]!, "base64");
  const tag = Buffer.from(parts[2]!, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ct).toString("utf8") + decipher.final("utf8");
}

async function main() {
  const oldKeyB64 = process.env.OLD_ENCRYPTION_KEY;
  const newKeyB64 = process.env.NEW_ENCRYPTION_KEY;
  const dbUrl = process.env.DATABASE_URL;

  if (!oldKeyB64 || !newKeyB64 || !dbUrl) {
    console.error("Required env vars: OLD_ENCRYPTION_KEY, NEW_ENCRYPTION_KEY, DATABASE_URL");
    process.exit(1);
  }

  const oldKey = Buffer.from(oldKeyB64, "base64");
  const newKey = Buffer.from(newKeyB64, "base64");

  if (oldKey.byteLength !== 32 || newKey.byteLength !== 32) {
    console.error("Both keys must be 32-byte base64 strings (44 chars).");
    process.exit(1);
  }

  const { rows } = await pool.query<{ id: number; value_encrypted: string }>(
    "SELECT id, value_encrypted FROM project_secrets ORDER BY id"
  );

  console.log(`Found ${rows.length} secrets to rotate.`);

  let rotated = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      const plaintext = decrypt(oldKey, row.value_encrypted);
      const reencrypted = encrypt(newKey, plaintext);
      await pool.query("UPDATE project_secrets SET value_encrypted = $1 WHERE id = $2", [
        reencrypted,
        row.id,
      ]);
      rotated++;
    } catch (err) {
      console.error(`  ERROR on secret id ${row.id}:`, err instanceof Error ? err.message : err);
      errors++;
      skipped++;
    }
  }

  console.log(`Rotation complete. Rotated: ${rotated}, Skipped/Errors: ${skipped}`);
  if (errors > 0) {
    console.warn("Some secrets could not be rotated. They may still be encrypted with the old key.");
  }
  await pool.end();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
