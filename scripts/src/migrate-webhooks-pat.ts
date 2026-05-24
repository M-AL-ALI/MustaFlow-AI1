/**
 * Migration: webhooks, PAT, domain-serve-events tables (Task #557)
 * Safe to re-run — uses IF NOT EXISTS.
 */

import { pool } from "@workspace/db";

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // project_webhooks
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_webhooks (
        id             SERIAL PRIMARY KEY,
        project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        url            TEXT NOT NULL,
        secret         TEXT NOT NULL,
        events         JSONB NOT NULL DEFAULT '[]',
        active         BOOLEAN NOT NULL DEFAULT true,
        description    TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_project_webhooks_project ON project_webhooks(project_id)`,
    );

    // webhook_deliveries
    await client.query(`
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id             SERIAL PRIMARY KEY,
        webhook_id     INTEGER NOT NULL REFERENCES project_webhooks(id) ON DELETE CASCADE,
        project_id     INTEGER NOT NULL,
        event          TEXT NOT NULL,
        payload        JSONB NOT NULL,
        status         TEXT NOT NULL DEFAULT 'pending',
        status_code    INTEGER,
        response_body  TEXT,
        attempt        INTEGER NOT NULL DEFAULT 1,
        duration_ms    INTEGER,
        error          TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_project ON webhook_deliveries(project_id)`,
    );

    // personal_access_tokens
    await client.query(`
      CREATE TABLE IF NOT EXISTS personal_access_tokens (
        id             SERIAL PRIMARY KEY,
        user_id        TEXT NOT NULL,
        name           TEXT NOT NULL,
        token_hash     TEXT NOT NULL UNIQUE,
        token_preview  TEXT NOT NULL,
        project_id     INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        scopes         JSONB NOT NULL DEFAULT '["domains:read","domains:write"]',
        active         BOOLEAN NOT NULL DEFAULT true,
        last_used_at   TIMESTAMPTZ,
        expires_at     TIMESTAMPTZ,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_pat_user ON personal_access_tokens(user_id)`,
    );

    // domain_serve_events
    await client.query(`
      CREATE TABLE IF NOT EXISTS domain_serve_events (
        id          SERIAL PRIMARY KEY,
        project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        domain_id   INTEGER,
        snapshot_id INTEGER,
        hostname    TEXT,
        ts          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_domain_serve_events_domain ON domain_serve_events(domain_id, ts DESC)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_domain_serve_events_project ON domain_serve_events(project_id, ts DESC)`,
    );

    await client.query("COMMIT");
    console.log("Migration complete: webhooks, PAT, domain-serve-events tables created.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

void main();
