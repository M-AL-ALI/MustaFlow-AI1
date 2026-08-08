import { DurableObject } from "cloudflare:workers";
import {
  canonicalPantryJson,
  pantryRevisionTransitionIsValid,
  sha256Hex,
  type PantryCatalogObjectReference,
  type PantryCatalogShelfRecord,
  type PantryCatalogStockRequest,
  type PantryRevisionState,
} from "@workspace/tenant-runtime-contracts";
import type {
  PantryCatalogCoordinator,
  PantryCatalogDiagnostics,
  PantryShelfLookup,
  PantryStockLookup,
  PantryWorkerBindings,
  RemovedPantryShelf,
  StoredPantryAssembly,
} from "./pantry-catalog-model";

function assemblyKey(assemblyId: string): string {
  return `assembly:${assemblyId}`;
}

function stockKey(requestSha256: string): string {
  return `stock:${requestSha256}`;
}

function shelfKey(rootSha256: string): string {
  return `shelf:${rootSha256}`;
}

function shelfStockKey(rootSha256: string): string {
  return `shelf-stock:${rootSha256}`;
}

function lifecycleKey(rootSha256: string): string {
  return `lifecycle:${rootSha256}`;
}

function revisionKey(revisionId: string): string {
  return `revision:${revisionId}`;
}

function objectReferenceKey(sha256: string): string {
  return `object-reference:${sha256}`;
}

async function externalReferenceKey(rootSha256: string, referenceId: string): Promise<string> {
  return `external-reference:${rootSha256}:${await sha256Hex(referenceId)}`;
}

interface StockIndex {
  state: "assembling" | "committed";
  assemblyId: string;
  revisionRootSha256: string | null;
}

function sameObjectReference(
  left: PantryCatalogObjectReference,
  right: PantryCatalogObjectReference,
): boolean {
  return left.kind === right.kind && left.sha256 === right.sha256 && left.bytes === right.bytes;
}

function sameObjectSet(
  left: readonly PantryCatalogObjectReference[],
  right: readonly PantryCatalogObjectReference[],
): boolean {
  return (
    left.length === right.length &&
    left.every((reference, index) => sameObjectReference(reference, right[index]))
  );
}

export class PantryCatalogDurableObject
  extends DurableObject<PantryWorkerBindings>
  implements PantryCatalogCoordinator
{
  async beginStock(request: PantryCatalogStockRequest): Promise<PantryStockLookup> {
    const assemblyId = `passembly_${request.requestSha256}`;
    const result = await this.ctx.storage.transaction(async (transaction) => {
      const index = await transaction.get<StockIndex>(stockKey(request.requestSha256));
      if (index?.state === "committed" && index.revisionRootSha256 !== null) {
        return {
          state: "committed",
          assemblyId: index.assemblyId,
          revisionRootSha256: index.revisionRootSha256,
        } as const;
      }
      const existing = await transaction.get<StoredPantryAssembly>(assemblyKey(assemblyId));
      if (existing !== undefined) {
        if (canonicalPantryJson(existing.request) !== canonicalPantryJson(request)) {
          throw new Error("Pantry assembly hash collision");
        }
        return { state: "assembling", assembly: existing } as const;
      }
      const assembly: StoredPantryAssembly = {
        assemblyId,
        request,
        state: "assembling",
        objects: [],
        expiresAtMs: Date.parse(request.expiresAt),
        queueDeliveries: 0,
      };
      await transaction.put({
        [assemblyKey(assemblyId)]: assembly,
        [stockKey(request.requestSha256)]: {
          state: "assembling",
          assemblyId,
          revisionRootSha256: null,
        } satisfies StockIndex,
      });
      return { state: "created", assembly } as const;
    });
    if (result.state === "created") await this.scheduleCleanup(result.assembly.expiresAtMs);
    return result;
  }

  async markQueueDelivery(assemblyId: string): Promise<"recorded" | "not_found"> {
    return this.ctx.storage.transaction(async (transaction) => {
      const key = assemblyKey(assemblyId);
      const assembly = await transaction.get<StoredPantryAssembly>(key);
      const totalDeliveries = (await transaction.get<number>("queue:deliveries")) ?? 0;
      if (assembly === undefined) {
        await transaction.put("queue:deliveries", totalDeliveries + 1);
        return "not_found" as const;
      }
      assembly.queueDeliveries += 1;
      await transaction.put({
        [key]: assembly,
        "queue:deliveries": totalDeliveries + 1,
      });
      return "recorded" as const;
    });
  }

  async getAssembly(assemblyId: string): Promise<StoredPantryAssembly | null> {
    return (await this.ctx.storage.get<StoredPantryAssembly>(assemblyKey(assemblyId))) ?? null;
  }

  async recordStagedObject(
    assemblyId: string,
    reference: PantryCatalogObjectReference,
  ): Promise<"recorded" | "replay" | "not_found" | "conflict"> {
    return this.ctx.storage.transaction(async (transaction) => {
      const key = assemblyKey(assemblyId);
      const assembly = await transaction.get<StoredPantryAssembly>(key);
      if (assembly === undefined) return "not_found" as const;
      const existing = assembly.objects.find((entry) => entry.sha256 === reference.sha256);
      if (existing !== undefined) {
        return sameObjectReference(existing, reference) ? "replay" : "conflict";
      }
      assembly.objects.push(reference);
      assembly.objects.sort((left, right) => {
        const leftKey = `${left.sha256}\0${left.kind}`;
        const rightKey = `${right.sha256}\0${right.kind}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      });
      await transaction.put(key, assembly);
      return "recorded" as const;
    });
  }

  async commitShelf(
    assemblyId: string,
    shelf: PantryCatalogShelfRecord,
  ): Promise<"committed" | "replay" | "not_found" | "incomplete" | "conflict"> {
    return this.ctx.storage.transaction(async (transaction) => {
      const existingShelf = await transaction.get<PantryCatalogShelfRecord>(
        shelfKey(shelf.revision.rootSha256),
      );
      if (existingShelf !== undefined) {
        return existingShelf.manifestSha256 === shelf.manifestSha256 ? "replay" : "conflict";
      }
      const assembly = await transaction.get<StoredPantryAssembly>(assemblyKey(assemblyId));
      if (assembly === undefined) return "not_found" as const;
      if (!sameObjectSet(assembly.objects, shelf.objectReferences)) return "incomplete" as const;

      const existingRevisionRoot = await transaction.get<string>(
        revisionKey(shelf.revision.content.revisionId),
      );
      if (existingRevisionRoot !== undefined) return "conflict" as const;
      const latestRoot = (await transaction.get<string>("shelf:latest-root")) ?? null;
      if (shelf.revision.content.parentRootSha256 !== latestRoot) return "conflict" as const;

      const puts: Record<string, unknown> = {
        [shelfKey(shelf.revision.rootSha256)]: shelf,
        [lifecycleKey(shelf.revision.rootSha256)]: shelf.state,
        [revisionKey(shelf.revision.content.revisionId)]: shelf.revision.rootSha256,
        "shelf:latest-root": shelf.revision.rootSha256,
        [shelfStockKey(shelf.revision.rootSha256)]: assembly.request.requestSha256,
        [stockKey(assembly.request.requestSha256)]: {
          state: "committed",
          assemblyId,
          revisionRootSha256: shelf.revision.rootSha256,
        } satisfies StockIndex,
      };
      for (const reference of shelf.objectReferences) {
        const key = objectReferenceKey(reference.sha256);
        puts[key] = ((await transaction.get<number>(key)) ?? 0) + 1;
      }
      await transaction.put(puts);
      await transaction.delete(assemblyKey(assemblyId));
      return "committed" as const;
    });
  }

  async getShelfByRoot(rootSha256: string): Promise<PantryShelfLookup | null> {
    const shelf = await this.ctx.storage.get<PantryCatalogShelfRecord>(shelfKey(rootSha256));
    if (shelf === undefined) return null;
    const lifecycle =
      (await this.ctx.storage.get<PantryRevisionState>(lifecycleKey(rootSha256))) ?? shelf.state;
    const externalReferences = await this.countExternalReferences(rootSha256);
    return { shelf, lifecycle, externalReferences };
  }

  async getShelfByRevisionId(revisionId: string): Promise<PantryShelfLookup | null> {
    const root = await this.ctx.storage.get<string>(revisionKey(revisionId));
    return root === undefined ? null : this.getShelfByRoot(root);
  }

  async transitionShelf(
    rootSha256: string,
    expectedStateRevision: number,
    nextState: "quarantined" | "retired",
    updatedAt: string,
  ): Promise<"updated" | "not_found" | "conflict"> {
    return this.ctx.storage.transaction(async (transaction) => {
      const key = lifecycleKey(rootSha256);
      const current = await transaction.get<PantryRevisionState>(key);
      if (current === undefined) return "not_found" as const;
      if (current.stateRevision !== expectedStateRevision) return "conflict" as const;
      const next: PantryRevisionState = {
        ...current,
        state: nextState,
        stateRevision: current.stateRevision + 1,
        updatedAt,
      };
      if (!pantryRevisionTransitionIsValid(current, next)) return "conflict" as const;
      await transaction.put(key, next);
      return "updated" as const;
    });
  }

  async retainShelf(
    rootSha256: string,
    referenceId: string,
  ): Promise<"retained" | "replay" | "not_found"> {
    const key = await externalReferenceKey(rootSha256, referenceId);
    return this.ctx.storage.transaction(async (transaction) => {
      if ((await transaction.get<PantryCatalogShelfRecord>(shelfKey(rootSha256))) === undefined) {
        return "not_found" as const;
      }
      if ((await transaction.get<string>(key)) !== undefined) return "replay" as const;
      await transaction.put(key, referenceId);
      return "retained" as const;
    });
  }

  async releaseShelf(rootSha256: string, referenceId: string): Promise<"released" | "not_found"> {
    const key = await externalReferenceKey(rootSha256, referenceId);
    return this.ctx.storage.transaction(async (transaction) => {
      if ((await transaction.get<string>(key)) === undefined) return "not_found" as const;
      await transaction.delete(key);
      return "released" as const;
    });
  }

  async cleanupExpiredAssemblies(nowMs: number, maxDeletes: number): Promise<string[]> {
    const assemblies = await this.ctx.storage.list<StoredPantryAssembly>({ prefix: "assembly:" });
    const expired = [...assemblies.values()]
      .filter((assembly) => assembly.expiresAtMs <= nowMs)
      .sort((left, right) => left.expiresAtMs - right.expiresAtMs)
      .slice(0, maxDeletes);
    for (const assembly of expired) await this.deleteAssembly(assembly);
    await this.scheduleNextAssemblyAlarm();
    return expired.map((assembly) => assembly.assemblyId);
  }

  async collectRetiredShelf(
    rootSha256: string,
    retentionNamespace: string,
    nowMs: number,
  ): Promise<RemovedPantryShelf | "not_found" | "conflict"> {
    const externalReferences = await this.countExternalReferences(rootSha256);
    if (externalReferences !== 0) return "conflict";
    return this.ctx.storage.transaction(async (transaction) => {
      const shelf = await transaction.get<PantryCatalogShelfRecord>(shelfKey(rootSha256));
      const lifecycle = await transaction.get<PantryRevisionState>(lifecycleKey(rootSha256));
      if (shelf === undefined || lifecycle === undefined) return "not_found" as const;
      if (
        lifecycle.state !== "retired" ||
        shelf.retention.namespace !== retentionNamespace ||
        Date.parse(shelf.retention.retainUntil) > nowMs
      ) {
        return "conflict" as const;
      }
      const unreferencedObjectSha256: string[] = [];
      const requestSha256 = await transaction.get<string>(shelfStockKey(rootSha256));
      const deletes = [
        shelfKey(rootSha256),
        lifecycleKey(rootSha256),
        revisionKey(shelf.revision.content.revisionId),
        shelfStockKey(rootSha256),
      ];
      if (requestSha256 !== undefined) deletes.push(stockKey(requestSha256));
      for (const reference of shelf.objectReferences) {
        const key = objectReferenceKey(reference.sha256);
        const next = ((await transaction.get<number>(key)) ?? 1) - 1;
        if (next <= 0) {
          deletes.push(key);
          unreferencedObjectSha256.push(reference.sha256);
        } else {
          await transaction.put(key, next);
        }
      }
      if ((await transaction.get<string>("shelf:latest-root")) === rootSha256) {
        const parentRoot = shelf.revision.content.parentRootSha256;
        if (
          parentRoot !== null &&
          (await transaction.get<PantryCatalogShelfRecord>(shelfKey(parentRoot))) !== undefined
        ) {
          await transaction.put("shelf:latest-root", parentRoot);
        } else {
          deletes.push("shelf:latest-root");
        }
      }
      await transaction.delete(deletes);
      return { shelf, unreferencedObjectSha256 } satisfies RemovedPantryShelf;
    });
  }

  async diagnostics(): Promise<PantryCatalogDiagnostics> {
    const [assemblies, shelves, objects, references, queueDeliveries] = await Promise.all([
      this.ctx.storage.list<StoredPantryAssembly>({ prefix: "assembly:" }),
      this.ctx.storage.list<PantryCatalogShelfRecord>({ prefix: "shelf:" }),
      this.ctx.storage.list<number>({ prefix: "object-reference:" }),
      this.ctx.storage.list<string>({ prefix: "external-reference:" }),
      this.ctx.storage.get<number>("queue:deliveries"),
    ]);
    return {
      assemblies: assemblies.size,
      shelves: [...shelves.keys()].filter((key) => key !== "shelf:latest-root").length,
      committedObjects: objects.size,
      externalReferences: references.size,
      queueDeliveries: queueDeliveries ?? 0,
    };
  }

  async alarm(): Promise<void> {
    await this.cleanupExpiredAssemblies(Date.now(), 1_000);
  }

  private async countExternalReferences(rootSha256: string): Promise<number> {
    return (await this.ctx.storage.list<string>({ prefix: `external-reference:${rootSha256}:` }))
      .size;
  }

  private async deleteAssembly(assembly: StoredPantryAssembly): Promise<void> {
    for (const reference of assembly.objects) {
      await this.env.PANTRY_CATALOG_OBJECTS.delete(
        `quarantine/${assembly.assemblyId}/objects/${reference.sha256}`,
      );
    }
    await this.ctx.storage.transaction(async (transaction) => {
      const index = await transaction.get<StockIndex>(stockKey(assembly.request.requestSha256));
      await transaction.delete(assemblyKey(assembly.assemblyId));
      if (index?.state === "assembling" && index.assemblyId === assembly.assemblyId) {
        await transaction.delete(stockKey(assembly.request.requestSha256));
      }
    });
  }

  private async scheduleCleanup(expiresAtMs: number): Promise<void> {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || expiresAtMs < alarm) await this.ctx.storage.setAlarm(expiresAtMs);
  }

  private async scheduleNextAssemblyAlarm(): Promise<void> {
    const assemblies = await this.ctx.storage.list<StoredPantryAssembly>({ prefix: "assembly:" });
    const next = [...assemblies.values()].reduce<number | null>(
      (earliest, assembly) =>
        earliest === null || assembly.expiresAtMs < earliest ? assembly.expiresAtMs : earliest,
      null,
    );
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }
}
