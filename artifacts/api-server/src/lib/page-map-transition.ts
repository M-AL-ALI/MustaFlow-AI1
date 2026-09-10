import { z } from "zod";
import type { PageMapEdge, PageMapNode, PageMapPlatform } from "./page-map";
import { hasPageMapControlCharacter } from "./page-map-path-characters";

export const PAGE_MAP_TRANSITION_FIELDS = [
  "action",
  "control",
  "condition",
  "outcome",
  "destination",
] as const;
const field = z.enum(PAGE_MAP_TRANSITION_FIELDS);
const shortText = z.string().min(1).max(240);
const projectPath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !hasPageMapControlCharacter(value) &&
      !/[\\:]/.test(value) &&
      !value.split("/").some((part) => !part || part === "." || part === ".."),
    "Use a project-relative source file",
  );

const sourceReference = z
  .object({
    filePath: projectPath,
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
    startOffset: z.number().int().min(0).max(500_000),
    endOffset: z.number().int().min(0).max(500_000),
  })
  .strict()
  .refine(
    (value) => value.endOffset > value.startOffset,
    "Source offsets describe a nonempty, end-exclusive span",
  );

const evidence = z
  .object({
    basis: z.enum(["unknown", "inferred", "source", "manual"]),
    fields: z
      .array(field)
      .min(1)
      .max(5)
      .refine((values) => new Set(values).size === values.length, "Evidence fields must be unique"),
    source: sourceReference.optional(),
  })
  .strict()
  .refine(
    (value) => (value.basis === "source") === (value.source !== undefined),
    "Only source evidence carries a source reference",
  );

const condition = z
  .object({
    kind: z.enum(["unknown", "none", "predicate"]),
    expression: z.string().min(1).max(2000).optional(),
    branch: z.enum(["unknown", "true", "false"]),
  })
  .strict()
  .refine(
    (value) =>
      value.kind === "predicate"
        ? value.expression !== undefined
        : value.expression === undefined && value.branch === "unknown",
    "Only a predicate has an expression or branch",
  );

const destination = z
  .object({
    kind: z.enum(["unknown", "route", "external"]),
    value: z.string().min(1).max(2048).optional(),
  })
  .strict()
  .refine((value) => {
    if (value.kind === "unknown") return value.value === undefined;
    if (!value.value || hasPageMapControlCharacter(value.value, true) || value.value.includes("\\"))
      return false;
    if (value.kind === "route") return value.value.startsWith("/") && !value.value.startsWith("//");
    try {
      const url = new URL(value.value);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  }, "Use a descriptive route or credential-free HTTP(S) destination");

/**
 * Descriptive map metadata, never an executable predicate, selector, or URL.
 * Source evidence means a declaration at the recorded file hash, not runtime
 * execution, current-file freshness, or proof that a branch is reachable.
 * Runtime-observed is deliberately not an accepted evidence basis in v1.
 */
export const pageMapTransitionSchema = z
  .object({
    version: z.literal(1),
    action: z
      .object({
        kind: z.enum(["unknown", "click", "submit", "load", "programmatic"]),
        label: shortText.optional(),
      })
      .strict(),
    control: z
      .object({
        kind: z.enum(["unknown", "link", "button", "form", "call", "other"]),
        label: shortText.optional(),
        locator: z.string().min(1).max(1024).optional(),
      })
      .strict(),
    condition,
    outcome: z
      .object({
        kind: z.enum(["unknown", "navigate", "redirect", "external", "stay"]),
        detail: z.string().min(1).max(1000).optional(),
      })
      .strict(),
    destination,
    evidence: z.array(evidence).max(8),
    unknowns: z.array(z.string().min(1).max(500)).max(16).optional(),
  })
  .strict();

export const pageMapUnresolvedTransitionSchema = z
  .object({
    id: z.string().min(1).max(128),
    source: z.string().min(1).max(128).optional(),
    transition: pageMapTransitionSchema,
  })
  .strict();

export type PageMapTransition = z.infer<typeof pageMapTransitionSchema>;
export type PageMapUnresolvedTransition = z.infer<typeof pageMapUnresolvedTransitionSchema>;

/** A client may describe claims, but cannot assign their evidence authority. */
export function manualPageMapTransition(value: PageMapTransition): PageMapTransition {
  return {
    ...value,
    evidence: [{ basis: "manual", fields: [...PAGE_MAP_TRANSITION_FIELDS] }],
  };
}

function meaning(value: PageMapTransition): string {
  // Deliberately excludes all client-supplied evidence, including file references.
  return JSON.stringify([
    value.version,
    value.action.kind,
    value.action.label ?? null,
    value.control.kind,
    value.control.label ?? null,
    value.control.locator ?? null,
    value.condition.kind,
    value.condition.expression ?? null,
    value.condition.branch,
    value.outcome.kind,
    value.outcome.detail ?? null,
    value.destination.kind,
    value.destination.value ?? null,
    value.unknowns ?? [],
  ]);
}

function samePage(before: PageMapNode | undefined, after: PageMapNode | undefined): boolean {
  return (
    !!before &&
    !!after &&
    before.id === after.id &&
    before.filePath === after.filePath &&
    before.notes === after.notes &&
    (before.planned ?? false) === (after.planned ?? false)
  );
}

/**
 * Called only after the route has accepted expectedRevision. It does not replace
 * the repository CAS or lifecycle/ownership guards. Lookup is confined to one
 * project platform; evidence cannot be copied from a different edge or candidate.
 */
export function reconcilePageMapPlatformUpdate(
  current: PageMapPlatform,
  incoming: PageMapPlatform | undefined,
): PageMapPlatform {
  if (incoming === undefined) return current;
  const oldNodes = new Map(current.nodes.map((node) => [node.id, node]));
  const newNodes = new Map(incoming.nodes.map((node) => [node.id, node]));
  const sameSource = (before: string | undefined, after: string | undefined): boolean =>
    before === after &&
    (before === undefined || samePage(oldNodes.get(before), newNodes.get(before)));
  const previousEdges = new Map(current.edges.map((edge) => [edge.id, edge]));

  const edges = incoming.edges.map((edge): PageMapEdge => {
    const prior = previousEdges.get(edge.id);
    const sameBinding =
      !!prior &&
      prior.source === edge.source &&
      prior.target === edge.target &&
      prior.connectionType === edge.connectionType &&
      sameSource(prior.source, edge.source) &&
      sameSource(prior.target, edge.target);
    if (edge.transition === undefined) {
      // Omission by an old client is not a request to erase a matched extension.
      if (sameBinding && prior?.transition)
        return {
          ...edge,
          transition: prior.transition,
          aiGenerated: prior.aiGenerated,
        };
      return edge;
    }
    if (
      sameBinding &&
      prior?.transition &&
      meaning(prior.transition) === meaning(edge.transition)
    ) {
      // Ignore even a well-formed replacement evidence object from the client.
      return { ...edge, transition: prior.transition, aiGenerated: prior.aiGenerated };
    }
    return { ...edge, aiGenerated: false, transition: manualPageMapTransition(edge.transition) };
  });

  const previousCandidates = new Map(
    (current.unresolvedTransitions ?? []).map((candidate) => [candidate.id, candidate]),
  );
  const requested = incoming.unresolvedTransitions ?? current.unresolvedTransitions;
  const unresolvedTransitions = requested
    ?.filter((candidate) => candidate.source === undefined || newNodes.has(candidate.source))
    .map((candidate): PageMapUnresolvedTransition => {
      const prior = previousCandidates.get(candidate.id);
      if (
        prior &&
        sameSource(prior.source, candidate.source) &&
        meaning(prior.transition) === meaning(candidate.transition)
      ) {
        return { ...candidate, transition: prior.transition };
      }
      return { ...candidate, transition: manualPageMapTransition(candidate.transition) };
    });
  return {
    ...incoming,
    edges,
    ...(unresolvedTransitions === undefined ? {} : { unresolvedTransitions }),
  };
}
