import { pgTable, serial, integer, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { workspaceDomainsTable } from "./workspace-domains";

// Domain-scoped roles: viewer (read), editor (add/verify/DNS edit), owner (delete/transfer)
export const DOMAIN_ROLES = ["viewer", "editor", "owner"] as const;
export type DomainRole = (typeof DOMAIN_ROLES)[number];

export const workspaceDomainRolesTable = pgTable(
  "workspace_domain_roles",
  {
    id: serial("id").primaryKey(),
    workspaceDomainId: integer("workspace_domain_id")
      .notNull()
      .references(() => workspaceDomainsTable.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    role: text("role").notNull().default("viewer"),
    grantedBy: text("granted_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("workspace_domain_roles_domain_user_unique").on(t.workspaceDomainId, t.userId),
  ],
);

export type WorkspaceDomainRole = typeof workspaceDomainRolesTable.$inferSelect;
export type InsertWorkspaceDomainRole = typeof workspaceDomainRolesTable.$inferInsert;
