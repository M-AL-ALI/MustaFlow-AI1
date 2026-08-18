import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  jsonb,
  boolean,
  index,
} from "drizzle-orm/pg-core";
import { workspacesTable } from "./workspaces";

export const projectsTable = pgTable(
  "projects",
  {
    id: serial("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
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
    // Explicit tenant app service port. Null preserves each legacy runtime
    // path's historical default until the project receives a manifest value.
    runtimePort: integer("runtime_port"),
    // True when the user explicitly selected the stack at project creation.
    // False preserves automatic architecture selection for callers that omit it.
    stackLocked: boolean("stack_locked").notNull().default(false),
    // defaultAgent: user's preferred visible executor for this project.
    // "planning" = Planner, "main" = Main Agent. "task" is legacy compatibility.
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
    // Task #738 — auto-provisioning at project creation.
    // builderMode: "agentic" = every new project boots into a real Fly machine +
    //   Neon Postgres workspace at creation time. "static-legacy" = the old
    //   in-DB static-HTML flow with no per-project infra. Existing projects keep
    //   "static-legacy"; new projects default to "agentic".
    builderMode: text("builder_mode").notNull().default("agentic"),
    // neonProjectId: the Neon project id captured at provisioning time. Used to
    // de-duplicate retries and to delete the project on hard-delete. Mirrors
    // dbConnectionId for the Postgres path but is preserved even when the user
    // later swaps providers.
    neonProjectId: text("neon_project_id"),
    // provisioningStatus: lifecycle of the auto-provision background job.
    //   idle         — never started (legacy projects).
    //   provisioning — background job is running (create container + Neon DB).
    //   ready        — both container created and DATABASE_URL secret stored.
    //   hibernated   — container has auto-stopped after idle period.
    //   error        — last attempt failed. See provisioningError for the message.
    provisioningStatus: text("provisioning_status").notNull().default("idle"),
    provisioningError: text("provisioning_error"),
    // provisioningStep: the named step currently executing inside the provisioning pipeline.
    // null = not started or finished. Values: "create_container" | "create_database" | "connect_and_test"
    provisioningStep: text("provisioning_step"),
    // provisioningStartedAt: wall-clock timestamp when the most recent provisioning attempt began.
    // Used to compute an estimated time remaining in the workspace UI.
    provisioningStartedAt: timestamp("provisioning_started_at", { withTimezone: true }),
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
    // scannerSemgrepEnabled: when true, the always-on Semgrep SAST check runs on
    //   every build. Default true — Semgrep ships as the baseline SAST and is on
    //   by default; admins can flip it off per project for speed-over-coverage
    //   builds or to silence noisy false-positives on legacy projects.
    scannerSemgrepEnabled: boolean("scanner_semgrep_enabled").notNull().default(true),
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
    // preferredRegion: optional Cloudflare regional routing hint for the edge Worker.
    // Null = no preference (Cloudflare picks the closest PoP).
    // Example values: "weur" (Western Europe), "enam" (Eastern North America), "apac" (Asia Pacific).
    preferredRegion: text("preferred_region"),
    // Custom error pages — HTML served by the edge Worker and DB fallback on miss / origin error.
    // Null = fall back to the platform's default 404/500 HTML.
    errorPage404: text("error_page_404"),
    errorPage500: text("error_page_500"),
    // organizationId: the org this project belongs to.
    // Null = legacy personal project (not yet migrated to an org).
    // Set via migrate-collaboration backfill or explicitly on project creation.
    organizationId: integer("organization_id"),
    // Task #767 — Preview database provisioning.
    // previewDbUrl: encrypted connection string for the preview-environment Neon Postgres DB.
    // Null = not provisioned (static-legacy projects or agentic projects before first provision).
    // previewDbStatus: none | provisioning | ready | error
    previewDbUrl: text("preview_db_url"),
    previewDbStatus: text("preview_db_status").notNull().default("none"),
    // ── Testing workflow (test-then-publish architecture) ─────────────────────
    // Dedicated test container — entirely separate from the live dev container
    // (containerId). Never touched by file saves, AI builds, Apply, or terminal.
    // Only updated by POST /preview-env/start and /rebuild.
    testContainerId: text("test_container_id"),
    testContainerUrl: text("test_container_url"),
    testContainerStatus: text("test_container_status").notNull().default("stopped"),
    // runningTestSnapshotId: snapshot currently loaded in the test container.
    // Preserved even when testingStatus goes stale so the UI can show "last tested: #N".
    runningTestSnapshotId: integer("running_test_snapshot_id"),
    // staticTestCandidateSnapshotId: for pure-static/React-Vite projects.
    // Set when the user starts Test Preview — same immutability contract as Full App Preview.
    staticTestCandidateSnapshotId: integer("static_test_candidate_snapshot_id"),
    // testingCandidateSnapshotId: the immutable snapshot being tested (full-stack or static).
    // Cleared to null whenever testingStatus becomes stale.
    testingCandidateSnapshotId: integer("testing_candidate_snapshot_id"),
    // testingStatus: idle | building | ready | stale | passed | failed
    testingStatus: text("testing_status").notNull().default("idle"),
    // testedSnapshotId: the approved snapshot eligible for publishing.
    // Only set when testingStatus = 'passed'. Cleared on invalidation.
    testedSnapshotId: integer("tested_snapshot_id"),
    // previousPublishedSnapshotId: anchor for rollback after a production swap.
    previousPublishedSnapshotId: integer("previous_published_snapshot_id"),
    // activePreviewSessionId: FK → preview_sessions.session_id.
    // Points to the currently-active preview session for this project.
    // Cleared when preview is stopped or security-invalidated.
    activePreviewSessionId: text("active_preview_session_id"),
    // deletedAt: soft-delete timestamp. Null = active. Non-null = deleted.
    // chipLabel: name of the capability chip that pre-filled the prompt on the landing page.
    // E.g. "React SaaS app", "REST API + Postgres", "Mobile app". Null for projects created
    // without a chip (direct prompt, template, or API). Immutable after creation.
    chipLabel: text("chip_label"),
    // canvasState: persisted canvas board state for the Developer Mode Canvas tab.
    // Structure: { explorationId, tiles: { [variantId]: { device } } }
    // Saved by PATCH /api/projects/:id/canvas/state; loaded on workspace open.
    canvasState: jsonb("canvas_state").$type<Record<string, unknown>>().default({}),
    // requireCommandApproval: when true, the agent loop pauses before executing any
    // run_command or pkg_install call and asks the user to approve or reject it.
    // Default false — fully autonomous. Users can opt in from Project Settings.
    requireCommandApproval: boolean("require_command_approval").notNull().default(false),
    /**
     * Per-project hard cap on agent loop tool calls per hour.
     * When the count of agent_tool_calls rows in the last 60 minutes reaches
     * this value, the agent loop terminates with reason "rate_limited".
     * Default 200. Admins can raise it per-project.
     */
    toolCallRateCapPerHour: integer("tool_call_rate_cap_per_hour").notNull().default(200),
    // projectMode: surface that created this project.
    // 'builder'   — AI Build Mode (default, existing behaviour).
    // 'developer' — Developer Mode cloud IDE (Task #898).
    // Immutable after creation. Used to scope project list queries by mode.
    projectMode: text("project_mode").notNull().default("builder"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("projects_org_idx").on(t.organizationId),
    index("projects_owner_idx").on(t.ownerId),
    index("projects_workspace_idx").on(t.workspaceId),
  ],
);

export type Project = typeof projectsTable.$inferSelect;
export type InsertProject = typeof projectsTable.$inferInsert;
