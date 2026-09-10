import { pageMapRepository } from "./page-map-repository";
import { parseStoredPageMap, assertPageMapPlatform } from "./page-map-validation";
import { discoverSourcePageMap, stabilizeSourcePageMap } from "./page-map-source";
import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "./logger";
import type { BuilderFile } from "./builder";
import {
  reconcilePageMapPlatformUpdate,
  type PageMapTransition,
  type PageMapUnresolvedTransition,
} from "./page-map-transition";

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
  transition?: PageMapTransition;
};

export type PageMapPlatform = {
  nodes: PageMapNode[];
  edges: PageMapEdge[];
  unresolvedTransitions?: PageMapUnresolvedTransition[];
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
// Legacy helper retained for compatibility tests. Production analysis uses
// comment-aware source discovery below and preserves declaration identities.
// Returns edges keyed to existing node IDs (by filePath). These edges are still
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
  const X_STEP = 340;
  const Y_STEP = 300;
  return nodes.map((node, idx) => ({
    ...node,
    position: {
      x: 80 + (idx % COLS) * X_STEP,
      y: 80 + Math.floor(idx / COLS) * Y_STEP,
    },
  }));
}

function normalizeLabel(label: string): string {
  return label
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

export function mergePageMapNotes(generated: string, previous?: string): string {
  const canonical = /^Route:\s*\/[^\r\n]*/.exec(generated)?.[0];
  if (!canonical) return previous ?? generated;
  const description = (previous || generated).replace(/^Route:[^\r\n]*(?:\r?\n)?/m, "").trim();
  return [canonical, description].filter(Boolean).join("\n").slice(0, 8000);
}

export function mergeWithExisting(
  aiNodes: PageMapNode[],
  aiEdges: PageMapEdge[],
  existing: PageMapPlatform,
  sourceCandidates?: PageMapUnresolvedTransition[],
): PageMapPlatform {
  const existingById = new Map(existing.nodes.map((node) => [node.id, node]));
  const labels = new Map<string, PageMapNode[]>();
  for (const node of aiNodes) {
    const label = normalizeLabel(node.label);
    if (label) labels.set(label, [...(labels.get(label) ?? []), node]);
  }
  const merged = aiNodes.map((node) => {
    const prior = existingById.get(node.id);
    return {
      ...node,
      position: prior?.position ?? node.position,
      notes: mergePageMapNotes(node.notes, prior?.notes),
      aiGenerated: true,
      planned: false,
    };
  });
  const ids = new Set(merged.map((node) => node.id));
  const remapped = new Map<string, string>();
  const retained: PageMapNode[] = [];
  for (const prior of existing.nodes) {
    if (ids.has(prior.id)) continue;
    if (prior.planned) {
      const matches = labels.get(normalizeLabel(prior.label)) ?? [];
      if (matches.length === 1) {
        const target = merged.find((node) => node.id === matches[0].id)!;
        target.position = prior.position;
        target.notes = mergePageMapNotes(target.notes, prior.notes || undefined);
        remapped.set(prior.id, target.id);
        continue;
      }
      retained.push(prior);
    } else if (!prior.aiGenerated) {
      // User-authored pages are not disposable merely because an AI pass omitted them.
      retained.push(prior);
    }
  }
  const nodes = [...merged, ...retained];
  const liveIds = new Set(nodes.map((node) => node.id));
  // A user transition annotation is map metadata, not disposable extractor output.
  const annotatedIds = new Set(
    existing.edges
      .filter((edge) => !edge.aiGenerated && edge.transition !== undefined)
      .map((edge) => edge.id),
  );
  const automaticEdges = aiEdges.filter((edge) => !annotatedIds.has(edge.id));
  const automaticIds = new Set(automaticEdges.map((edge) => edge.id));
  const manualEdges = existing.edges.filter(
    (edge) => !edge.aiGenerated && !automaticIds.has(edge.id),
  );
  const edges = [...automaticEdges.map((edge) => ({ ...edge, aiGenerated: true })), ...manualEdges]
    .map((edge) => ({
      ...edge,
      source: remapped.get(edge.source) ?? edge.source,
      target: remapped.get(edge.target) ?? edge.target,
    }))
    .filter((edge) => liveIds.has(edge.source) && liveIds.has(edge.target));
  // Extraction and PUT use the same binding checks. A stable ID is not proof
  // that a candidate still belongs to the same file, route or planned page.
  const { unresolvedTransitions: retainedTransitions } = reconcilePageMapPlatformUpdate(existing, {
    nodes,
    edges: [],
    ...(existing.unresolvedTransitions === undefined
      ? {}
      : {
          unresolvedTransitions: existing.unresolvedTransitions.map((candidate) => ({
            ...candidate,
            ...(candidate.source === undefined
              ? {}
              : { source: remapped.get(candidate.source) ?? candidate.source }),
          })),
        }),
  });
  // A fresh server extraction replaces old source declarations, including
  // declarations removed from the file. Classify before reconciliation: a
  // changed binding must not turn obsolete source output into a manual draft.
  const replacedSourceIds = new Set(
    sourceCandidates === undefined
      ? []
      : (existing.unresolvedTransitions ?? [])
          .filter(
            ({ transition }) =>
              transition.evidence.some((item) => item.basis === "source") &&
              !transition.evidence.some((item) => item.basis === "manual"),
          )
          .map((candidate) => candidate.id),
  );
  const retainedCandidates = retainedTransitions?.filter(
    (candidate) => !replacedSourceIds.has(candidate.id),
  );
  const retainedIds = new Set(retainedCandidates?.map((candidate) => candidate.id));
  // Only this internal extraction path accepts new source authority. HTTP PUT
  // still uses reconcilePageMapPlatformUpdate and cannot mint source evidence.
  const unresolvedTransitions =
    sourceCandidates === undefined
      ? retainedCandidates
      : [
          ...(retainedCandidates ?? []),
          ...sourceCandidates
            .filter((candidate) => !retainedIds.has(candidate.id))
            .map((candidate) => ({
              ...candidate,
              ...(candidate.source === undefined
                ? {}
                : { source: remapped.get(candidate.source) ?? candidate.source }),
            })),
        ];
  return assertPageMapPlatform({
    nodes,
    edges,
    ...(unresolvedTransitions === undefined ? {} : { unresolvedTransitions }),
  });
}

/**
 * DB-aware wrapper: loads current project files + existing page map from DB,
 * runs AI extraction for the "web" platform, and persists the result back.
 * The caller must handle failures; superseded analysis is discarded.
 */
export async function extractPageMap(projectId: number): Promise<void> {
  const project = await pageMapRepository.read(projectId);
  if (!project) return;
  const snapshot = await pageMapRepository.readFiles(projectId);
  const existing = parseStoredPageMap(project.pageMapData);
  const web = await extractPageMapForFiles(snapshot.files, "web", existing.web);
  const persisted = await pageMapRepository.write(
    projectId,
    { ...existing, web },
    project.pageMapData,
    snapshot.revision,
  );
  if (!persisted) {
    logger.info({ projectId }, "Page map source or edits changed; discarded superseded analysis");
    return;
  }
  logger.info({ projectId, nodeCount: web.nodes.length }, "Page map extracted and persisted");
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

  const discovered = stabilizeSourcePageMap(discoverSourcePageMap(files), existingMap);
  const fallback = () =>
    mergeWithExisting(
      discovered.nodes,
      discovered.edges,
      existingMap ?? EMPTY_PLATFORM,
      discovered.unresolvedTransitions ?? [],
    );
  if (discovered.nodes.some((node) => !/\.html?$/i.test(node.filePath))) return fallback();

  const pageFiles = files.filter(
    (f) => f.mimeType === "text/html" || f.path.endsWith(".html") || f.path === "index.html",
  );

  if (pageFiles.length === 0) {
    return discovered.nodes.length || files.length === 0
      ? fallback()
      : (existingMap ?? EMPTY_PLATFORM);
  }
  if (pageFiles.length > 120) return fallback();

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

    const pagePaths = new Set(pageFiles.map((file) => file.path));
    const seenIds = new Set<string>();
    const pageTypes = new Set([
      "landing",
      "auth",
      "form",
      "dashboard",
      "modal",
      "settings",
      "404",
      "tab-bar",
      "drawer",
      "sheet",
      "list",
      "detail",
      "other",
    ]);
    const connectionTypes = new Set(["nav", "auth-gate", "redirect", "external"]);
    const modelNodes: PageMapNode[] = buildAutoLayout(
      rawNodes
        .filter(
          (n) =>
            n !== null &&
            typeof n === "object" &&
            typeof n.id === "string" &&
            n.id.length > 0 &&
            n.id.length <= 128 &&
            typeof n.label === "string" &&
            typeof n.filePath === "string" &&
            pagePaths.has(n.filePath),
        )
        .filter((node) => {
          if (seenIds.has(node.id)) return false;
          seenIds.add(node.id);
          return true;
        })
        .slice(0, 500)
        .map((n) => ({
          id: n.id,
          label: n.label,
          pageType: pageTypes.has(n.pageType) ? (n.pageType as PageType) : "other",
          filePath: n.filePath,
          position: { x: 0, y: 0 },
          isNew: false,
          hasError: false,
          aiGenerated: true,
          notes: typeof n.notes === "string" ? n.notes.slice(0, 2000) : "",
        })),
    );

    // AI metadata may change, but a page's durable identity belongs to its
    // source. Otherwise enrichment can detach user edits and replace them
    // with fresh source claims. Ambiguous model pages are not safe bindings.
    const modelPaths = new Set(modelNodes.map((node) => node.filePath));
    const sourceByPath = new Map(discovered.nodes.map((node) => [node.filePath, node]));
    if (modelPaths.size !== modelNodes.length || sourceByPath.size !== discovered.nodes.length) {
      return fallback();
    }
    const modelToSourceIds = new Map<string, string>();
    const enrichedNodes = modelNodes.flatMap((node) => {
      const source = sourceByPath.get(node.filePath);
      if (!source) return [];
      modelToSourceIds.set(node.id, source.id);
      return [{ ...node, id: source.id, notes: mergePageMapNotes(source.notes, node.notes) }];
    });
    const aiNodes = buildAutoLayout([
      ...enrichedNodes,
      ...discovered.nodes.filter((node) => !modelPaths.has(node.filePath)),
    ]);
    const nodeIds = new Set(aiNodes.map((n) => n.id));
    const aiEdges: PageMapEdge[] = rawEdges
      .filter(
        (e) =>
          e !== null &&
          typeof e === "object" &&
          typeof e.id === "string" &&
          typeof e.source === "string" &&
          typeof e.target === "string" &&
          nodeIds.has(modelToSourceIds.get(e.source) ?? "") &&
          nodeIds.has(modelToSourceIds.get(e.target) ?? ""),
      )
      .map((e) => ({
        id: e.id,
        source: modelToSourceIds.get(e.source)!,
        target: modelToSourceIds.get(e.target)!,
        connectionType: connectionTypes.has(e.connectionType)
          ? (e.connectionType as ConnectionType)
          : "nav",
        aiGenerated: true,
      }));

    // Reuse comment-aware source discovery, remapping its page identities to
    // the enriched nodes. Do not reintroduce regex-only links from comments.
    const discoveredPaths = new Map(discovered.nodes.map((node) => [node.id, node.filePath]));
    const enrichedIds = new Map(aiNodes.map((node) => [node.filePath, node.id]));
    const staticEdges: PageMapEdge[] = discovered.edges.flatMap((edge) => {
      const source = enrichedIds.get(discoveredPaths.get(edge.source) ?? "");
      const target = enrichedIds.get(discoveredPaths.get(edge.target) ?? "");
      return source && target ? [{ ...edge, source, target }] : [];
    });

    const sourceCandidates = (discovered.unresolvedTransitions ?? []).map((candidate) => {
      const source =
        candidate.source === undefined
          ? undefined
          : enrichedIds.get(discoveredPaths.get(candidate.source) ?? "");
      return { ...candidate, source };
    });

    // Concrete declarations take precedence over model-inferred pairs. Keep
    // every source identity: two controls can lead to the same destination.
    const sourcePairs = new Set(staticEdges.map((edge) => `${edge.source}->${edge.target}`));
    const mergedAiAndStatic = [
      ...staticEdges,
      ...aiEdges.filter((edge) => !sourcePairs.has(`${edge.source}->${edge.target}`)),
    ];

    const merged = mergeWithExisting(
      aiNodes,
      mergedAiAndStatic,
      existingMap ?? EMPTY_PLATFORM,
      sourceCandidates,
    );
    return merged;
  } catch (err) {
    logger.warn({ err }, "Page map AI enrichment unavailable; using source evidence");
    return fallback();
  }
}
