import { unlink } from "node:fs/promises";
import { pool } from "@workspace/db";
import { deleteAssetObject } from "./asset-r2";
import { ObjectNotFoundError, ObjectStorageService } from "./objectStorage";

export type TrackedAssetStorageObject = {
  storageBackend: string;
  storageKey: string;
};

/** Delete one durable physical-object receipt; absence is idempotent success. */
export async function deleteTrackedAssetStorageObject(
  object: TrackedAssetStorageObject,
): Promise<void> {
  if (object.storageBackend === "r2") {
    await deleteAssetObject(object.storageKey);
    return;
  }
  if (object.storageBackend === "legacy-object") {
    const storage = new ObjectStorageService();
    try {
      const file = await storage.getObjectEntityFile(object.storageKey);
      await file.delete();
    } catch (error) {
      if (!(error instanceof ObjectNotFoundError)) throw error;
    }
    return;
  }
  if (object.storageBackend === "dev-file") {
    await unlink(object.storageKey).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return;
  }
  // Historical Ora rows stored bytes in Postgres. Their typed storage key is
  // the durable object locator, so deletion must clear the payload rather than
  // merely hiding the Library row and leaving billed database bytes behind.
  if (object.storageBackend === "ora-db") {
    const match = /^ora-db\/([1-9][0-9]*)$/.exec(object.storageKey);
    if (!match) throw new Error("asset_storage_key_invalid");
    await pool.query(`UPDATE ora_assets SET data=NULL WHERE id=$1`, [Number(match[1])]);
    return;
  }
  throw new Error("asset_storage_backend_unavailable");
}

/** Bounded sequential deletion avoids a provider request burst. */
export async function deleteTrackedAssetStorageObjects(
  objects: readonly TrackedAssetStorageObject[],
): Promise<void> {
  for (const object of objects) await deleteTrackedAssetStorageObject(object);
}
