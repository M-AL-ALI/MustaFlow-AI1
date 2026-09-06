/**
 * Task #776 — Comprehensive schema-drift catch-up migration.
 *
 * Runs every individual migration script in dependency order so that a fresh
 * dev database (or any database with partial schema drift) can be brought
 * fully up-to-date in a single command.
 *
 * Every selected migration is safe to re-run at any time. Destructive cutovers
 * and heuristic one-time data repairs are explicitly excluded below and must be
 * run through their dedicated, evidence-backed procedures.
 *
 * Run: pnpm --filter @workspace/scripts run migrate-all-outstanding
 */

import { execSync } from "child_process";

export const MIGRATION_EXCLUSIONS = {
  "migrate-drop-conversations": "Destructive cutover; requires its dedicated retirement procedure.",
  "migrate-drop-ora-daily-usage":
    "Destructive cutover; requires its dedicated retirement procedure.",
  "migrate-recover-ora-memories":
    "Heuristic data repair; requires a scoped historical-data review.",
} as const;

export const MIGRATIONS = [
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
  "migrate-voice-lang",
  "migrate-auto-read-replies",
  "migrate-reinforced-count",
  "migrate-canvas-state",
  "migrate-brainstorm-context",
  "migrate-gdpr-erasure-job",
  "migrate-low-credit-email",
  "migrate-ora-project-description",
  "migrate-mobile-deployment-columns",
  "migrate-preferred-mode",
  "migrate-project-mode",
  "migrate-provisioning-steps",
  "migrate-stripe-events-status",
  "migrate-agent-tool-calls",
  "migrate-ora-transcripts",
  "migrate-ora-transcript-cleanup",
  "migrate-vault",
  "migrate-vault-phase81",
  "migrate-vault-embeddings",
  "migrate-image-studio",
  "migrate-image-studio-v2",
  "migrate-image-edit-lineage",
  "migrate-tier-rename",
  "migrate-knowledge-usage-events",
  "migrate-task-events-data",
  "migrate-ora-conversations",
  "migrate-ora-assets",
  "migrate-ora-asset-storage",
  "migrate-ora-memory-center",
  "migrate-knowledge-origin",
  "migrate-ora-usage-windows",
  "migrate-ora-memory-category",
  "migrate-ora-project-memory",
  "migrate-help-center",
  "migrate-orax",
  "migrate-orax-github-readonly",
  "migrate-orax-approvals",
  "migrate-orax-artifacts",
  "migrate-orax-messages",
  "migrate-orax-desktop",
  "migrate-orax-projects",
  "migrate-ora-memory-supersede",
  "migrate-ora-conversation-summary",
  "migrate-ora-spend-ledger",
  "migrate-ora-realtime-usage",
  "migrate-ora-file-contexts",
  "migrate-ora-asset-versions",
  "migrate-ora-project-spaces",
  "migrate-brand-kits",
  "migrate-ora-asset-reference-guards",
  "migrate-ora-github",
] as const;

async function main(): Promise<void> {
  console.log(
    `Running ${MIGRATIONS.length} migrations in order; ` +
      `${Object.keys(MIGRATION_EXCLUSIONS).length} governed migrations excluded…\n`,
  );
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
