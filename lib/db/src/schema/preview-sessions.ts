import { pgTable, serial, text, integer, timestamp, boolean, index } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

/**
 * Preview sessions — short-lived authenticated sessions for the Full App Preview
 * subdomain gateway ({sessionId}.preview.{PLATFORM_DOMAIN}).
 *
 * Flow:
 *  1. POST /preview-env/start creates a row with a one-time launch token (hashed).
 *  2. Browser navigates to /__preview-launch?t={launchToken} on the preview subdomain.
 *  3. Gateway validates the token, marks it used, issues an HttpOnly host-only cookie.
 *  4. All subsequent requests are authenticated via the cookie.
 *  5. revokePreviewForSecurityChange() sets revokedAt; gateway checks this per request.
 */
export const previewSessionsTable = pgTable(
  "preview_sessions",
  {
    id: serial("id").primaryKey(),
    // sessionId: 16-char random hex, used as the subdomain label.
    // Format: {sessionId}.preview.{PLATFORM_DOMAIN}
    sessionId: text("session_id").notNull().unique(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    // userId: Clerk userId of the project member who started this preview session.
    userId: text("user_id").notNull(),
    // launchTokenHash: sha256(launchToken). The plaintext token is given to the browser
    // once and never stored. It is valid for 10 minutes and single-use.
    launchTokenHash: text("launch_token_hash").notNull(),
    launchTokenUsed: boolean("launch_token_used").notNull().default(false),
    cookieIssuedAt: timestamp("cookie_issued_at", { withTimezone: true }),
    // expiresAt: the whole session expires at this time (default 8 hours after creation).
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // revokedAt: set by revokePreviewForSecurityChange(). Blocks access immediately.
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokeReason: text("revoke_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("preview_sessions_project_idx").on(t.projectId),
    index("preview_sessions_session_id_idx").on(t.sessionId),
  ],
);

export type PreviewSession = typeof previewSessionsTable.$inferSelect;
export type InsertPreviewSession = typeof previewSessionsTable.$inferInsert;
