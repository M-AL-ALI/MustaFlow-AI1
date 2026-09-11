import { describe, expect, it } from "vitest";
import {
  MOBILE_MODULES,
  missingModuleSecrets,
  moduleRequestText,
  moduleSecretNames,
  type ModuleSecret,
} from "./module-library-model";
const db = MOBILE_MODULES.find((mod) => mod.id === "realtime-db")!;
const key = (name: string, overrides: Partial<ModuleSecret> = {}): ModuleSecret => ({
  id: 1,
  projectId: 101,
  name,
  environment: "development",
  isPreviewSafe: true,
  ...overrides,
});
describe("module prerequisites and request contracts", () => {
  it("preserves all eight existing module providers", () => {
    expect(MOBILE_MODULES.map((mod) => [mod.id, mod.provider])).toEqual([
      ["auth", "Clerk"],
      ["payments", "RevenueCat"],
      ["push", "Expo Notifications"],
      ["realtime-db", "Supabase"],
      ["analytics", "Amplitude"],
      ["deep-links", "Expo Linking"],
      ["offline", "AsyncStorage + SQLite"],
      ["camera-media", "Expo Camera"],
    ]);
  });
  it("requires every database key, not just the first successful save", () => {
    expect(missingModuleSecrets(db, 101, [])).toEqual(["SUPABASE_URL", "SUPABASE_ANON_KEY"]);
    expect(missingModuleSecrets(db, 101, [key("SUPABASE_URL")])).toEqual(["SUPABASE_ANON_KEY"]);
    expect(
      missingModuleSecrets(
        db,
        101,
        db.requiredSecrets.map((name) => key(name)),
      ),
    ).toEqual([]);
  });
  it.each(["production", "testing", "staging"] as const)(
    "does not substitute a %s key",
    (environment) => {
      expect(moduleSecretNames(101, [key("SUPABASE_URL", { environment })]).size).toBe(0);
    },
  );
  it.each([false, undefined])(
    "does not assume a key with preview safety %s is available",
    (isPreviewSafe) => {
      expect(moduleSecretNames(101, [key("SUPABASE_URL", { isPreviewSafe })]).size).toBe(0);
    },
  );
  it("rejects metadata from another project and unrelated key names", () => {
    expect(
      missingModuleSecrets(db, 101, [key("SUPABASE_URL", { projectId: 102 }), key("OTHER_KEY")]),
    ).toEqual(db.requiredSecrets);
  });
  it("handles modules without keys without requiring an invented credential", () => {
    expect(missingModuleSecrets(MOBILE_MODULES.find((mod) => mod.id === "push")!, 101, [])).toEqual(
      [],
    );
  });
  it("uses exact names in a development-only setup request and demands evidence", () => {
    const text = moduleRequestText(db, "setup");
    for (const name of db.requiredSecrets) expect(text).toContain(name);
    expect(text).toContain("never print their values");
    expect(text).toContain("Do not claim the integration works");
    expect(text).toContain("all required keys");
  });
  it("keeps removal scoped to app code and exclusive dependencies", () => {
    const text = moduleRequestText(db, "remove");
    expect(text).toContain(
      "Preserve provider accounts, purchased services, databases, and stored secrets",
    );
    expect(text).toContain("keep shared code and dependencies");
  });
  it("asks for non-destructive verification rather than fabricating a verified badge", () => {
    const text = moduleRequestText(db, "check");
    expect(text).toContain("non-destructive");
    expect(text).toContain("Do not expose secret values, spend money, or send real notifications");
    expect(text).toContain("anything untested");
  });
});
