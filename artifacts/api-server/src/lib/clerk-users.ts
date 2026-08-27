// ─────────────────────────────────────────────────────────────────────────────
// Clerk user lookup helpers
//
// Thin wrapper around @clerk/express's clerkClient for resolving user IDs to
// display info (name / email / avatar) and looking up users by email address.
// All functions degrade gracefully when CLERK_SECRET_KEY is not configured:
// they return null / empty maps instead of throwing, so the rest of the app
// keeps working in local dev without Clerk.
// ─────────────────────────────────────────────────────────────────────────────

import { clerkClient } from "@clerk/express";
import { logger } from "./logger";

export interface ClerkUserSummary {
  userId: string;
  email: string | null;
  displayName: string | null;
  imageUrl: string | null;
}

export const SHARED_ACCOUNT_PROFILE_SEMANTICS = "shared-account-profile-v1" as const;

export interface SharedAccountProfile extends ClerkUserSummary {
  semantics: typeof SHARED_ACCOUNT_PROFILE_SEMANTICS;
  preferredLanguage: string | null;
  whatIBuild: string | null;
}

export interface SharedAccountProfileUpdate {
  displayName: string;
  preferredLanguage?: string | null;
  whatIBuild?: string | null;
}

export const SHARED_PROFILE_SURFACE_FIELDS = {
  nabuflow: ["displayName", "imageUrl", "email", "preferredLanguage", "whatIBuild"],
  ora: ["displayName", "imageUrl", "email", "preferredLanguage"],
  orax: ["displayName", "imageUrl", "email"],
} as const satisfies Record<string, readonly (keyof SharedAccountProfile)[]>;

export type SharedProfileSurface = keyof typeof SHARED_PROFILE_SURFACE_FIELDS;

/** Presentation is configured per product while storage remains one account record. */
export function presentSharedAccountProfile(
  profile: SharedAccountProfile,
  surface: SharedProfileSurface,
): Partial<SharedAccountProfile> {
  return Object.fromEntries(
    SHARED_PROFILE_SURFACE_FIELDS[surface].map((field) => [field, profile[field]]),
  ) as Partial<SharedAccountProfile>;
}

type ClerkProfileMetadata = {
  preferredLanguage?: unknown;
  whatIBuild?: unknown;
};

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function sharedMetadata(user: { privateMetadata?: Record<string, unknown> | null }): {
  preferredLanguage: string | null;
  whatIBuild: string | null;
} {
  const raw = user.privateMetadata?.nabuFlowProfile;
  const profile =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as ClerkProfileMetadata) : {};
  return {
    preferredLanguage: boundedText(profile.preferredLanguage, 80),
    whatIBuild: boundedText(profile.whatIBuild, 280),
  };
}

function clerkConfigured(): boolean {
  return Boolean(process.env.CLERK_SECRET_KEY);
}

function summarise(user: {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  imageUrl?: string | null;
  primaryEmailAddressId?: string | null;
  emailAddresses?: Array<{ id: string; emailAddress: string }>;
}): ClerkUserSummary {
  const emails = user.emailAddresses ?? [];
  const primary = emails.find((e) => e.id === user.primaryEmailAddressId);
  const email = primary?.emailAddress ?? emails[0]?.emailAddress ?? null;
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  const displayName = fullName || user.username || null;
  return {
    userId: user.id,
    email,
    displayName,
    imageUrl: user.imageUrl ?? null,
  };
}

/**
 * Look up a single Clerk user by their user ID.
 * Returns null when the user does not exist, Clerk is not configured, or the call fails.
 */
export async function getClerkUserById(userId: string): Promise<ClerkUserSummary | null> {
  if (!userId) return null;
  if (!clerkConfigured()) return null;
  try {
    const user = await clerkClient.users.getUser(userId);
    if (!user) return null;
    return summarise(user);
  } catch (err) {
    logger.warn({ err, userId }, "Clerk user lookup by ID failed");
    return null;
  }
}

/**
 * Resolve the account-level identity shared by NabuFlow, Ora and Orax.
 * Clerk is the single record: product-local tables must not cache these fields.
 */
export async function getSharedAccountProfile(
  userId: string,
): Promise<SharedAccountProfile | null> {
  if (!userId || !clerkConfigured()) return null;
  try {
    const user = await clerkClient.users.getUser(userId);
    if (!user) return null;
    return {
      ...summarise(user),
      ...sharedMetadata(user),
      semantics: SHARED_ACCOUNT_PROFILE_SEMANTICS,
    };
  } catch (err) {
    logger.warn({ err, userId }, "Shared account profile lookup failed");
    return null;
  }
}

/**
 * Update the shared account identity in one Clerk user record. Product settings
 * remain outside this shape by design.
 */
export async function updateSharedAccountProfile(
  userId: string,
  input: SharedAccountProfileUpdate,
): Promise<SharedAccountProfile> {
  if (!userId || !clerkConfigured()) throw new Error("shared_profile_store_unavailable");
  const displayName = boundedText(input.displayName, 80);
  if (!displayName) throw new Error("shared_profile_display_name_required");

  const current = await clerkClient.users.getUser(userId);
  const parts = displayName.split(/\s+/u);
  const firstName = parts[0] ?? displayName;
  const lastName = parts.slice(1).join(" ");
  const existingPrivate = (current.privateMetadata ?? {}) as Record<string, unknown>;
  const existingShared = sharedMetadata(current);
  const preferredLanguage =
    input.preferredLanguage === undefined
      ? existingShared.preferredLanguage
      : boundedText(input.preferredLanguage, 80);
  const whatIBuild =
    input.whatIBuild === undefined ? existingShared.whatIBuild : boundedText(input.whatIBuild, 280);

  await clerkClient.users.updateUser(userId, { firstName, lastName });
  const updated = await clerkClient.users.updateUserMetadata(userId, {
    privateMetadata: {
      ...existingPrivate,
      nabuFlowProfile: { preferredLanguage, whatIBuild },
    },
  });
  return {
    ...summarise(updated),
    preferredLanguage,
    whatIBuild,
    semantics: SHARED_ACCOUNT_PROFILE_SEMANTICS,
  };
}

/**
 * Look up a Clerk user by email address. Returns null when no user exists for
 * the email, when Clerk is not configured, or when the Clerk call fails.
 */
export async function findClerkUserByEmail(email: string): Promise<ClerkUserSummary | null> {
  const trimmed = email.trim().toLowerCase();
  if (!trimmed) return null;
  if (!clerkConfigured()) return null;
  try {
    const result = await clerkClient.users.getUserList({
      emailAddress: [trimmed],
      limit: 1,
    });
    const user = result.data?.[0];
    if (!user) return null;
    return summarise(user);
  } catch (err) {
    logger.warn({ err, email: trimmed }, "Clerk user lookup by email failed");
    return null;
  }
}

/**
 * Look up a Clerk user by username. Returns null when no user exists for
 * the username, when Clerk is not configured, or when the Clerk call fails.
 */
export async function findClerkUserByUsername(username: string): Promise<ClerkUserSummary | null> {
  const trimmed = username.trim().toLowerCase();
  if (!trimmed) return null;
  if (!clerkConfigured()) return null;
  try {
    const result = await clerkClient.users.getUserList({
      username: [trimmed],
      limit: 1,
    });
    const user = result.data?.[0];
    if (!user) return null;
    return summarise(user);
  } catch (err) {
    logger.warn({ err, username: trimmed }, "Clerk user lookup by username failed");
    return null;
  }
}

/**
 * Permanently delete a Clerk user (sign-in identity, credentials, email).
 * Used by the GDPR / account-deletion flow so a deleted account can no longer
 * authenticate. Returns true when the user was deleted (or already absent).
 * Degrades gracefully: returns false and never throws when Clerk is not
 * configured or the call fails.
 */
export async function deleteClerkUser(userId: string): Promise<boolean> {
  if (!userId) return false;
  if (!clerkConfigured()) return false;
  try {
    await clerkClient.users.deleteUser(userId);
    return true;
  } catch (err) {
    // A 404 means the user is already gone — treat that as success.
    const status = (err as { status?: number } | null)?.status;
    if (status === 404) return true;
    logger.warn({ err, userId }, "Clerk user deletion failed");
    return false;
  }
}

/**
 * Batch-resolve Clerk user IDs to display summaries. Returns a Map keyed by
 * userId. IDs that fail to resolve (deleted users, Clerk down, etc.) are
 * simply omitted from the map.
 */
export async function getClerkUserSummaries(
  userIds: ReadonlyArray<string>,
): Promise<Map<string, ClerkUserSummary>> {
  const out = new Map<string, ClerkUserSummary>();
  const unique = Array.from(new Set(userIds.filter(Boolean)));
  if (unique.length === 0) return out;
  if (!clerkConfigured()) return out;
  try {
    const result = await clerkClient.users.getUserList({
      userId: unique,
      limit: Math.min(unique.length, 100),
    });
    for (const user of result.data ?? []) {
      out.set(user.id, summarise(user));
    }
  } catch (err) {
    logger.warn({ err, count: unique.length }, "Clerk user batch lookup failed");
  }
  return out;
}
