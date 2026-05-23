import { eq } from "drizzle-orm";
import { db, projectsTable, projectFilesTable } from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "./logger";
import type { BuilderFile } from "./builder";

export type PageType =
  | "landing"
  | "auth"
  | "form"
  | "dashboard"
  | "modal"
  | "settings"
  | "404"
  | "tab-bar"
  | "drawer"
  | "sheet"
  | "list"
  | "detail"
  | "other";

export type ConnectionType = "nav" | "auth-gate" | "redirect" | "external";

export type PageMapNode = {
  id: string;
  label: string;
  pageType: PageType;
  filePath: string;
  position: { x: number; y: number };
  isNew: boolean;
  hasError: boolean;
  aiGenerated: boolean;
  notes: string;
  planned?: boolean;
};

export type PageMapEdge = {
  id: string;
  source: string;
  target: string;
  connectionType: ConnectionType;
  aiGenerated: boolean;
};

export type PageMapPlatform = {
  nodes: PageMapNode[];
  edges: PageMapEdge[];
};

export type PageMapData = {
  web: PageMapPlatform;
  ios: PageMapPlatform;
  android: PageMapPlatform;
};

const EMPTY_PLATFORM: PageMapPlatform = { nodes: [], edges: [] };
export const EMPTY_PAGE_MAP: PageMapData = {
  web: EMPTY_PLATFORM,
  ios: EMPTY_PLATFORM,
  android: EMPTY_PLATFORM,
};

const PAGE_MAP_SYSTEM_PROMPT = `You are a web app page structure analyzer. Given a set of HTML/JS files, extract the complete page and navigation map. Return STRICT JSON only — no prose, no markdown.

OUTPUT SCHEMA:
{
  "nodes": [
    {
      "id": "page-<slug>",
      "label": "Human-readable page name",
      "pageType": "landing|auth|form|dashboard|modal|settings|404|tab-bar|drawer|sheet|list|detail|other",
      "filePath": "path/to/file.html",
      "notes": "Brief description of what this page does"
    }
  ],
  "edges": [
    {
      "id": "edge-<source>-<target>",
      "source": "page-<slug>",
      "target": "page-<slug>",
      "connectionType": "nav|auth-gate|redirect|external"
    }
  ]
}

Rules:
- Each HTML file is typically one page/node. 
- Detect links (<a href="...">) and JS navigation (window.location, history.pushState) for edges.
- connectionType: "nav" for normal links, "auth-gate" if the source requires login to reach target, "redirect" for meta-refresh or JS redirect, "external" for links to different domains.
- pageType: detect from content — "landing" for hero/marketing pages, "auth" for login/signup, "form" for data-entry, "dashboard" for stats/charts, "404" for error pages, "settings" for config, "modal" for overlay pages, otherwise "other".
- Use concise, user-friendly labels (not file paths).
- id format: "page-" + slugified filename (without extension).
- edge id: "edge-" + source-id + "-" + target-id.
- Only include nodes for actual pages (not CSS/JS/image files).
- If you detect no navigation between pages, return an empty edges array.`;

// ---------------------------------------------------------------------------
// Static (deterministic) link extraction.
//
// The AI pass is fuzzy and only sees the first 3000 chars of each file. This
// helper scans the FULL text of every HTML/JS file with simple regexes to
// recover navigation links the model might have missed:
//   - <a href="...">
//   - <form action="...">
//   - window.location[.href|.assign|.replace](...)
//   - location.href = "..."
//   - history.pushState(..., "...")
//
// Returns edges keyed to existing AI node IDs (by filePath). Same-pair edges
// are deduped against the AI edges in the caller. The static edges are still
// marked aiGenerated=true so user-drawn (manual) edges are preserved during
// merge — the distinction matters only for user-vs-machine ownership, not
// for which extractor produced them.
// ---------------------------------------------------------------------------
// Normalize a path: strip leading "./" or "/", collapse "..": resolve against
// the source directory so "../about.html" from "blog/post.html" → "about.html".
// Exported for unit tests.
export function normalizePath(p: string): string {
  const parts = p.replace(/^\/+/, "").split("/");
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return out.join("/");
}

// Exported for unit tests.
export function extractStaticEdges(files: BuilderFile[], nodes: PageMapNode[]): PageMapEdge[] {
  // Index of normalized full path → node id, plus a basename → node id index
  // used only as a fallback when the resolved relative path doesn't match.
  // Basename fallback skips collisions (multiple files with the same name in
  // different dirs) to avoid wrong attributions.
  const fullPathToNodeId = new Map<string, string>();
  const basenameCounts = new Map<string, number>();
  const basenameToNodeId = new Map<string, string>();
  for (const n of nodes) {
    if (!n.filePath) continue;
    const normalized = normalizePath(n.filePath);
    fullPathToNodeId.set(normalized, n.id);
    const basename = normalized.split("/").pop() ?? "";
    if (basename) {
      basenameCounts.set(basename, (basenameCounts.get(basename) ?? 0) + 1);
      basenameToNodeId.set(basename, n.id);
    }
  }
  // Drop ambiguous basenames so we don't misroute.
  for (const [name, count] of basenameCounts) {
    if (count > 1) basenameToNodeId.delete(name);
  }

  const resolveTarget = (raw: string, sourceDir: string): string | null => {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    // Skip anchors, schemes, absolute / protocol-relative URLs.
    if (
      trimmed.startsWith("#") ||
      trimmed.startsWith("mailto:") ||
      trimmed.startsWith("tel:") ||
      trimmed.startsWith("javascript:") ||
      /^https?:\/\//i.test(trimmed) ||
      /^\/\//.test(trimmed)
    ) {
      return null;
    }
    // Strip query/hash before resolution.
    const cleaned = trimmed.split(/[?#]/)[0];
    if (!cleaned) return null;
    // Resolve relative paths against the source file's directory.
    const resolved = cleaned.startsWith("/")
      ? normalizePath(cleaned)
      : normalizePath(sourceDir ? `${sourceDir}/${cleaned}` : cleaned);
    if (fullPathToNodeId.has(resolved)) return fullPathToNodeId.get(resolved)!;
    // Fallback: try basename (only when unambiguous).
    const basename = resolved.split("/").pop() ?? "";
    return basenameToNodeId.get(basename) ?? null;
  };

  const seen = new Set<string>(); // dedupe pairs within static pass
  const out: PageMapEdge[] = [];

  // Patterns are intentionally tolerant: single or double quotes, optional
  // whitespace, common forms only. We're augmenting, not replacing, the AI pass.
  const HREF_RE = /href\s*=\s*["']([^"'#][^"']*)["']/gi;
  const ACTION_RE = /action\s*=\s*["']([^"'#][^"']*)["']/gi;
  const LOC_RE =
    /(?:window\.)?location(?:\.href|\.assign|\.replace)?\s*(?:=|\(\s*)\s*["']([^"']+)["']/gi;
  const PUSHSTATE_RE = /history\.pushState\s*\([^,]*,[^,]*,\s*["']([^"']+)["']/gi;

  for (const f of files) {
    const sourceFilePath = normalizePath(f.path);
    const sourceNodeId = fullPathToNodeId.get(sourceFilePath);
    // We only emit edges whose source is itself a mapped page. Inline <script>
    // blocks inside HTML pages are picked up here automatically because we
    // scan the full file text. External .js files are not scanned: their
    // navigation can't be attributed to a single source page reliably.
    if (!sourceNodeId) continue;
    const sourceDir = sourceFilePath.includes("/")
      ? sourceFilePath.slice(0, sourceFilePath.lastIndexOf("/"))
      : "";

    const text = f.content;
    const candidates: string[] = [];
    for (const re of [HREF_RE, ACTION_RE, LOC_RE, PUSHSTATE_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (m[1]) candidates.push(m[1]);
      }
    }

    for (const raw of candidates) {
      const targetId = resolveTarget(raw, sourceDir);
      if (!targetId || targetId === sourceNodeId) continue;
      const key = `${sourceNodeId}->${targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: `edge-static-${sourceNodeId}-${targetId}`,
        source: sourceNodeId,
        target: targetId,
        connectionType: "nav",
        aiGenerated: true,
      });
    }
  }

  return out;
}

function buildAutoLayout(nodes: PageMapNode[]): PageMapNode[] {
  const COLS = 3;
  const X_STEP = 280;
  const Y_STEP = 180;
  return nodes.map((node, idx) => ({
    ...node,
    position: {
      x: 80 + (idx % COLS) * X_STEP,
      y: 80 + Math.floor(idx / COLS) * Y_STEP,
    },
  }));
}

function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function mergeWithExisting(
  aiNodes: PageMapNode[],
  aiEdges: PageMapEdge[],
  existing: PageMapPlatform,
): PageMapPlatform {
  const existingById = new Map(existing.nodes.map((n) => [n.id, n]));

  // Build a normalized-label index of AI nodes for planned-to-built matching
  const aiNodesByLabel = new Map(aiNodes.map((n) => [normalizeLabel(n.label), n]));

  // Preserve user-customised positions and notes on AI nodes (matched by ID)
  const mergedAiNodes = aiNodes.map((n) => {
    const prev = existingById.get(n.id);
    return {
      ...n,
      position: prev?.position ?? n.position,
      notes: prev?.notes ?? n.notes,
      aiGenerated: true,
      planned: false, // AI confirmed the file exists — no longer planned
    };
  });

  // Retain planned nodes only when no AI node matches by ID or normalized label.
  // When a planned node's label matches an AI node, the AI node absorbs its
  // position and notes via the ID map above (if IDs match) or it is simply
  // retired here (if only the label matched) — the built AI node replaces it.
  const aiNodeIds = new Set(aiNodes.map((n) => n.id));
  const plannedNodes = existing.nodes.filter((n) => {
    if (!n.planned) return false;
    if (aiNodeIds.has(n.id)) return false; // matched by ID — AI node absorbs it
    const aiMatch = aiNodesByLabel.get(normalizeLabel(n.label));
    if (aiMatch) {
      // Transfer position and notes to the matched AI node
      const idx = mergedAiNodes.findIndex((m) => m.id === aiMatch.id);
      if (idx !== -1) {
        mergedAiNodes[idx] = {
          ...mergedAiNodes[idx],
          position: n.position,
          notes: n.notes || mergedAiNodes[idx].notes,
        };
      }
      return false; // retire the planned placeholder
    }
    return true; // no match — keep as planned
  });

  const nodes = [...mergedAiNodes, ...plannedNodes];

  const aiEdgeIds = new Set(aiEdges.map((e) => e.id));
  const userEdges = existing.edges.filter((e) => !e.aiGenerated && !aiEdgeIds.has(e.id));

  const edges = [...aiEdges.map((e) => ({ ...e, aiGenerated: true })), ...userEdges];

  return { nodes, edges };
}

/**
 * DB-aware wrapper: loads current project files + existing page map from DB,
 * runs AI extraction for the "web" platform, and persists the result back.
 * Fire-and-forget safe — any errors are caught internally.
 */
export async function extractPageMap(projectId: number): Promise<void> {
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
  if (!project) return;

  const fileRows = await db
    .select()
    .from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, projectId));

  const files: BuilderFile[] = fileRows.map((r) => ({
    path: r.path,
    content: r.content,
    mimeType: r.mimeType ?? "text/plain",
  }));

  const existingMap = (project.pageMapData as PageMapData | null) ?? EMPTY_PAGE_MAP;

  const webPlatform = await extractPageMapForFiles(files, "web", existingMap.web);

  const updatedMap: PageMapData = { ...existingMap, web: webPlatform };

  await db
    .update(projectsTable)
    .set({ pageMapData: updatedMap })
    .where(eq(projectsTable.id, projectId));

  logger.info(
    { projectId, nodeCount: webPlatform.nodes.length },
    "Page map extracted and persisted",
  );
}

/**
 * Core AI extraction logic. Public so the analyze API route can call it directly.
 */
export async function extractPageMapForFiles(
  files: BuilderFile[],
  platform: "web" | "ios" | "android",
  existingMap?: PageMapPlatform,
): Promise<PageMapPlatform> {
  if (platform !== "web") {
    return existingMap ?? EMPTY_PLATFORM;
  }

  const pageFiles = files.filter(
    (f) => f.mimeType === "text/html" || f.path.endsWith(".html") || f.path === "index.html",
  );

  if (pageFiles.length === 0) {
    return existingMap ?? EMPTY_PLATFORM;
  }

  const manifest = pageFiles
    .map(
      (f) =>
        `--- ${f.path} ---\n${f.content.slice(0, 3000)}${f.content.length > 3000 ? "\n...(truncated)" : ""}`,
    )
    .join("\n\n");

  const messages: Array<{ role: "system" | "user"; content: string }> = [
    { role: "system", content: PAGE_MAP_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Analyze these ${pageFiles.length} page file(s) and return the page map:\n\n${manifest}`,
    },
  ];

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-5-mini",
      max_completion_tokens: 4000,
      messages,
      response_format: { type: "json_object" },
    });

    const raw = response.choices[0]?.message?.content?.trim() ?? "{}";
    const parsed = JSON.parse(raw) as {
      nodes?: Array<{
        id: string;
        label: string;
        pageType: string;
        filePath: string;
        notes: string;
      }>;
      edges?: Array<{
        id: string;
        source: string;
        target: string;
        connectionType: string;
      }>;
    };

    const rawNodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
    const rawEdges = Array.isArray(parsed.edges) ? parsed.edges : [];

    const aiNodes: PageMapNode[] = buildAutoLayout(
      rawNodes
        .filter(
          (n) =>
            typeof n.id === "string" &&
            typeof n.label === "string" &&
            typeof n.filePath === "string",
        )
        .map((n) => ({
          id: n.id,
          label: n.label,
          pageType: (n.pageType as PageType) ?? "other",
          filePath: n.filePath,
          position: { x: 0, y: 0 },
          isNew: false,
          hasError: false,
          aiGenerated: true,
          notes: n.notes ?? "",
        })),
    );

    const nodeIds = new Set(aiNodes.map((n) => n.id));
    const aiEdges: PageMapEdge[] = rawEdges
      .filter(
        (e) =>
          typeof e.id === "string" &&
          typeof e.source === "string" &&
          typeof e.target === "string" &&
          nodeIds.has(e.source) &&
          nodeIds.has(e.target),
      )
      .map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        connectionType: (e.connectionType as ConnectionType) ?? "nav",
        aiGenerated: true,
      }));

    // Augment AI edges with a deterministic regex scan of the full HTML
    // contents (inline <script> blocks included). This recovers links the
    // model missed due to its 3000-char per-file truncation. External .js
    // files are not scanned: their navigation can't be reliably attributed
    // to a single source page.
    const scanFiles = files.filter((f) => f.mimeType === "text/html" || f.path.endsWith(".html"));
    const staticEdges = extractStaticEdges(scanFiles, aiNodes);

    // Dedupe by source+target pair; AI edges win (they carry semantic
    // connectionType info like auth-gate/redirect that regex can't infer).
    const aiPairs = new Set(aiEdges.map((e) => `${e.source}->${e.target}`));
    const mergedAiAndStatic = [
      ...aiEdges,
      ...staticEdges.filter((e) => !aiPairs.has(`${e.source}->${e.target}`)),
    ];

    const merged = mergeWithExisting(aiNodes, mergedAiAndStatic, existingMap ?? EMPTY_PLATFORM);
    return merged;
  } catch (err) {
    logger.error({ err }, "extractPageMap AI call failed");
    return existingMap ?? EMPTY_PLATFORM;
  }
}
