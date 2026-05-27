#!/usr/bin/env npx tsx
/**
 * ENCRYPTION KEY ROTATION SCRIPT
 *
 * Re-encrypts all AES-256-GCM encrypted columns from OLD_ENCRYPTION_KEY to
 * NEW_ENCRYPTION_KEY. Covers:
 *   - project_secrets.value_encrypted
 *   - projects.preview_db_url
 *   - project_github_connections.encrypted_token
 *
 * Run with --dry-run to print row counts without writing any changes.
 *
 * See docs/runbook-key-rotation.md for the full operational procedure.
 */

import crypto from "crypto";
import { pool } from "@workspace/db";

const BATCH_SIZE = 100;
const isDryRun = process.argv.includes("--dry-run");

function encrypt(key: Buffer, plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${ct.toString("base64")}:${tag.toString("base64")}`;
}

function decrypt(key: Buffer, value: string): string {
  if (!value.startsWith("v1:")) return value; // legacy plaintext — pass through
  const parts = value.slice(3).split(":");
  if (parts.length !== 3) throw new Error("Malformed v1 encrypted value");
  const iv = Buffer.from(parts[0]!, "base64");
  const ct = Buffer.from(parts[1]!, "base64");
  const tag = Buffer.from(parts[2]!, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ct).toString("utf8") + decipher.final("utf8");
}

interface RotationResult {
  rotated: number;
  skipped: number;
  errors: number;
}

/**
 * Rotate a single encrypted column in batches of BATCH_SIZE.
 * Rows that fail decryption are logged and skipped (not aborted).
 */
async function rotateColumn(opts: {
  table: string;
  idCol: string;
  encryptedCol: string;
  oldKey: Buffer;
  newKey: Buffer;
  dryRun: boolean;
}): Promise<RotationResult> {
  const { table, idCol, encryptedCol, oldKey, newKey, dryRun } = opts;

  // Count rows with a non-null encrypted value
  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${encryptedCol} IS NOT NULL`,
  );
  const totalRows = parseInt(countResult.rows[0]!.count, 10);

  console.log(`\n[${table}.${encryptedCol}] ${totalRows} row(s) to process.`);

  if (dryRun) {
    return { rotated: 0, skipped: 0, errors: 0 };
  }

  let rotated = 0;
  let skipped = 0;
  let errors = 0;
  let offset = 0;

  while (offset < totalRows) {
    const { rows } = await pool.query<Record<string, string>>(
      `SELECT ${idCol}, ${encryptedCol} FROM ${table} WHERE ${encryptedCol} IS NOT NULL ORDER BY ${idCol} LIMIT $1 OFFSET $2`,
      [BATCH_SIZE, offset],
    );

    if (rows.length === 0) break;

    for (const row of rows) {
      const id = row[idCol]!;
      const encryptedValue = row[encryptedCol]!;

      try {
        const plaintext = decrypt(oldKey, encryptedValue);
        const reencrypted = encrypt(newKey, plaintext);
        await pool.query(`UPDATE ${table} SET ${encryptedCol} = $1 WHERE ${idCol} = $2`, [
          reencrypted,
          id,
        ]);
        rotated++;
      } catch (err) {
        console.warn(
          `  WARN: skipping ${table} ${idCol}=${id} — ${err instanceof Error ? err.message : String(err)}`,
        );
        skipped++;
        errors++;
      }
    }

    offset += rows.length;
    console.log(`  [${table}] Processed ${Math.min(offset, totalRows)} / ${totalRows}`);
  }

  return { rotated, skipped, errors };
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

  if (isDryRun) {
    console.log("DRY RUN — no rows will be updated.\n");
  }

  const startMs = Date.now();

  const tables = [
    { table: "project_secrets", idCol: "id", encryptedCol: "value_encrypted" },
    { table: "projects", idCol: "id", encryptedCol: "preview_db_url" },
    {
      table: "project_github_connections",
      idCol: "id",
      encryptedCol: "encrypted_token",
    },
  ];

  let totalRotated = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const spec of tables) {
    const result = await rotateColumn({ ...spec, oldKey, newKey, dryRun: isDryRun });
    totalRotated += result.rotated;
    totalSkipped += result.skipped;
    totalErrors += result.errors;
  }

  const durationMs = Date.now() - startMs;

  console.log("\n─────────────────────────────────────────────────");
  if (isDryRun) {
    console.log("DRY RUN complete — no rows were written.");
    // Print per-table row counts for informational purposes
    for (const spec of tables) {
      const { rows } = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM ${spec.table} WHERE ${spec.encryptedCol} IS NOT NULL`,
      );
      console.log(
        `  ${spec.table}.${spec.encryptedCol}: ${rows[0]!.count} row(s) would be rotated`,
      );
    }
  } else {
    console.log("Rotation summary:", {
      rotated: totalRotated,
      skipped: totalSkipped,
      errors: totalErrors,
      durationMs,
    });
    if (totalErrors > 0) {
      console.warn(`\n${totalErrors} row(s) could not be rotated and still carry the old key.`);
      console.warn(
        "Review the warnings above. These rows may be legacy plaintext or already rotated.",
      );
    } else {
      console.log("\nAll rows rotated successfully.");
    }
  }

  await pool.end();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
