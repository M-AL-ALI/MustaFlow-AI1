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
 * Look up a single Clerk user by their user ID.
 * Returns null when the user is not found, Clerk is not configured, or the call fails.
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
