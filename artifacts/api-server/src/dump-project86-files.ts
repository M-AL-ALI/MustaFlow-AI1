/**
 * Dumps all project 86 files to /tmp/towco-build for local Vite build.
 * Run: pnpm --filter @workspace/api-server exec tsx src/dump-project86-files.ts
 */
import { db, pool, projectFilesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { writeFileSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";

const OUT = "/tmp/towco-build";
const PROJECT_ID = 86;

const files = await db
  .select({ path: projectFilesTable.path, content: projectFilesTable.content })
  .from(projectFilesTable)
  .where(eq(projectFilesTable.projectId, PROJECT_ID));

console.log(`Found ${files.length} files`);

for (const f of files) {
  const dest = resolve(OUT, f.path);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, f.content ?? "");
  console.log(`  wrote ${f.path} (${(f.content ?? "").length} chars)`);
}

// Also write the 5 page files (they're in DB but let's be sure)
const pagesDir = resolve(OUT, "src/pages");
mkdirSync(pagesDir, { recursive: true });
console.log("\nPage files already in DB dump above.");

console.log("\nDone. Files written to", OUT);
await pool.end();
