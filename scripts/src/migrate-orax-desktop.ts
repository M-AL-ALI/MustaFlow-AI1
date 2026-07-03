/**
 * Migration: orax_hosts + orax_pairing_codes + orax_paired_devices (Phase 2B)
 *
 * Creates the backend schema for Orax Desktop host registration,
 * short-lived pairing codes, and paired mobile devices.
 *
 * Run with:
 *   pnpm --filter @workspace/scripts run migrate-orax-desktop
 *
 * Safe to re-run: all statements use IF NOT EXISTS.
 */

import { pool } from "@workspace/db";

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── orax_hosts ─────────────────────────────────────────────────────────────
    // One row per physical machine registration. installId is stable across
    // app updates (written to OS credential store on first install).
    await client.query(`
      CREATE TABLE IF NOT EXISTS orax_hosts (
        id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_id         TEXT NOT NULL,
        device_name     TEXT NOT NULL,
        platform        TEXT NOT NULL DEFAULT 'windows',
        os_version      TEXT,
        app_version     TEXT NOT NULL DEFAULT '0.0.0',
        install_id      TEXT NOT NULL,
        public_key      TEXT NOT NULL DEFAULT '',
        status          TEXT NOT NULL DEFAULT 'offline',
        last_seen_at    TIMESTAMPTZ,
        paired_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revoked_at      TIMESTAMPTZ,
        capabilities    JSONB NOT NULL DEFAULT '{}',
        permission_mode TEXT NOT NULL DEFAULT 'ask_risky',
        trusted_project_ids JSONB NOT NULL DEFAULT '[]',
        metadata        JSONB NOT NULL DEFAULT '{}',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS orax_hosts_install_id_uidx
        ON orax_hosts (install_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_hosts_user_id_idx
        ON orax_hosts (user_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_hosts_status_idx
        ON orax_hosts (user_id, status)
    `);

    // ── orax_pairing_codes ────────────────────────────────────────────────────
    // Short-lived (10 min), single-use. Account-bound: redeemer's userId must
    // match the code's userId. A new code invalidates all previous unredeemed
    // codes for the same host (enforced at the API layer, not DB).
    await client.query(`
      CREATE TABLE IF NOT EXISTS orax_pairing_codes (
        id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        host_id     TEXT NOT NULL REFERENCES orax_hosts(id),
        user_id     TEXT NOT NULL,
        code        TEXT NOT NULL,
        qr_payload  TEXT NOT NULL,
        expires_at  TIMESTAMPTZ NOT NULL,
        redeemed_at TIMESTAMPTZ,
        redeemed_by TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS orax_pairing_codes_code_uidx
        ON orax_pairing_codes (code)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_pairing_codes_host_id_idx
        ON orax_pairing_codes (host_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_pairing_codes_user_id_idx
        ON orax_pairing_codes (user_id)
    `);

    // ── orax_paired_devices ───────────────────────────────────────────────────
    // One row per (host, mobile device) pair. A phone can appear in multiple
    // rows if paired to multiple desktops; a desktop can have multiple phones.
    await client.query(`
      CREATE TABLE IF NOT EXISTS orax_paired_devices (
        id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        host_id          TEXT NOT NULL REFERENCES orax_hosts(id),
        user_id          TEXT NOT NULL,
        mobile_device_id TEXT NOT NULL,
        display_name     TEXT,
        platform         TEXT,
        paired_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at     TIMESTAMPTZ,
        revoked_at       TIMESTAMPTZ
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_paired_devices_host_id_idx
        ON orax_paired_devices (host_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_paired_devices_user_id_idx
        ON orax_paired_devices (user_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_paired_devices_mobile_idx
        ON orax_paired_devices (mobile_device_id)
    `);

    await client.query("COMMIT");
    console.log(
      "Migration complete: orax_hosts, orax_pairing_codes, orax_paired_devices created",
    );
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
  }
}

await migrate();
