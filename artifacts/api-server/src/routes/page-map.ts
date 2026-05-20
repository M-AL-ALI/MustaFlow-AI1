import { Router, type IRouter } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, projectsTable, projectFilesTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import {
  extractPageMapForFiles,
  type PageMapData,
  type PageMapPlatform,
  EMPTY_PAGE_MAP,
} from "../lib/page-map";

const router: IRouter = Router();

const activeProjects = isNull(projectsTable.deletedAt);

function parseMapData(raw: unknown): PageMapData {
  if (!raw || typeof raw !== "object") return EMPTY_PAGE_MAP;
  const r = raw as Record<string, unknown>;
  const parsePlatform = (p: unknown): PageMapPlatform => {
    if (!p || typeof p !== "object") return { nodes: [], edges: [] };
    const pl = p as Record<string, unknown>;
    return {
      nodes: Array.isArray(pl.nodes) ? (pl.nodes as PageMapPlatform["nodes"]) : [],
      edges: Array.isArray(pl.edges) ? (pl.edges as PageMapPlatform["edges"]) : [],
    };
  };
  return {
    web: parsePlatform(r.web),
    ios: parsePlatform(r.ios),
    android: parsePlatform(r.android),
  };
}

router.get("/projects/:id/page-map", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);

  const [project] = await db
    .select({ pageMapData: projectsTable.pageMapData })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), activeProjects));

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const mapData = parseMapData(project.pageMapData);
  res.json({ pageMapData: mapData });
});

router.put("/projects/:id/page-map", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);

  const body = req.body as Partial<PageMapData>;
  if (!body || typeof body !== "object") {
    res.status(400).json({ error: "Invalid page map payload" });
    return;
  }

  const [existing] = await db
    .select({ pageMapData: projectsTable.pageMapData })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), activeProjects));

  if (!existing) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const current = parseMapData(existing.pageMapData);
  const merged: PageMapData = {
    web: body.web ?? current.web,
    ios: body.ios ?? current.ios,
    android: body.android ?? current.android,
  };

  await db
    .update(projectsTable)
    .set({ pageMapData: merged as unknown as Record<string, unknown>, updatedAt: sql`now()` })
    .where(and(eq(projectsTable.id, projectId), activeProjects));

  req.log.info({ projectId }, "Page map updated");
  res.json({ pageMapData: merged });
});

router.post(
  "/projects/:id/page-map/analyze",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const platform = (req.query.platform as string) ?? "web";

    if (!["web", "ios", "android"].includes(platform)) {
      res.status(400).json({ error: "platform must be web, ios, or android" });
      return;
    }

    const [project] = await db
      .select({ pageMapData: projectsTable.pageMapData })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), activeProjects));

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const currentMapData = parseMapData(project.pageMapData);
    const existingPlatform = currentMapData[platform as "web" | "ios" | "android"];

    const files = await db
      .select()
      .from(projectFilesTable)
      .where(eq(projectFilesTable.projectId, projectId));

    const builderFiles = files.map((f) => ({
      path: f.path,
      content: f.content,
      mimeType: f.mimeType,
    }));

    req.log.info({ projectId, platform, fileCount: files.length }, "Analyzing page map");

    const updatedPlatform = await extractPageMapForFiles(
      builderFiles,
      platform as "web" | "ios" | "android",
      existingPlatform,
    );

    const newMapData: PageMapData = {
      ...currentMapData,
      [platform]: updatedPlatform,
    };

    await db
      .update(projectsTable)
      .set({ pageMapData: newMapData as unknown as Record<string, unknown>, updatedAt: sql`now()` })
      .where(and(eq(projectsTable.id, projectId), activeProjects));

    req.log.info(
      { projectId, platform, nodeCount: updatedPlatform.nodes.length },
      "Page map analyzed",
    );
    res.json({ pageMapData: newMapData });
  },
);

export default router;
