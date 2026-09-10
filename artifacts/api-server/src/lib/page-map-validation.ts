import { z } from "zod";
import type { PageMapData, PageMapPlatform } from "./page-map";
import { pageMapTransitionSchema, pageMapUnresolvedTransitionSchema } from "./page-map-transition";
import { hasPageMapControlCharacter } from "./page-map-path-characters";

const id = z.string().min(1).max(128);
const filePath = z
  .string()
  .max(1024)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !hasPageMapControlCharacter(value) &&
      !/[\\:]/.test(value) &&
      !value.split("/").some((part) => part === ".." || part === "."),
    "Use a project-relative file path",
  );
const nodeSchema = z.object({
  id,
  label: z.string().min(1).max(240),
  pageType: z.enum([
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
  ]),
  filePath,
  position: z.object({
    x: z.number().finite().min(-10_000_000).max(10_000_000),
    y: z.number().finite().min(-10_000_000).max(10_000_000),
  }),
  isNew: z.boolean(),
  hasError: z.boolean(),
  aiGenerated: z.boolean(),
  notes: z.string().max(8000),
  planned: z.boolean().optional(),
});
const baseEdgeSchema = z.object({
  id,
  source: id,
  target: id,
  connectionType: z.enum(["nav", "auth-gate", "redirect", "external"]),
  aiGenerated: z.boolean(),
});
const edgeSchema = baseEdgeSchema.extend({ transition: pageMapTransitionSchema.optional() });
const platformSchema = z
  .object({
    nodes: z.array(nodeSchema).max(500),
    edges: z.array(edgeSchema).max(2000),
    unresolvedTransitions: z.array(pageMapUnresolvedTransitionSchema).max(1000).optional(),
  })
  .superRefine((platform, context) => {
    const ids = new Set(platform.nodes.map((node) => node.id));
    const edges = new Set(platform.edges.map((edge) => edge.id));
    const candidates = platform.unresolvedTransitions ?? [];
    if (
      new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length ||
      candidates.some((candidate) => candidate.source !== undefined && !ids.has(candidate.source))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Unresolved transition identities must be unique and reference existing source pages",
      });
    }
    if (
      ids.size !== platform.nodes.length ||
      edges.size !== platform.edges.length ||
      platform.edges.some((edge) => !ids.has(edge.source) || !ids.has(edge.target))
    ) {
      context.addIssue({
        code: "custom",
        message: "Page and connection identities must be unique and reference existing pages",
      });
    }
  });
export const pageMapUpdateSchema = z
  .object({
    expectedRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    web: platformSchema.optional(),
    ios: platformSchema.optional(),
    android: platformSchema.optional(),
  })
  .strict()
  .refine(
    (data) => data.web !== undefined || data.ios !== undefined || data.android !== undefined,
    "Provide at least one platform",
  );

export function parseStoredPageMap(raw: unknown): PageMapData {
  const record =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const parse = (value: unknown): PageMapPlatform => {
    const platform = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const nodeIds = new Set<string>();
    const nodes: PageMapPlatform["nodes"] = [];
    for (const candidate of Array.isArray(platform.nodes) ? platform.nodes.slice(0, 500) : []) {
      const result = nodeSchema.safeParse(candidate);
      if (!result.success || nodeIds.has(result.data.id)) continue;
      nodeIds.add(result.data.id);
      nodes.push(result.data);
    }
    const edgeIds = new Set<string>();
    const edges: PageMapPlatform["edges"] = [];
    for (const candidate of Array.isArray(platform.edges) ? platform.edges.slice(0, 2000) : []) {
      // An invalid optional extension must not erase a valid legacy connection.
      const result = baseEdgeSchema.safeParse(candidate);
      if (
        !result.success ||
        edgeIds.has(result.data.id) ||
        !nodeIds.has(result.data.source) ||
        !nodeIds.has(result.data.target)
      )
        continue;
      edgeIds.add(result.data.id);
      const transition = pageMapTransitionSchema.safeParse(
        candidate && typeof candidate === "object" ? candidate.transition : undefined,
      );
      edges.push({
        ...result.data,
        ...(transition.success ? { transition: transition.data } : {}),
      });
    }
    const candidateIds = new Set<string>();
    const unresolvedTransitions: NonNullable<PageMapPlatform["unresolvedTransitions"]> = [];
    for (const candidate of Array.isArray(platform.unresolvedTransitions)
      ? platform.unresolvedTransitions.slice(0, 1000)
      : []) {
      const parsed = pageMapUnresolvedTransitionSchema.safeParse(candidate);
      if (
        !parsed.success ||
        candidateIds.has(parsed.data.id) ||
        (parsed.data.source !== undefined && !nodeIds.has(parsed.data.source))
      )
        continue;
      candidateIds.add(parsed.data.id);
      unresolvedTransitions.push(parsed.data);
    }
    return {
      nodes,
      edges,
      ...(Array.isArray(platform.unresolvedTransitions) ? { unresolvedTransitions } : {}),
    };
  };
  return { web: parse(record.web), ios: parse(record.ios), android: parse(record.android) };
}

export class PageMapAnalysisValidationError extends Error {
  constructor() {
    super("The merged page map exceeds its limits or contains invalid identities.");
    this.name = "PageMapAnalysisValidationError";
  }
}
export function assertPageMapPlatform(value: PageMapPlatform): PageMapPlatform {
  const result = platformSchema.safeParse(value);
  if (!result.success) throw new PageMapAnalysisValidationError();
  return result.data;
}
