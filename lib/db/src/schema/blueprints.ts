import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  jsonb,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

/**
 * Task #542 — Integration blueprints.
 * Tracks which integration blueprint packs have been installed into a project.
 * One row per (project, blueprintId). Re-installing updates the row.
 */
export const projectBlueprintsTable = pgTable(
  "project_blueprints",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    blueprintId: text("blueprint_id").notNull(),
    version: text("version").notNull().default("1.0.0"),
    installedBy: text("installed_by"),
    /** Free-form metadata from the scaffold: files written, packages installed, secrets requested. */
    result: jsonb("result").$type<{
      filesWritten?: string[];
      packagesInstalled?: Array<{ runtime: string; name: string; version?: string }>;
      secretsRequested?: string[];
      notes?: string;
    } | null>(),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("project_blueprints_pk_idx").on(t.projectId, t.blueprintId)],
);

export type ProjectBlueprint = typeof projectBlueprintsTable.$inferSelect;
export type InsertProjectBlueprint = typeof projectBlueprintsTable.$inferInsert;

/**
 * Task #542 — MCP server registry (admin-managed).
 * Each row is an MCP-compatible endpoint that exposes tools to the agent loop.
 * Tools are fetched at the start of each build and proxied through the loop.
 */
export const mcpServersTable = pgTable(
  "mcp_servers",
  {
    id: serial("id").primaryKey(),
    /** Human-readable name shown in the marketplace UI. */
    name: text("name").notNull(),
    /** Short description shown alongside the toolset in the agent UI. */
    description: text("description"),
    /** Full HTTPS endpoint of the MCP server (JSON-RPC over HTTP). */
    endpoint: text("endpoint").notNull(),
    /** Optional auth header value (encrypted at rest is future work). */
    authHeader: text("auth_header"),
    /** When false, the server is registered but skipped at tool registration time. */
    enabled: boolean("enabled").notNull().default(true),
    /** Last successfully fetched tool catalog (cached for offline / degraded use). */
    cachedTools: jsonb("cached_tools").$type<Array<{
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
    }> | null>(),
    cachedAt: timestamp("cached_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("mcp_servers_enabled_idx").on(t.enabled)],
);

export type McpServer = typeof mcpServersTable.$inferSelect;
export type InsertMcpServer = typeof mcpServersTable.$inferInsert;
