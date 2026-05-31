import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";

export const IMAGE_QUALITY_COSTS: Record<string, number> = {
  draft: 1,
  standard: 3,
  high: 6,
};

export const IMAGE_PURPOSES = [
  "general",
  "marketing",
  "avatar",
  "illustration",
  "background",
  "product",
] as const;

export type ImagePurpose = (typeof IMAGE_PURPOSES)[number];

export const generatedImagesTable = pgTable("generated_images", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  projectId: integer("project_id"),
  prompt: text("prompt").notNull(),
  negativePrompt: text("negative_prompt"),
  revisedPrompt: text("revised_prompt"),
  style: text("style"),
  purpose: text("purpose"),
  quality: text("quality").notNull().default("standard"),
  aspectRatio: text("aspect_ratio").notNull().default("1:1"),
  transparentBackground: boolean("transparent_background").notNull().default(false),
  providerName: text("provider_name").notNull().default("openai"),
  modelName: text("model_name"),
  status: text("status").notNull().default("pending"),
  fileUrl: text("file_url"),
  thumbnailUrl: text("thumbnail_url"),
  storageKey: text("storage_key"),
  safetyStatus: text("safety_status").notNull().default("pending"),
  creditCost: integer("credit_cost").notNull().default(3),
  errorMessage: text("error_message"),
  errorCategory: text("error_category"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export type GeneratedImage = typeof generatedImagesTable.$inferSelect;
export type NewGeneratedImage = typeof generatedImagesTable.$inferInsert;
