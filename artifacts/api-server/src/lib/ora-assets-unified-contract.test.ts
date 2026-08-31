import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const oraAssets = readFileSync(path.join(here, "ora-assets.ts"), "utf8");
const assetRegistry = readFileSync(path.join(here, "asset-registry.ts"), "utf8");
const uploadRoute = readFileSync(path.join(here, "../routes/public-ai/upload.ts"), "utf8");
const chatRoute = readFileSync(path.join(here, "../routes/public-ai/chat.ts"), "utf8");
const generateFileRoute = readFileSync(
  path.join(here, "../routes/public-ai/generate-file.ts"),
  "utf8",
);
const imageJobs = readFileSync(path.join(here, "image-generation-jobs.ts"), "utf8");
const realtimeTools = readFileSync(path.join(here, "public-ai/realtime-tools.ts"), "utf8");
const retention = readFileSync(path.join(here, "ora-assets-retention.ts"), "utf8");
const cleanup = readFileSync(path.join(here, "asset-storage-cleanup.ts"), "utf8");
const migration = readFileSync(path.join(here, "startup-migrations.ts"), "utf8");
const oraChatHook = readFileSync(
  path.join(here, "../../../mustaflow/src/hooks/use-ora-chat.ts"),
  "utf8",
);
const accountAssetUpload = readFileSync(
  path.join(here, "../../../mustaflow/src/lib/asset-upload.ts"),
  "utf8",
);

describe("Ora uses the account-wide asset boundary", () => {
  it("has no Ora-only 200 MB allowance or DB fallback for new bytes", () => {
    expect(oraAssets).toContain("PER_USER_STORAGE_BYTES = 500 * 1024 * 1024");
    expect(oraAssets).not.toMatch(/200\s*\*\s*1024\s*\*\s*1024/);
    expect(oraAssets).toContain("reserveAsset({");
    expect(oraAssets).toContain("beginAssetUpload({");
    expect(oraAssets).toContain("putAssetBuffer({");
    expect(oraAssets).toContain("completeAsset({");
  });

  it("links already-ready generated images without fetching or writing a second object", () => {
    expect(chatRoute).toContain("unifiedAssetId: pendingEditableAsset.id");
    expect(imageJobs.match(/unifiedAssetId: assetId/g)).toHaveLength(2);
    expect(chatRoute).not.toContain(
      "Persist to the durable asset library (best-effort, after the response",
    );
    expect(realtimeTools).toContain("completeOraGeneratedAsset({");
    expect(realtimeTools).not.toContain("persistOraAssetStrict({");
  });

  it("awaits signed-in upload admission and returns typed storage failures", () => {
    expect(uploadRoute).toContain("await persistOraAssetStrict({");
    expect(uploadRoute).toContain("await persistUploadMirrors({");
    expect(uploadRoute).toContain("error instanceof AssetAdmissionError");
    expect(uploadRoute).not.toContain("persistUploadMirrorsBestEffort");
  });

  it("streams the active signed-in chat upload and attaches only its asset id", () => {
    const signedPath = oraChatHook.slice(
      oraChatHook.indexOf("if (isSignedIn) {", oraChatHook.indexOf("const uploadProjectId")),
      oraChatHook.indexOf("} else {", oraChatHook.indexOf("const uploadProjectId")),
    );
    expect(signedPath).toContain("await uploadAccountAsset({");
    expect(signedPath).toContain("`${BASE}/api/public-ai/upload/attach`");
    expect(signedPath).not.toContain("new FormData()");
    expect(signedPath).not.toContain("MAX_FILE_SIZE");
    expect(signedPath).not.toContain("MAX_IMAGE_SIZE");
    expect(accountAssetUpload.indexOf("authFetch(reservePath")).toBeLessThan(
      accountAssetUpload.indexOf("await putWithProgress({"),
    );
    expect(accountAssetUpload).toContain("sizeBytes: prepared.body.size");
    expect(uploadRoute).toContain('router.post("/public-ai/upload/attach"');
    expect(uploadRoute).toContain("asset.sizeBytes > MAX_INLINE_ASSET_ANALYSIS_BYTES");
    expect(uploadRoute).toContain('code: "asset_analysis_unavailable"');
    expect(uploadRoute).toContain("Failed to read saved asset for chat analysis");
    const legacyMultipart = uploadRoute.slice(uploadRoute.indexOf('"/public-ai/upload",'));
    expect(legacyMultipart).toContain('code: "asset_stream_upload_required"');
    expect(legacyMultipart.indexOf('code: "asset_stream_upload_required"')).toBeLessThan(
      legacyMultipart.indexOf("oraUploadLimiter"),
    );
  });

  it("preflights every signed-in generated file/image path against aggregate quota", () => {
    expect(chatRoute.match(/reserveOraGeneratedAsset\(\{/g)).toHaveLength(3);
    expect(chatRoute.match(/completeOraGeneratedAsset\(\{/g)).toHaveLength(2);
    expect(
      generateFileRoute.indexOf("fileReservation = await reserveOraGeneratedAsset({"),
    ).toBeLessThan(generateFileRoute.indexOf("await fileBuilder.generateFileFromPrompt("));

    const realtimeFile = realtimeTools.slice(
      realtimeTools.indexOf("async function executeFileGeneration"),
      realtimeTools.indexOf("async function executeImageGeneration"),
    );
    expect(realtimeFile.indexOf("reservation = await reserveOraGeneratedAsset({")).toBeLessThan(
      realtimeFile.indexOf("await generateFileFromPrompt("),
    );
    const realtimeImage = realtimeTools.slice(
      realtimeTools.indexOf("async function executeImageGeneration"),
    );
    expect(realtimeImage.indexOf("reservation = await reserveOraGeneratedAsset({")).toBeLessThan(
      realtimeImage.indexOf("const result = await generateImage({"),
    );
    expect(realtimeImage).not.toMatch(/32\s*\*\s*1024\s*\*\s*1024/);
    expect(assetRegistry).toContain("sizeBytes: Math.max(1, availableBytes)");
  });

  it("preflights both durable background image paths without a fixed-size guess", () => {
    expect(imageJobs.match(/reserveAssetAgainstAvailableQuota\(\{/g)).toHaveLength(2);
    expect(imageJobs).not.toContain("GENERATED_ASSET_RESERVATION_BYTES");
    expect(imageJobs).not.toMatch(/8\s*\*\s*1024\s*\*\s*1024/);
    expect(imageJobs.indexOf('source: "image-generation"')).toBeLessThan(
      imageJobs.indexOf("await deductCreditsAtomic(userId, creditCost"),
    );
    expect(imageJobs.indexOf('source: "image-edit"')).toBeLessThan(
      imageJobs.indexOf("description: `Image edit"),
    );
  });

  it("adopts historical Ora rows without copying bytes", () => {
    expect(migration).toContain("ALTER TABLE ora_assets ADD COLUMN IF NOT EXISTS asset_id INTEGER");
    expect(migration).toContain("'ora-library-legacy'");
    expect(migration).toContain("'ora-library:' || ora.id::text");
  });

  it("routes deletion and retention through the durable cleanup mechanism", () => {
    expect(oraAssets).toContain("deleteTrackedAssetStorageObjects(pending.storageObjects)");
    expect(oraAssets).toContain("recordAssetDeleted({");
    expect(retention).toContain("await deleteOraAsset({");
    expect(retention).not.toContain(".update(oraAssetsTable)");
    expect(cleanup).toContain("UPDATE ora_assets SET data=NULL WHERE id=$1");
    expect(oraAssets).toContain("WHERE ticket.user_id=ora.user_id");
  });
});
