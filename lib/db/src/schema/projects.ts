import { pgTable, serial, text, timestamp, integer, jsonb } from "drizzle-orm/pg-core";
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
  // publishedSnapshotId: the project_versions row that is currently live.
  // When set, the public route serves files from that snapshot instead of live files.
  // Null = not published. Updated on every publish, cleared on unpublish.
  publishedSnapshotId: integer("published_snapshot_id"),
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
  // defaultAgent: user's preferred agent for this project.
  // "planning" = Planning Agent, "task" = Task Agent (staging gate),
  // "main" = Main Agent (direct fast edit). Default "main".
  defaultAgent: text("default_agent").notNull().default("main"),
  // deletedAt: soft-delete timestamp. Null = active. Non-null = deleted.
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Project = typeof projectsTable.$inferSelect;
export type InsertProject = typeof projectsTable.$inferInsert;
