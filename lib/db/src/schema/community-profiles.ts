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

export const communityProfilesTable = pgTable(
  "community_profiles",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull().unique(),
    username: text("username").notNull().unique(),
    displayName: text("display_name"),
    bio: text("bio"),
    avatarUrl: text("avatar_url"),
    websiteUrl: text("website_url"),
    twitterHandle: text("twitter_handle"),
    githubHandle: text("github_handle"),
    location: text("location"),
    publicProjectIds: jsonb("public_project_ids").$type<number[]>().notNull().default([]),
    showcasedProjectIds: jsonb("showcased_project_ids").$type<number[]>().notNull().default([]),
    followerCount: integer("follower_count").notNull().default(0),
    followingCount: integer("following_count").notNull().default(0),
    badgeEmbedEnabled: boolean("badge_embed_enabled").notNull().default(false),
    profilePublic: boolean("profile_public").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("community_profiles_username_idx").on(table.username),
    index("community_profiles_user_id_idx").on(table.userId),
  ],
);

export type CommunityProfile = typeof communityProfilesTable.$inferSelect;
export type InsertCommunityProfile = typeof communityProfilesTable.$inferInsert;

export const profileFollowsTable = pgTable(
  "profile_follows",
  {
    id: serial("id").primaryKey(),
    followerId: text("follower_id").notNull(),
    followingId: text("following_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("profile_follows_follower_idx").on(table.followerId),
    index("profile_follows_following_idx").on(table.followingId),
  ],
);

export type ProfileFollow = typeof profileFollowsTable.$inferSelect;
export type InsertProfileFollow = typeof profileFollowsTable.$inferInsert;
