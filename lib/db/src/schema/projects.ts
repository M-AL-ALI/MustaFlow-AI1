import { pgTable, serial, text, timestamp, integer, jsonb, boolean } from "drizzle-orm/pg-core";
import { workspacesTable } from "./workspaces";

export const projectsTable = pgTable("projects", {
  id: serial("id").primaryKey(),
  ownerId: text("owner_id").notNull().default("demo-user"),
  workspaceId: integer("workspace_id").references(() => workspacesTable.id),
  name: text("name").notNull(),
  description: text("description"),
  kind: text("kind").notNull().default("web"),
  // platform: derived summary of the target runtime.
  // web = static web app, ios = iOS-only, android = Android-only, cross = iOS + Android (+ web)
  platform: text("platform").notNull().default("web"),
  status: text("status").notNull().default("draft"),
  agentMode: text("agent_mode").notNull().default("eco"),
  lastTaskSummary: text("last_task_summary"),
  summary: text("summary"),
  // publishedSnapshotId: the project_versions row that is currently live (production).
  // When set, the public route serves files from that snapshot instead of live files.
  // Null = not published. Updated on every publish, cleared on unpublish.
  publishedSnapshotId: integer("published_snapshot_id"),
  // stagingPublishedSnapshotId: mirrors publishedSnapshotId for the staging slot.
  // Null = not staged. Set on publish?env=staging; promoted to publishedSnapshotId on promote.
  stagingPublishedSnapshotId: integer("staging_published_snapshot_id"),
  // publicSlug: human-readable slug used in the public URL (/api/p/:slug/).
  // Generated on first publish; preserved on republish; never cleared on unpublish.
  publicSlug: text("public_slug").unique(),
  // Published site metadata — editable from the Publishing tab.
  siteTitle: text("site_title"),
  metaDescription: text("meta_description"),
  themeColor: text("theme_color"),
  // Custom domain management.
  // customDomain: user-supplied FQDN (e.g. "app.example.com"). Null = not configured.
  // domainStatus: unconfigured | pending_verification | active | error
  // sslStatus: pending | provisioning | active | failed
  customDomain: text("custom_domain").unique(),
  domainStatus: text("domain_status").notNull().default("unconfigured"),
  sslStatus: text("ssl_status").notNull().default("pending"),
  // verificationToken: random hex token used for TXT-based domain ownership proof.
  // Generated on first domain save. TXT record: _mustaflow.<domain> = mustaflow-verify=<token>
  verificationToken: text("verification_token"),
  // Cloudflare for SaaS — custom hostname SSL automation.
  // cfHostnameId: stored after ssl-activate creates the CF custom hostname.
  // domainVerifiedAt: when DNS ownership was confirmed.
  // sslVerifiedAt: when Cloudflare reported SSL as active.
  // sslError: last error message from Cloudflare (cleared on next activation attempt).
  cfHostnameId: text("cf_hostname_id"),
  domainVerifiedAt: timestamp("domain_verified_at", { withTimezone: true }),
  sslVerifiedAt: timestamp("ssl_verified_at", { withTimezone: true }),
  sslError: text("ssl_error"),
  // pageMapData: AI-extracted and user-edited page/screen flow map.
  // Structure: { web: { nodes, edges }, ios: { nodes, edges }, android: { nodes, edges } }
  pageMapData: jsonb("page_map_data"),
  // projectFormat: the output format for this project's builder pipeline.
  // "static-html" = single-file HTML/CSS/JS with CDN dependencies (legacy default).
  // "react-vite" = multi-file React + Vite + Tailwind npm project (new default for web).
  projectFormat: text("project_format").notNull().default("static-html"),
  // stack: the technology stack chosen at project creation.
  // react-vite    = React 18 + Vite + Tailwind CSS (default for web)
  // nextjs        = Next.js 14 App Router + Tailwind CSS
  // node-api      = Node.js + Express REST API
  // python-flask  = Python + Flask web app / API
  // python-fastapi = Python + FastAPI
  // Immutable after creation — duplicate the project to change stack.
  stack: text("stack").notNull().default("react-vite"),
  // defaultAgent: user's preferred agent for this project.
  // "planning" = Planning Agent, "task" = Task Agent (staging gate),
  // "main" = Main Agent (direct fast edit). Default "main".
  defaultAgent: text("default_agent").notNull().default("main"),
  // Container infrastructure (Phase C — dev containers).
  // containerId: Fly.io Machine ID for this project's dev container. Null = not provisioned.
  // containerStatus: stopped | starting | running | hibernated | error
  // containerUrl: proxy URL to reach the container's dev server (e.g. https://app.fly.dev/container/<machineId>).
  containerId: text("container_id"),
  containerStatus: text("container_status").notNull().default("stopped"),
  containerUrl: text("container_url"),
  // Production container infrastructure (Phase E — prod containers).
  // prodContainerId: Fly.io Machine ID for the live production container. Null = not deployed.
  // prodContainerStatus: stopped | starting | running | hibernated | error | deploying
  // prodContainerUrl: proxy URL to reach the production container (e.g. https://app.fly.dev/container/<machineId>).
  prodContainerId: text("prod_container_id"),
  prodContainerStatus: text("prod_container_status").notNull().default("stopped"),
  prodContainerUrl: text("prod_container_url"),
  // Per-project database provisioning (Phase G).
  // dbProvider: none | postgres | sqlite — which database engine is provisioned for this project.
  // dbStatus: none | provisioning | connected | error — current lifecycle state.
  // dbConnectionId: opaque identifier for the provisioned DB (e.g. Neon project ID). Null = not provisioned.
  dbProvider: text("db_provider").notNull().default("none"),
  dbStatus: text("db_status").notNull().default("none"),
  dbConnectionId: text("db_connection_id"),
  // blockPublishOnCritical: when true, the publish readiness gate blocks publish if any
  // unresolved critical (error-severity) security findings exist from the latest check run.
  // Default true — matches Replit's "block on critical vulnerabilities" opt-in model.
  blockPublishOnCritical: boolean("block_publish_on_critical").notNull().default(true),
  // dismissedFindingHashes: array of opaque finding keys (file:line:message hashes) that the
  // user has explicitly dismissed in the Quality panel. Dismissed findings are excluded from
  // the publish security gate check so the block is cleared without rebuilding.
  dismissedFindingHashes: jsonb("dismissed_finding_hashes").$type<string[]>().default([]),
  // autoFixOnCheckFailure: when true, the server automatically enqueues a refine
  // task using the failed checks' fixPrompts after every build that has failing checks.
  // Auto-fix only fires once per build (not on auto-fix tasks themselves).
  autoFixOnCheckFailure: boolean("auto_fix_on_check_failure").notNull().default(false),
  // autoFixWarningsAfterBuild: when true, the build pipeline runs project-wide
  // ESLint auto-fix at the end of every successful build (before the version
  // snapshot is taken, so the saved snapshot reflects the post-fix state).
  // Default false — opt-in.
  autoFixWarningsAfterBuild: boolean("auto_fix_warnings_after_build").notNull().default(false),
  // architectReviewEnabled: when true, a second-opinion architect review runs after every
  // successful build/refine. The architect inspects user request + plan + diff + commands and
  // returns a structured verdict + findings. Critical/fail verdicts trigger one auto-fix turn.
  // Charged as a separate flat-rate credit (2 credits). Default true — opt-out per project.
  architectReviewEnabled: boolean("architect_review_enabled").notNull().default(true),
  // policyStrictness: controls how strict the agent loop's command policy is.
  // "safe"       — legacy whitelist (read-only inspectors + declared check argvs only).
  // "standard"   — broad allow with deny-list (default).
  // "permissive" — admin-only; skips registry allowlist for pkg_install.
  policyStrictness: text("policy_strictness").notNull().default("standard"),
  // Task #545 — Security & Quality Pack: per-project scanner toggles.
  // scannerHoundDogEnabled: when true, the HoundDog secret/PII leak scanner runs
  //   alongside semgrep on every build. Default false — opt-in (HoundDog requires
  //   its CLI to be installed and is more permissive than the always-on secret-leak
  //   check; admins may flip this on per project for stricter PII coverage).
  // scannerTrivyEnabled: when true, the Trivy filesystem/vulnerability scanner runs
  //   on every build (lockfiles, container manifests, IaC). Default false — opt-in.
  scannerHoundDogEnabled: boolean("scanner_hounddog_enabled").notNull().default(false),
  scannerTrivyEnabled: boolean("scanner_trivy_enabled").notNull().default(false),
  // e2eEnabled: when true, the agentic builder loop automatically runs a Playwright
  // smoke E2E scenario set after every successful web build, and the `run_e2e` tool
  // is available to the model. Default true. Disable for speed-over-coverage builds.
  e2eEnabled: boolean("e2e_enabled").notNull().default(true),
  // multiplayerEnabled: when true, this project participates in real-time multiplayer
  // presence/edit broadcasts over the /api/projects/:id/multiplayer WebSocket. Default
  // false — opt-in per project from the Manage tab. (Task #540)
  multiplayerEnabled: boolean("multiplayer_enabled").notNull().default(false),
  // redirectWwwApex: when true, requests to www.<apex> are 301-redirected to apex (or vice versa).
  // Only meaningful when both the apex and www subdomain are attached as project_domains rows.
  redirectWwwApex: boolean("redirect_www_apex").notNull().default(false),
  // Deployment substrate (Task #543).
  // deploymentType: static = snapshot+CDN only (default), autoscale = on-demand container w/ scale-to-zero,
  // reserved_vm = always-on container (min_machines_running:1).
  deploymentType: text("deployment_type").notNull().default("static"),
  // region: Fly region code (e.g. iad, lhr, syd, fra, nrt). Null = use FLY_REGION env default.
  region: text("region"),
  // cdnEnabled: when true and CDN_PROVIDER is configured, publish pushes the snapshot to the edge CDN.
  cdnEnabled: boolean("cdn_enabled").notNull().default(false),
  // cdnLastPushedAt: timestamp of last successful CDN push (null if never pushed).
  cdnLastPushedAt: timestamp("cdn_last_pushed_at", { withTimezone: true }),
  // healthCheckPath: relative URL the synthetic uptime probe hits (default "/").
  healthCheckPath: text("health_check_path").notNull().default("/"),
  // uptimeAlertEmail: address that receives consecutive-failure alerts. Null = no email alerts.
  uptimeAlertEmail: text("uptime_alert_email"),
  // deletedAt: soft-delete timestamp. Null = active. Non-null = deleted.
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Project = typeof projectsTable.$inferSelect;
export type InsertProject = typeof projectsTable.$inferInsert;
