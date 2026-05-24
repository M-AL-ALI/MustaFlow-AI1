/**
 * Migration: multi-artifact projects (Task #544).
 *
 * 1. Creates project_artifacts table.
 * 2. Adds project_files.artifact_id (nullable).
 * 3. Backfills: for each existing project, inserts one is_primary=true artifact
 *    row mirroring the project's kind/platform/stack/projectFormat, then
 *    updates every existing project_files row to point at it.
 *
 * Safe to re-run — uses IF NOT EXISTS and skips projects that already have
 * a primary artifact.
 *
 * Usage: pnpm --filter @workspace/scripts run migrate-project-artifacts
 */

import { pool } from "@workspace/db";

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    console.log("Creating project_artifacts table…");
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_artifacts (
        id serial PRIMARY KEY,
        project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind text NOT NULL DEFAULT 'web',
        platform text NOT NULL DEFAULT 'web',
        project_format text NOT NULL DEFAULT 'static-html',
        stack text NOT NULL DEFAULT 'react-vite',
        name text NOT NULL,
        slug text NOT NULL,
        is_primary boolean NOT NULL DEFAULT false,
        status text NOT NULL DEFAULT 'draft',
        last_task_summary text,
        deleted_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS project_artifacts_project_slug_unique
        ON project_artifacts(project_id, slug);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS project_artifacts_project_idx
        ON project_artifacts(project_id);
    `);

    console.log("Adding project_files.artifact_id…");
    await client.query(`
      ALTER TABLE project_files
        ADD COLUMN IF NOT EXISTS artifact_id integer;
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS project_files_artifact_idx
        ON project_files(artifact_id);
    `);

    console.log("Backfilling primary artifact per project…");
    const { rows: projects } = await client.query<{
      id: number;
      name: string;
      kind: string;
      platform: string;
      project_format: string;
      stack: string;
      status: string;
      last_task_summary: string | null;
    }>(
      `SELECT id, name, kind, platform, project_format, stack, status, last_task_summary
       FROM projects
       WHERE deleted_at IS NULL`,
    );

    let backfilled = 0;
    for (const p of projects) {
      // Skip if a primary artifact already exists.
      const { rowCount } = await client.query(
        `SELECT 1 FROM project_artifacts WHERE project_id = $1 AND is_primary = true LIMIT 1`,
        [p.id],
      );
      if ((rowCount ?? 0) > 0) continue;

      // Choose a slug that doesn't collide.
      const slugBase =
        p.kind === "web" ? "web" : p.kind.startsWith("mobile") ? "mobile" : p.kind || "app";
      const artifactName =
        p.kind === "web" ? "Web app" : slugBase[0]!.toUpperCase() + slugBase.slice(1);

      const { rows: inserted } = await client.query<{ id: number }>(
        `INSERT INTO project_artifacts
           (project_id, kind, platform, project_format, stack, name, slug, is_primary, status, last_task_summary)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9)
         RETURNING id`,
        [
          p.id,
          p.kind,
          p.platform,
          p.project_format,
          p.stack,
          artifactName,
          slugBase,
          p.status,
          p.last_task_summary,
        ],
      );
      const artifactId = inserted[0]!.id;

      await client.query(
        `UPDATE project_files SET artifact_id = $1 WHERE project_id = $2 AND artifact_id IS NULL`,
        [artifactId, p.id],
      );
      backfilled++;
    }

    console.log(`Migration complete. Backfilled ${backfilled} primary artifact(s).`);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
