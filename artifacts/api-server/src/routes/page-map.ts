import { Router, type IRouter, type RequestHandler } from "express";
import { requireProjectOwnership } from "../lib/auth";
import { extractPageMapForFiles, type PageMapData } from "../lib/page-map";
import { pageMapRepository, type PageMapRepository } from "../lib/page-map-repository";
import {
  pageMapUpdateSchema,
  parseStoredPageMap,
  PageMapAnalysisValidationError,
} from "../lib/page-map-validation";
import { pageMapRevision } from "../lib/page-map-revision";
import { reconcilePageMapPlatformUpdate } from "../lib/page-map-transition";
import {
  requireActiveProjectLifecycleSession,
  holdResponseProjectLifecycleSession,
} from "../lib/project-lifecycle";

const conflictMessage =
  "The app or map changed during this operation. Refresh the map before trying again.";

function withLifecycleHold(handler: RequestHandler): RequestHandler {
  return async (req, res, next) => {
    const release = holdResponseProjectLifecycleSession(res);
    try {
      await handler(req, res, next);
    } finally {
      await release();
    }
  };
}

export function createPageMapRouter(
  repository: PageMapRepository = pageMapRepository,
  ownership: RequestHandler = requireProjectOwnership,
): IRouter {
  const router: IRouter = Router();
  // Express has already decoded the parameter. Reject aliases before the shared
  // ownership middleware and every repository operation can interpret it differently.
  router.param("id", (_req, res, next, value: string) => {
    const id = Number(value);
    if (!/^[0-9]+$/.test(value) || !Number.isInteger(id) || id < 1 || id > 2147483647) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    next();
  });
  router.get("/projects/:id/page-map", ownership, async (req, res): Promise<void> => {
    const project = await repository.read(Number(req.params.id));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.json({
      pageMapData: parseStoredPageMap(project.pageMapData),
      revision: pageMapRevision(project.pageMapData),
    });
  });
  router.put(
    "/projects/:id/page-map",
    ownership,
    requireActiveProjectLifecycleSession,
    withLifecycleHold(async (req, res): Promise<void> => {
      const parsed = pageMapUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid page map payload" });
        return;
      }
      const projectId = Number(req.params.id);
      const project = await repository.read(projectId);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      if (parsed.data.expectedRevision !== pageMapRevision(project.pageMapData)) {
        res.status(409).json({ error: conflictMessage });
        return;
      }
      const current = parseStoredPageMap(project.pageMapData);
      const merged: PageMapData = {
        web: reconcilePageMapPlatformUpdate(current.web, parsed.data.web),
        ios: reconcilePageMapPlatformUpdate(current.ios, parsed.data.ios),
        android: reconcilePageMapPlatformUpdate(current.android, parsed.data.android),
      };
      if (!(await repository.write(projectId, merged, project.pageMapData))) {
        res.status(409).json({ error: conflictMessage });
        return;
      }
      req.log.info({ projectId }, "Page map updated");
      res.json({ pageMapData: merged, revision: pageMapRevision(merged) });
    }),
  );
  router.post(
    "/projects/:id/page-map/analyze",
    ownership,
    requireActiveProjectLifecycleSession,
    withLifecycleHold(async (req, res): Promise<void> => {
      const projectId = Number(req.params.id);
      const platform = req.query.platform ?? "web";
      if (platform !== "web" && platform !== "ios" && platform !== "android") {
        res.status(400).json({ error: "platform must be web, ios, or android" });
        return;
      }
      const project = await repository.read(projectId);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      const current = parseStoredPageMap(project.pageMapData);
      const snapshot = await repository.readFiles(projectId);
      let updated;
      try {
        updated = await extractPageMapForFiles(snapshot.files, platform, current[platform]);
      } catch (error) {
        if (!(error instanceof PageMapAnalysisValidationError)) throw error;
        res.status(422).json({
          error:
            "This analysis exceeds the supported map limits or has conflicting page identities. Your saved map was not changed.",
        });
        return;
      }
      const next: PageMapData = { ...current, [platform]: updated };
      if (!(await repository.write(projectId, next, project.pageMapData, snapshot.revision))) {
        res.status(409).json({ error: conflictMessage });
        return;
      }
      req.log.info({ projectId, platform, nodeCount: updated.nodes.length }, "Page map analyzed");
      res.json({ pageMapData: next, revision: pageMapRevision(next) });
    }),
  );
  return router;
}
export default createPageMapRouter();
