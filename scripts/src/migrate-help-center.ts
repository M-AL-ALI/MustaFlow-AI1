/**
 * Task #1312 — Help Center + Ora Support Mode.
 *
 * Creates `help_articles` and `support_tickets`, adds `surface` to
 * `ora_conversations` (default 'normal') and backfills existing rows to
 * 'normal', then seeds an initial set of help articles / FAQs.
 *
 * Idempotent — uses IF NOT EXISTS / ON CONFLICT DO NOTHING so it is safe to
 * re-run.
 *
 * Run: pnpm --filter @workspace/scripts run migrate-help-center
 */
import { pool, HELP_ARTICLE_SEED } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS help_articles (
        id serial PRIMARY KEY,
        slug text NOT NULL UNIQUE,
        category text NOT NULL DEFAULT 'getting-started',
        title text NOT NULL,
        body text NOT NULL,
        tags jsonb NOT NULL DEFAULT '[]'::jsonb,
        is_faq boolean NOT NULL DEFAULT false,
        sort_order integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS help_articles_category_idx ON help_articles(category, sort_order)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS help_articles_is_faq_idx ON help_articles(is_faq)`,
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS support_tickets (
        id serial PRIMARY KEY,
        user_id text NOT NULL,
        user_email text,
        plan text NOT NULL DEFAULT 'free',
        category text NOT NULL DEFAULT 'other',
        status text NOT NULL DEFAULT 'open',
        subject text NOT NULL,
        transcript jsonb NOT NULL DEFAULT '[]'::jsonb,
        project_id integer,
        attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
        device_info jsonb,
        support_email_used text,
        email_status text NOT NULL DEFAULT 'skipped',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS support_tickets_user_id_idx ON support_tickets(user_id, created_at)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS support_tickets_status_idx ON support_tickets(status, created_at)`,
    );

    // surface column on ora_conversations + backfill existing rows to 'normal'.
    await client.query(
      `ALTER TABLE ora_conversations ADD COLUMN IF NOT EXISTS surface text NOT NULL DEFAULT 'normal'`,
    );
    await client.query(`UPDATE ora_conversations SET surface = 'normal' WHERE surface IS NULL`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS ora_conversations_surface_idx ON ora_conversations(user_id, surface)`,
    );

    // Seed initial help articles / FAQs (idempotent on slug).
    for (const a of HELP_ARTICLE_SEED) {
      await client.query(
        `INSERT INTO help_articles (slug, category, title, body, tags, is_faq, sort_order)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
         ON CONFLICT (slug) DO NOTHING`,
        [a.slug, a.category, a.title, a.body, JSON.stringify(a.tags), a.isFaq, a.sortOrder],
      );
    }

    await client.query("COMMIT");
    console.log(
      `help-center migration complete (seeded ${HELP_ARTICLE_SEED.length} articles, idempotent).`,
    );
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("migrate-help-center failed:", err);
  process.exit(1);
});
