/**
 * Migration: Full Phase 2B Orax Desktop schema
 *
 * Tables created:
 *   orax_hosts            — registered desktop installations
 *   orax_pairing_codes    — short-lived QR/manual pairing codes
 *   orax_paired_devices   — mobile devices paired to a host (UNIQUE host+device)
 *   orax_projects         — local project folders registered on a host
 *   orax_threads          — task/conversation threads
 *   orax_thread_messages  — all messages within a thread
 *   orax_pending_approvals — approval requests from desktop
 *   orax_usage_events     — append-only usage event log
 *   orax_audit_log        — security audit log (denormalized, no FK)
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

    // ── orax_hosts ────────────────────────────────────────────────────────────
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
    // UNIQUE(host_id, mobile_device_id) — re-pairing upserts via ON CONFLICT.
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
      CREATE UNIQUE INDEX IF NOT EXISTS orax_paired_devices_host_mobile_uidx
        ON orax_paired_devices (host_id, mobile_device_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_paired_devices_user_id_idx
        ON orax_paired_devices (user_id)
    `);

    // ── orax_projects ─────────────────────────────────────────────────────────
    // Local project folders registered on a desktop host (legacy Phase 2B shape).
    // Phase 2G reshaped orax_projects into a cloud-first workspace WITHOUT
    // host_id (see lib/db/src/schema/orax-desktop.ts); on a fresh DB where
    // `drizzle-kit push` ran first, the table already exists in that shape,
    // so the legacy host_id index must be skipped.
    await client.query(`
      CREATE TABLE IF NOT EXISTS orax_projects (
        id                       TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        host_id                  TEXT NOT NULL REFERENCES orax_hosts(id),
        user_id                  TEXT NOT NULL,
        local_path               TEXT NOT NULL,
        display_name             TEXT NOT NULL,
        git_remote_url           TEXT,
        current_branch           TEXT,
        last_opened_at           TIMESTAMPTZ,
        permission_mode_override TEXT,
        setup_scripts            JSONB,
        status                   TEXT NOT NULL DEFAULT 'active',
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const { rowCount: hasLegacyHostId } = await client.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'orax_projects' AND column_name = 'host_id'
    `);
    if (hasLegacyHostId) {
      await client.query(`
        CREATE INDEX IF NOT EXISTS orax_projects_host_id_idx
          ON orax_projects (host_id)
      `);
    }
    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_projects_user_id_idx
        ON orax_projects (user_id)
    `);

    // ── orax_threads ──────────────────────────────────────────────────────────
    // Task/conversation threads. Cloud-only threads have host_id = NULL.
    await client.query(`
      CREATE TABLE IF NOT EXISTS orax_threads (
        id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_id    TEXT NOT NULL,
        host_id    TEXT,
        project_id TEXT REFERENCES orax_projects(id),
        title      TEXT,
        status     TEXT NOT NULL DEFAULT 'idle',
        last_event JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_threads_user_id_idx
        ON orax_threads (user_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_threads_host_id_idx
        ON orax_threads (host_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_threads_project_id_idx
        ON orax_threads (project_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_threads_status_idx
        ON orax_threads (user_id, status)
    `);

    // ── orax_thread_messages ──────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS orax_thread_messages (
        id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        thread_id  TEXT NOT NULL REFERENCES orax_threads(id),
        role       TEXT NOT NULL,
        content    TEXT NOT NULL,
        event_type TEXT,
        payload    JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_thread_messages_thread_id_idx
        ON orax_thread_messages (thread_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_thread_messages_created_at_idx
        ON orax_thread_messages (thread_id, created_at)
    `);

    // ── orax_pending_approvals ────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS orax_pending_approvals (
        id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        thread_id   TEXT NOT NULL REFERENCES orax_threads(id),
        host_id     TEXT NOT NULL,
        description TEXT NOT NULL,
        command     TEXT,
        file_path   TEXT,
        diff        TEXT,
        status      TEXT NOT NULL DEFAULT 'pending',
        resolved_at TIMESTAMPTZ,
        resolved_by TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_pending_approvals_thread_id_idx
        ON orax_pending_approvals (thread_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_pending_approvals_host_id_idx
        ON orax_pending_approvals (host_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_pending_approvals_status_idx
        ON orax_pending_approvals (host_id, status)
    `);

    // ── orax_usage_events ─────────────────────────────────────────────────────
    // Append-only usage event log. Written by the cloud on desktop confirmation.
    await client.query(`
      CREATE TABLE IF NOT EXISTS orax_usage_events (
        id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_id       TEXT NOT NULL,
        host_id       TEXT NOT NULL REFERENCES orax_hosts(id),
        project_id    TEXT REFERENCES orax_projects(id),
        thread_id     TEXT REFERENCES orax_threads(id),
        action_type   TEXT NOT NULL,
        model_used    TEXT,
        input_tokens  INTEGER,
        output_tokens INTEGER,
        compute_ms    INTEGER,
        status        TEXT NOT NULL DEFAULT 'success',
        metadata      JSONB NOT NULL DEFAULT '{}',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_usage_events_user_id_idx
        ON orax_usage_events (user_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_usage_events_host_id_idx
        ON orax_usage_events (host_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_usage_events_thread_id_idx
        ON orax_usage_events (thread_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_usage_events_created_at_idx
        ON orax_usage_events (user_id, created_at)
    `);

    // ── orax_audit_log ────────────────────────────────────────────────────────
    // Security audit log. Denormalized (no FK) so it survives host/thread
    // deletion. Records every sensitive action regardless of permission mode.
    await client.query(`
      CREATE TABLE IF NOT EXISTS orax_audit_log (
        id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_id    TEXT NOT NULL,
        host_id    TEXT NOT NULL,
        project_id TEXT,
        thread_id  TEXT,
        action     TEXT NOT NULL,
        command    TEXT,
        file_path  TEXT,
        outcome    TEXT NOT NULL,
        error_msg  TEXT,
        metadata   JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_audit_log_user_id_idx
        ON orax_audit_log (user_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_audit_log_host_id_idx
        ON orax_audit_log (host_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_audit_log_thread_id_idx
        ON orax_audit_log (thread_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_audit_log_created_at_idx
        ON orax_audit_log (user_id, created_at)
    `);

    // ── orax_desktop_auth_challenges / orax_desktop_sessions ────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS orax_desktop_auth_challenges (
        id                       TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_id                  TEXT,
        status                   TEXT NOT NULL DEFAULT 'pending',
        user_code                TEXT NOT NULL,
        poll_token_hash          TEXT NOT NULL,
        session_id               TEXT,
        session_token_ciphertext TEXT,
        install_id               TEXT,
        device_name              TEXT,
        platform                 TEXT,
        app_version              TEXT,
        expires_at               TIMESTAMPTZ NOT NULL,
        approved_at              TIMESTAMPTZ,
        redeemed_at              TIMESTAMPTZ,
        denied_at                TIMESTAMPTZ,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS orax_desktop_auth_challenges_user_code_uidx
        ON orax_desktop_auth_challenges (user_code)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_desktop_auth_challenges_user_id_idx
        ON orax_desktop_auth_challenges (user_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_desktop_auth_challenges_status_idx
        ON orax_desktop_auth_challenges (status)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_desktop_auth_challenges_expires_at_idx
        ON orax_desktop_auth_challenges (expires_at)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS orax_desktop_sessions (
        id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_id      TEXT NOT NULL,
        token_hash   TEXT NOT NULL UNIQUE,
        challenge_id TEXT,
        install_id   TEXT,
        device_name  TEXT,
        platform     TEXT,
        app_version  TEXT,
        metadata     JSONB NOT NULL DEFAULT '{}',
        expires_at   TIMESTAMPTZ NOT NULL,
        last_used_at TIMESTAMPTZ,
        revoked_at   TIMESTAMPTZ,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_desktop_sessions_user_id_idx
        ON orax_desktop_sessions (user_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_desktop_sessions_token_hash_idx
        ON orax_desktop_sessions (token_hash)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_desktop_sessions_expires_at_idx
        ON orax_desktop_sessions (expires_at)
    `);

    await client.query("COMMIT");
    console.log(
      "Migration complete: all 9 Phase 2B Orax Desktop tables created\n" +
        "  orax_hosts, orax_pairing_codes, orax_paired_devices,\n" +
        "  orax_projects, orax_threads, orax_thread_messages,\n" +
        "  orax_pending_approvals, orax_usage_events, orax_audit_log",
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
