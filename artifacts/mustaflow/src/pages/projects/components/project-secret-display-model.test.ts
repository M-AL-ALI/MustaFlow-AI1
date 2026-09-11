import { describe, expect, it } from "vitest";
import {
  previewSecretDisposition,
  previewSecretSummary,
  SECRET_NAME_PATTERN,
  type ProjectSecretMetadata,
} from "./project-secret-display-model";
const key = (overrides: Partial<ProjectSecretMetadata> = {}): ProjectSecretMetadata => ({
  id: 1,
  projectId: 101,
  name: "DEMO_KEY",
  environment: "development",
  isPreviewSafe: true,
  minRole: "viewer",
  ...overrides,
});
describe("preview eligibility presentation", () => {
  it.each(["development", "testing"])(
    "allows explicitly enabled viewer-level %s keys",
    (environment) => {
      expect(previewSecretDisposition(key({ environment }), 101)).toEqual({
        eligible: true,
        reason: "Eligible for build and preview",
      });
    },
  );
  it.each(["staging", "production"])(
    "does not call a %s key injected into preview",
    (environment) => {
      expect(previewSecretDisposition(key({ environment }), 101)).toEqual({
        eligible: false,
        reason: "Excluded from build and preview",
      });
    },
  );
  it.each(["member", "admin", "owner"])("excludes a preview-enabled %s-only key", (minRole) => {
    expect(previewSecretDisposition(key({ minRole }), 101)).toEqual({
      eligible: false,
      reason: "Restricted to higher roles",
    });
  });
  it("fails closed for an unknown role policy", () => {
    expect(previewSecretDisposition(key({ minRole: undefined }), 101)).toEqual({
      eligible: false,
      reason: "Role policy not confirmed",
    });
  });
  it("requires explicit preview permission", () => {
    expect(previewSecretDisposition(key({ isPreviewSafe: false }), 101).reason).toBe(
      "Preview access off",
    );
    expect(previewSecretDisposition(key({ isPreviewSafe: undefined }), 101).reason).toBe(
      "Preview access not confirmed",
    );
  });
  it("never includes another project's name in the summary", () => {
    const result = previewSecretSummary(101, [
      key(),
      key({ id: 2, projectId: 102, name: "FOREIGN_KEY" }),
      key({ id: 3, environment: "production" }),
    ]);
    expect(result.eligibleCount).toBe(1);
    expect(result.excludedCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain("FOREIGN_KEY");
  });
  it("does not propagate values or masked values into the eligibility record", () => {
    const secret = { ...key(), value: "not-real-sensitive-data", masked: "do-not-copy" };
    const result = JSON.stringify(previewSecretSummary(101, [secret]));
    expect(result).not.toContain(secret.value);
    expect(result).not.toContain(secret.masked);
  });
  it.each(["KEY", "_KEY_2", "service_key"])("accepts supported variable name %s", (name) => {
    expect(SECRET_NAME_PATTERN.test(name)).toBe(true);
  });
  it.each(["", "2KEY", "KEY-NAME", "KEY NAME", "KEY=VALUE", "KEY\nOTHER"])(
    "rejects unsupported variable name %j",
    (name) => {
      expect(SECRET_NAME_PATTERN.test(name)).toBe(false);
    },
  );
});
