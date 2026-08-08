import type { PantryStockQueueMessage, PantryWorkerBindings } from "./pantry-catalog-model";
import { PantryCatalogDurableObject } from "./pantry-catalog-durable-object";
import { handlePantryQueue, handlePantryWorkerRequest } from "./pantry-worker";

export { PantryCatalogDurableObject };

export default {
  fetch(request: Request, env: PantryWorkerBindings): Promise<Response> {
    return handlePantryWorkerRequest(request, env);
  },
  queue(batch, env): Promise<void> {
    return handlePantryQueue(batch, env);
  },
} satisfies ExportedHandler<PantryWorkerBindings, PantryStockQueueMessage>;
