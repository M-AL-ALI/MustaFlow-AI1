/**
 * One-time migration: create purchased_domains table for Task #559
 * (in-product domain purchase + renewals + transfers via Namecheap).
 *
 * Run: pnpm --filter @workspace/scripts run migrate-purchased-domains
 *
 * Idempotent — safe to run multiple times.
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS purchased_domains (
        id                            serial PRIMARY KEY,
        user_id                       text NOT NULL,
        hostname                      text NOT NULL UNIQUE,
        registrar                     text NOT NULL DEFAULT 'namecheap',
        registered_at                 timestamptz,
        expires_at                    timestamptz,
        auto_renew                    boolean NOT NULL DEFAULT true,
        whois_privacy                 boolean NOT NULL DEFAULT true,
        status                        text NOT NULL DEFAULT 'pending',
        namecheap_order_id            text,
        stripe_payment_intent_id      text,
        project_id                    integer,
        renewal_stripe_payment_intent_id text,
        last_renewal_at               timestamptz,
        renewal_failed_at             timestamptz,
        renewal_failure_reason        text,
        transfer_auth_code            text,
        whois_first_name              text,
        whois_last_name               text,
        whois_email                   text,
        whois_phone                   text,
        whois_address                 text,
        whois_city                    text,
        whois_state_province          text,
        whois_postal_code             text,
        whois_country                 text,
        stripe_customer_id            text,
        price_paid_usd                text,
        renewal_price_usd             text,
        created_at                    timestamptz NOT NULL DEFAULT now(),
        updated_at                    timestamptz NOT NULL DEFAULT now()
      )
    `);

    // Idempotent column additions for iterative schema changes
    await client.query(`
      ALTER TABLE purchased_domains
        ADD COLUMN IF NOT EXISTS stripe_customer_id text
    `);

    await client.query(
      `CREATE INDEX IF NOT EXISTS purchased_domains_user_idx ON purchased_domains(user_id)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS purchased_domains_project_idx ON purchased_domains(project_id)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS purchased_domains_expires_idx ON purchased_domains(expires_at)`,
    );

    await client.query("COMMIT");
    console.log("purchased_domains migration complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
