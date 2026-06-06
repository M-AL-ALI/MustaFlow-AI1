/**
 * Task #776 — Comprehensive schema-drift catch-up migration.
 *
 * Runs every individual migration script in dependency order so that a fresh
 * dev database (or any database with partial schema drift) can be brought
 * fully up-to-date in a single command.
 *
 * Every constituent migration uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS so
 * the script is safe to re-run at any time — already-applied steps are no-ops.
 *
 * Run: pnpm --filter @workspace/scripts run migrate-all-outstanding
 */

import { execSync } from "child_process";

const MIGRATIONS = [
  "migrate-containers",
  "migrate-production-container",
  "migrate-prod-containers",
  "migrate-db-snapshots",
  "migrate-check-runs",
  "migrate-e2e-enabled",
  "migrate-multiplayer-uploads",
  "migrate-security-gate",
  "migrate-security-findings",
  "migrate-app-test-runs",
  "migrate-cve-patch-columns",
  "migrate-knowledge-embeddings",
  "migrate-knowledge-vault-v2",
  "migrate-version-validation-status",
  "migrate-architect-review",
  "migrate-prod-logs",
  "migrate-policy-audit",
  "migrate-background-jobs",
  "migrate-builder-skills",
  "migrate-builder-skills-drafts",
  "migrate-project-embeddings",
  "migrate-project-domains",
  "migrate-checkpoint-id",
  "migrate-staging-domains",
  "migrate-cf-hostname-columns",
  "migrate-canvas-variants",
  "migrate-lesson-contribution-reward",
  "migrate-canvas-variants-v2",
  "migrate-blueprints",
  "migrate-deployment-substrate",
  "migrate-project-artifacts",
  "migrate-security-scanners",
  "migrate-agent-inbox",
  "migrate-preferred-region",
  "migrate-receipt-url",
  "migrate-domain-cert-fields",
  "migrate-webhooks-pat",
  "migrate-domain-security",
  "migrate-dns-records",
  "migrate-pg-boss",
  "migrate-workspace-domains",
  "migrate-purchased-domains",
  "migrate-workspace-subscriptions",
  "migrate-plan-templates",
  "migrate-cdn-perfection",
  "migrate-subscriptions",
  "migrate-runtime-breadth",
  "migrate-collaboration",
  "migrate-ecosystem",
  "migrate-secret-scoping",
  "migrate-agentic-provisioning",
  "migrate-task-agent-mode",
  "migrate-preview-secrets",
  "migrate-testing-approval",
  "migrate-preview-db",
  "migrate-testing-workflow",
  "migrate-deployment-logs-mobile",
  "migrate-token-count",
  "migrate-chip-label",
  "migrate-personal-access-tokens",
  "migrate-pat-rotation",
  "migrate-message-origin",
  "migrate-command-approval",
  "migrate-reinforced-count",
  "migrate-voice-lang",
  "migrate-ora-transcripts",
  "migrate-vault-embeddings",
  "migrate-ora-memory-center",
] as const;

async function main(): Promise<void> {
  console.log(`Running ${MIGRATIONS.length} migrations in order…\n`);
  let passed = 0;
  let failed = 0;

  for (const migration of MIGRATIONS) {
    process.stdout.write(`  ${migration}… `);
    try {
      execSync(`pnpm --filter @workspace/scripts run ${migration}`, {
        stdio: "pipe",
        cwd: process.cwd().endsWith("/scripts") ? ".." : ".",
      });
      console.log("✓");
      passed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`✗  (${msg.split("\n")[0]})`);
      failed++;
    }
  }

  console.log(`\nDone. ${passed} succeeded, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("migrate-all-outstanding failed:", err);
  process.exit(1);
});
