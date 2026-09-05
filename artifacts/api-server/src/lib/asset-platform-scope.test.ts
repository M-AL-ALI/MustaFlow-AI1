import { describe, expect, it, vi } from "vitest";
// These factories run only if the pure policy acquires a runtime dependency.
vi.mock("@workspace/db", () => {
  throw new Error("Pure product policy must not initialize the application database");
});
vi.mock("./project-retirement-contract", () => {
  throw new Error("Pure product policy must not initialize lifecycle infrastructure");
});
vi.mock("drizzle-orm", () => {
  throw new Error("Pure product policy must not initialize ORM dependencies");
});
import {
  assertProductScopeNamespace,
  canonicalAssetContentUrl,
  EXPLICIT_PROJECT_ASSET_USE_CONSUMER,
  isOwnedReadyAssetForProduct,
  isProductScope,
  requireProductScope,
} from "./asset-platform-scope";
import * as productPolicy from "./asset-platform-scope";
describe("immutable product authority", () => {
  it("does not eagerly reexport database grant operations", () => {
    expect("grantExplicitProjectAssetUse" in productPolicy).toBe(false);
    expect("assertExistingProjectAssetUse" in productPolicy).toBe(false);
  });
  it.each([null, undefined, "unknown", "image_studio", "aura", {}, 1])(
    "rejects unproven scope %s",
    (value) => {
      expect(isProductScope(value)).toBe(false);
      expect(() => requireProductScope(value)).toThrow();
    },
  );
  it.each(["nabuflow", "ora"] as const)("accepts only the known scope %s", (scope) => {
    expect(requireProductScope(scope)).toBe(scope);
  });
  it("does not equate same-account ownership with same-product authority", () => {
    const asset = { ownerUserId: "owner", state: "ready", productScope: "ora" as const };
    expect(isOwnedReadyAssetForProduct(asset, "owner", "nabuflow")).toBe(false);
    expect(isOwnedReadyAssetForProduct(asset, "owner", "ora")).toBe(true);
    expect(isOwnedReadyAssetForProduct({ ...asset, productScope: null }, "owner", "ora")).toBe(
      false,
    );
    expect(isOwnedReadyAssetForProduct({ ...asset, state: "deleting" }, "owner", "ora")).toBe(
      false,
    );
    expect(isOwnedReadyAssetForProduct(asset, "other", "ora")).toBe(false);
  });
  it("rejects crossing project namespaces, regardless of a claimed origin", () => {
    expect(() => assertProductScopeNamespace("ora", { projectId: 51 })).toThrow();
    expect(() => assertProductScopeNamespace("nabuflow", { oraProjectId: 51 })).toThrow();
    expect(() => assertProductScopeNamespace("ora", { oraProjectId: 51 })).not.toThrow();
    expect(() => assertProductScopeNamespace("nabuflow", { projectId: 51 })).not.toThrow();
  });
  it("emits distinct canonical-ID routes, never library-ID or raw-key aliases", () => {
    expect(canonicalAssetContentUrl(17, "nabuflow")).toBe("/api/assets/17/content");
    expect(canonicalAssetContentUrl(17, "ora")).toBe("/api/ora/canonical-assets/17/content");
    expect(() => canonicalAssetContentUrl(0, "ora")).toThrow();
    expect(() => canonicalAssetContentUrl(17, null as never)).toThrow();
  });
  it("keeps explicit reuse distinct from all automatic history consumers", () => {
    expect(EXPLICIT_PROJECT_ASSET_USE_CONSUMER).toBe("explicit-project-use:v1");
    expect(EXPLICIT_PROJECT_ASSET_USE_CONSUMER).not.toBe("project-asset-history");
    expect(EXPLICIT_PROJECT_ASSET_USE_CONSUMER).not.toBe("project-file");
  });
});
