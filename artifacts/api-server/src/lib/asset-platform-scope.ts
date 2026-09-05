import type { ProductScope } from "@workspace/db";

export const EXPLICIT_PROJECT_ASSET_USE_CONSUMER = "explicit-project-use:v1";

export class AssetProductScopeError extends Error {
  readonly code = "asset_not_found";
  readonly status = 404;
  constructor() {
    super("That asset is not available.");
    this.name = "AssetProductScopeError";
  }
}
export function isProductScope(value: unknown): value is ProductScope {
  return value === "nabuflow" || value === "ora";
}
export function requireProductScope(value: unknown): ProductScope {
  if (!isProductScope(value)) throw new AssetProductScopeError();
  return value;
}
export function assertProductScopeNamespace(
  productScope: ProductScope,
  input: { projectId?: number | null; oraProjectId?: number | null },
): void {
  requireProductScope(productScope);
  if (
    (productScope === "ora" && input.projectId != null) ||
    (productScope === "nabuflow" && input.oraProjectId != null)
  )
    throw new AssetProductScopeError();
}
export function isOwnedReadyAssetForProduct(
  asset:
    | { ownerUserId: string; state: string; productScope: ProductScope | null }
    | null
    | undefined,
  userId: string,
  productScope: ProductScope,
): boolean {
  return (
    isProductScope(productScope) &&
    asset?.productScope === productScope &&
    asset.ownerUserId === userId &&
    asset.state === "ready"
  );
}
export function canonicalAssetContentUrl(assetId: number, productScope: ProductScope): string {
  requireProductScope(productScope);
  if (!Number.isSafeInteger(assetId) || assetId < 1) throw new AssetProductScopeError();
  return productScope === "ora"
    ? `/api/ora/canonical-assets/${assetId}/content`
    : `/api/assets/${assetId}/content`;
}
