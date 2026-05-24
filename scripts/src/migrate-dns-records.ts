/**
 * Task #598 — Add dns_records table so DNS records can be drafted/edited
 * without an active Cloudflare connection.
 *
 * Run: pnpm --filter @workspace/scripts run migrate-dns-records
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS dns_records (
        id serial PRIMARY KEY,
        project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        domain_id integer NOT NULL REFERENCES project_domains(id) ON DELETE CASCADE,
        hostname text NOT NULL,
        name text NOT NULL,
        type text NOT NULL,
        content text,
        priority integer,
        ttl integer NOT NULL DEFAULT 1,
        proxied boolean NOT NULL DEFAULT false,
        data text,
        source text NOT NULL DEFAULT 'local',
        cf_record_id text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await client.query(
      `CREATE INDEX IF NOT EXISTS dns_records_domain_idx ON dns_records(domain_id)`,
    );

    await client.query("COMMIT");
    console.log("dns_records migration complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
