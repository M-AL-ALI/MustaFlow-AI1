import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@127.0.0.1:1/test";
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? Buffer.alloc(32, 17).toString("base64");

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

describe("one shared account profile", () => {
  it("defines identity once and keeps product settings outside it", () => {
    const identity = source("./clerk-users.ts");
    expect(identity).toContain('SHARED_ACCOUNT_PROFILE_SEMANTICS = "shared-account-profile-v1"');
    expect(identity).toContain("displayName: string");
    expect(identity).toContain("preferredLanguage?: string | null");
    expect(identity).toContain("whatIBuild?: string | null");
    expect(identity).toContain("SHARED_PROFILE_SURFACE_FIELDS");
    expect(identity).toContain('ora: ["displayName", "imageUrl", "email", "preferredLanguage"]');
    expect(identity).toContain('orax: ["displayName", "imageUrl", "email"]');
    expect(identity).not.toContain("notificationPreferences");
    expect(identity).not.toContain("builderPreferences");
    expect(identity).not.toContain("deviceSettings");
  });

  it("makes NabuFlow, Ora and Orax read the same account identity", () => {
    for (const path of [
      "../routes/account-profile.ts",
      "../routes/profiles.ts",
      "../routes/profile-ssr.ts",
      "../routes/ora-profile.ts",
      "../routes/public-ai/chat.ts",
      "../routes/orax-desktop-auth.ts",
    ]) {
      expect(source(path), path).toContain("getSharedAccountProfile");
    }
  });

  it("does not write duplicate identity into Ora or community-profile rows", () => {
    const ora = source("../routes/ora-profile.ts");
    const community = source("../routes/profiles.ts");
    expect(ora).toContain("preferredName: null");
    expect(ora).toContain("preferredLanguage: null");
    expect(community).toContain("displayName: null");
    expect(community).toContain("avatarUrl: null");
  });

  it("keeps picture management in the canonical identity provider", () => {
    const settings = source("../../../mustaflow/src/pages/settings.tsx");
    expect(settings).toContain("Change picture");
    expect(settings).toContain("/api/me/account-profile");
    expect(settings).not.toContain("avatarUrl:");
  });

  it("requires the audited owner gate before running the one-time migration", () => {
    const route = source("../routes/account-profile.ts");
    expect(route).toContain('"/admin/shared-profile-migration"');
    expect(route).toContain("requireAdmin,\n  requireOwner,");
    expect(route).toContain("req.staffPrincipal!.role");
  });

  it("migrates only missing held fields into the canonical account", async () => {
    const { decideSharedProfileMigration } = await import("./shared-profile-migration");
    const decision = decideSharedProfileMigration(
      {
        userId: "user-1",
        oraPreferredName: "Old local name",
        oraPreferredLanguage: "Español",
        communityDisplayName: "Old community name",
        communityAvatarUrl: null,
      },
      {
        semantics: "shared-account-profile-v1",
        userId: "user-1",
        email: "person@example.com",
        displayName: "Canonical name",
        imageUrl: "https://img.example/profile.png",
        preferredLanguage: null,
        whatIBuild: null,
      },
    );
    expect(decision).toEqual({
      kind: "ready",
      displayName: "Canonical name",
      preferredLanguage: "Español",
      shouldUpdateAccount: true,
    });
  });

  it("keeps a local picture until the owner can migrate it safely", async () => {
    const { decideSharedProfileMigration } = await import("./shared-profile-migration");
    expect(
      decideSharedProfileMigration(
        {
          userId: "user-2",
          oraPreferredName: "Person",
          oraPreferredLanguage: null,
          communityDisplayName: "Person",
          communityAvatarUrl: "https://img.example/legacy.png",
        },
        {
          semantics: "shared-account-profile-v1",
          userId: "user-2",
          email: "person@example.com",
          displayName: "Person",
          imageUrl: null,
          preferredLanguage: null,
          whatIBuild: null,
        },
      ),
    ).toEqual({ kind: "blocked", reason: "picture_needs_owner" });
  });

  it("clears product-local identity only after an apply run records its receipt", () => {
    const migration = source("./shared-profile-migration.ts");
    expect(migration).toContain('if (input.mode === "dry-run")');
    expect(migration).toContain("preferredName: null, preferredLanguage: null");
    expect(migration).toContain("displayName: null, avatarUrl: null");
    expect(migration).toContain("sharedProfileMigrationReceiptsTable");
    expect(migration).toContain(".onConflictDoNothing()");
  });
});
