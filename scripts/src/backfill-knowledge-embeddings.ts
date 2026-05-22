/**
 * backfill-knowledge-embeddings.ts
 *
 * Populate AI embeddings for Knowledge Vault entries that don't yet have one.
 * Entries without an embedding fall back to TF-IDF in loadKnowledgeContext, so
 * this script is safe to run partially / re-run.
 *
 * Calls the OpenAI embeddings API (text-embedding-3-small) for each row. Skips
 * any row whose embedding update fails so a single bad row never aborts the run.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run backfill-knowledge-embeddings
 *
 * Required env:
 *   - DATABASE_URL
 *   - AI_INTEGRATIONS_OPENAI_BASE_URL
 *   - AI_INTEGRATIONS_OPENAI_API_KEY
 */

import { pool } from "@workspace/db";
import OpenAI from "openai";

const EMBEDDING_MODEL = "text-embedding-3-small";
const MAX_INPUT_CHARS = 8000;
const BATCH_SIZE = 25;

interface Row {
  id: number;
  title: string;
  content: string;
  tags: string | null;
}

function buildInput(r: Row): string {
  const text = [r.title, r.content, r.tags ?? ""].filter(Boolean).join("\n");
  return text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;
}

async function run(): Promise<void> {
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (!baseURL || !apiKey) {
    throw new Error(
      "Missing AI_INTEGRATIONS_OPENAI_BASE_URL or AI_INTEGRATIONS_OPENAI_API_KEY env vars.",
    );
  }
  const openai = new OpenAI({ baseURL, apiKey });

  const client = await pool.connect();
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  try {
    console.log("Knowledge Vault embedding backfill: scanning entries...");
    const { rows: countRows } = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM knowledge_entries WHERE embedding IS NULL`,
    );
    const total = parseInt(countRows[0]?.count ?? "0", 10);
    console.log(`  Found ${total} entries without an embedding.`);
    if (total === 0) {
      console.log("  Nothing to do. Done.");
      return;
    }

    // Stream in batches using id-based pagination. Every row we visit advances
    // `lastSeenId`, so a row that consistently fails embedding generation
    // (API outage, bad key, throttling) is skipped permanently on this run —
    // guaranteeing forward progress and a bounded run time.
    let lastSeenId = 0;
    while (true) {
      const { rows } = await client.query<Row>(
        `SELECT id, title, content, tags
           FROM knowledge_entries
          WHERE embedding IS NULL
            AND id > $1
          ORDER BY id ASC
          LIMIT $2`,
        [lastSeenId, BATCH_SIZE],
      );
      if (rows.length === 0) break;

      for (const row of rows) {
        processed++;
        lastSeenId = row.id;
        const input = buildInput(row);
        if (input.trim().length === 0) {
          // Nothing to embed — leave NULL; id-pagination ensures we won't revisit.
          failed++;
          continue;
        }
        try {
          const response = await openai.embeddings.create({ model: EMBEDDING_MODEL, input });
          const vec = response.data[0]?.embedding;
          if (!vec || vec.length === 0) {
            failed++;
            console.warn(`  [${row.id}] empty embedding returned — skipping`);
            continue;
          }
          // pgvector literal: '[v1,v2,...]'
          const vectorLiteral = `[${vec.join(",")}]`;
          await client.query(`UPDATE knowledge_entries SET embedding = $1::vector WHERE id = $2`, [
            vectorLiteral,
            row.id,
          ]);
          succeeded++;
          if (processed % 10 === 0) {
            console.log(`  ${processed}/${total} processed (${succeeded} ok, ${failed} failed)`);
          }
        } catch (err) {
          failed++;
          console.warn(`  [${row.id}] embedding failed:`, err);
        }
      }
    }

    console.log(`Backfill complete. ${succeeded} embedded, ${failed} failed of ${processed} seen.`);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err: unknown) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
