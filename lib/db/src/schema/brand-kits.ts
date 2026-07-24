import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";

export const SAFE_FONTS = [
  "Calibri",
  "Arial",
  "Georgia",
  "Times New Roman",
  "Trebuchet MS",
  "Helvetica",
  "Verdana",
] as const;
export type SafeFont = (typeof SAFE_FONTS)[number];

export const brandKitsTable = pgTable(
  "brand_kits",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    oraProjectId: integer("ora_project_id"),
    logoAssetId: integer("logo_asset_id"),
    primaryColor: text("primary_color"),
    secondaryColor: text("secondary_color"),
    accentColor: text("accent_color"),
    headingFont: text("heading_font"),
    bodyFont: text("body_font"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("brand_kits_user_id_idx").on(t.userId),
    index("brand_kits_user_project_idx").on(t.userId, t.oraProjectId),
  ],
);

export type BrandKitRow = typeof brandKitsTable.$inferSelect;
export type NewBrandKit = typeof brandKitsTable.$inferInsert;
