import type { Edge } from "@xyflow/react";
import type { PageMapData } from "@workspace/api-client-react";

export type PageMapPublicEdge = PageMapData["web"]["edges"][number];
export type PageMapTransition = NonNullable<PageMapPublicEdge["transition"]>;
export type PageMapCandidate = NonNullable<PageMapData["web"]["unresolvedTransitions"]>[number];
export type PageMapTransitionField = PageMapTransition["evidence"][number]["fields"][number];
export type TransitionEdgeData = {
  connectionType: PageMapPublicEdge["connectionType"];
  aiGenerated: boolean;
  transition?: PageMapTransition;
  transitionPending?: boolean;
  parallelOffset?: number;
  parallelIndex?: number;
  parallelCount?: number;
  parallelTransitions?: Array<{
    id: string;
    connectionType: PageMapPublicEdge["connectionType"];
    aiGenerated: boolean;
    transition?: PageMapTransition;
    transitionPending?: boolean;
  }>;
  onInspect?: (id: string) => void;
};

const fields: PageMapTransitionField[] = [
  "action",
  "control",
  "condition",
  "outcome",
  "destination",
];
export function unknownPageMapTransition(): PageMapTransition {
  return {
    version: 1,
    action: { kind: "unknown" },
    control: { kind: "unknown" },
    condition: { kind: "unknown", branch: "unknown" },
    outcome: { kind: "unknown" },
    destination: { kind: "unknown" },
    evidence: [],
  };
}

export function copyPageMapTransition(value?: PageMapTransition): PageMapTransition {
  return value
    ? (JSON.parse(JSON.stringify(value)) as PageMapTransition)
    : unknownPageMapTransition();
}

/** Presentation only. The API still owns authoritative evidence reconciliation. */
export function manualPageMapTransition(value: PageMapTransition): PageMapTransition {
  return { ...copyPageMapTransition(value), evidence: [{ basis: "manual", fields: [...fields] }] };
}

export function transitionSummary(value?: PageMapTransition): string {
  const transition = value ?? unknownPageMapTransition();
  const action =
    transition.action.label ??
    (transition.action.kind === "unknown" ? "Action unknown" : transition.action.kind);
  const condition =
    transition.condition.kind === "unknown"
      ? "condition unknown"
      : transition.condition.kind === "none"
        ? "no condition mapped"
        : (transition.condition.expression ?? "predicate unknown") +
          (transition.condition.branch === "unknown"
            ? " (branch unknown)"
            : " (" + transition.condition.branch + ")");
  const outcome =
    transition.outcome.kind === "unknown" ? "outcome unknown" : transition.outcome.kind;
  return (
    action +
    " -> " +
    condition +
    " -> " +
    outcome +
    (transition.destination.value ? " " + transition.destination.value : "")
  );
}

export function transitionEvidenceLabel(value?: PageMapTransition, pending = false): string {
  if (pending) return "Manual; awaiting acknowledgement";
  if (!value || value.evidence.length === 0) return "Unknown evidence";
  const labels = new Set(
    value.evidence.map(
      (item) =>
        ({
          unknown: "Unknown",
          inferred: "Inferred",
          source: "Historical source",
          manual: "Manual",
        })[item.basis] ?? "Unknown",
    ),
  );
  return [...labels].join(" / ");
}

export function transitionDraftError(value: PageMapTransition): string | null {
  if (value.condition.kind === "predicate" && !value.condition.expression?.trim())
    return "Describe the predicate before saving.";
  if (value.condition.expression && value.condition.expression.length > 2000)
    return "Keep the predicate within 2000 characters.";
  if ((value.unknowns?.length ?? 0) > 16 || value.unknowns?.some((line) => line.length > 500))
    return "Use at most 16 unknowns, each within 500 characters.";
  const destination = value.destination;
  if (destination.kind !== "unknown") {
    const raw = destination.value ?? "";
    if (
      !raw ||
      raw.length > 2048 ||
      [...raw].some((character) => character.charCodeAt(0) <= 0x20 || character === "\\")
    )
      return "Provide a destination without whitespace or backslashes.";
    if (destination.kind === "route" && (!raw.startsWith("/") || raw.startsWith("//")))
      return "Use a slash-prefixed app route, not a network URL.";
    if (destination.kind === "external") {
      try {
        const url = new URL(raw);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
          return "Use a credential-free HTTP(S) destination.";
      } catch {
        return "Use a valid HTTP(S) destination.";
      }
    }
  }
  return null;
}

let sequence = 0;
export function newPageMapTransitionId(prefix = "edge-user"): string {
  const random =
    globalThis.crypto?.randomUUID?.() ??
    Date.now().toString(36) +
      "-" +
      (++sequence).toString(36) +
      "-" +
      Math.random().toString(36).slice(2);
  return prefix + "-" + random;
}

/** Preserve optional absence and explicit [], pruning only removed source pages. */
export function retainedCandidates(
  platform: PageMapData["web"] | undefined,
  nodeIds: ReadonlySet<string>,
): Pick<PageMapData["web"], "unresolvedTransitions"> {
  if (platform?.unresolvedTransitions === undefined) return {};
  return {
    unresolvedTransitions: platform.unresolvedTransitions
      .filter((candidate) => candidate.source === undefined || nodeIds.has(candidate.source))
      .map((candidate) => ({
        ...candidate,
        transition: copyPageMapTransition(candidate.transition),
      })),
  };
}

export function parallelTransitionEdges(edges: Edge[], onInspect?: (id: string) => void): Edge[] {
  const groups = new Map<string, Edge[]>();
  for (const edge of edges) {
    const key = JSON.stringify([edge.source, edge.target].sort());
    groups.set(key, [...(groups.get(key) ?? []), edge]);
  }
  const lanes = new Map<
    string,
    {
      index: number;
      count: number;
      transitions: NonNullable<TransitionEdgeData["parallelTransitions"]>;
    }
  >();
  for (const group of groups.values()) {
    group.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const transitions = group.map((edge) => {
      const data = edge.data as TransitionEdgeData | undefined;
      return {
        id: edge.id,
        connectionType: data?.connectionType ?? "nav",
        aiGenerated: data?.aiGenerated === true,
        transition: data?.transition,
        transitionPending: data?.transitionPending,
      };
    });
    group.forEach((edge, index) => lanes.set(edge.id, { index, count: group.length, transitions }));
  }
  return edges.map((edge) => {
    const lane = lanes.get(edge.id)!;
    const direction = edge.source <= edge.target ? 1 : -1;
    return {
      ...edge,
      data: {
        ...edge.data,
        parallelOffset: (lane.index - (lane.count - 1) / 2) * 52 * direction,
        parallelIndex: lane.index + 1,
        parallelCount: lane.count,
        parallelTransitions: lane.count > 1 ? lane.transitions : undefined,
        onInspect,
      },
    };
  });
}

export function parallelTransitionPath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  offset: number,
): [string, number, number] {
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const length = Math.max(1, Math.hypot(dx, dy));
  const nx = -dy / length;
  const ny = dx / length;
  const c1x = sourceX + dx / 3 + nx * offset;
  const c1y = sourceY + dy / 3 + ny * offset;
  const c2x = sourceX + (dx * 2) / 3 + nx * offset;
  const c2y = sourceY + (dy * 2) / 3 + ny * offset;
  return [
    "M " +
      sourceX +
      " " +
      sourceY +
      " C " +
      c1x +
      " " +
      c1y +
      ", " +
      c2x +
      " " +
      c2y +
      ", " +
      targetX +
      " " +
      targetY,
    (sourceX + targetX) / 2 + nx * offset * 0.75,
    (sourceY + targetY) / 2 + ny * offset * 0.75,
  ];
}

export const TRANSITION_BADGE_WIDTH = 240;
export const TRANSITION_BADGE_HEIGHT = 44;

/**
 * Parallel and reciprocal arrows share one compact, expandable label footprint.
 * Path-lane spacing is not badge spacing: vertical lanes may be only 39px apart.
 * Only the stable first member draws the group; every member remains selectable.
 */
export function transitionBadgeLayout(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  index = 1,
  count = 1,
) {
  return {
    x: (sourceX + targetX) / 2 - TRANSITION_BADGE_WIDTH / 2,
    y: (sourceY + targetY) / 2 - TRANSITION_BADGE_HEIGHT / 2,
    width: TRANSITION_BADGE_WIDTH,
    height: TRANSITION_BADGE_HEIGHT,
    visible: count <= 1 || index === 1,
  };
}

type PendingPlatform = "web" | "ios" | "android";
type PendingKind = "edges" | "candidates";
type PendingRecord = { platform: PendingPlatform; kind: PendingKind; id: string; token: number };
type PendingItem = PageMapPublicEdge | PageMapCandidate;

function pendingItems(
  data: PageMapData[PendingPlatform] | undefined,
  kind: PendingKind,
): PendingItem[] {
  return kind === "edges" ? (data?.edges ?? []) : (data?.unresolvedTransitions ?? []);
}

/** Compare editable claims and binding, not server-owned evidence normalization. */
function acknowledgedClaims(item: PendingItem | undefined): string | null {
  if (!item?.transition) return null;
  const value = item.transition;
  return JSON.stringify([
    item.id,
    item.source ?? null,
    "target" in item ? item.target : null,
    "connectionType" in item ? item.connectionType : null,
    value.version,
    [value.action.kind, value.action.label ?? null],
    [value.control.kind, value.control.label ?? null, value.control.locator ?? null],
    [value.condition.kind, value.condition.expression ?? null, value.condition.branch],
    [value.outcome.kind, value.outcome.detail ?? null],
    [value.destination.kind, value.destination.value ?? null],
    value.unknowns ?? [],
  ]);
}

/** Session-local presentation, owned by the project coordinator, never hydrated from a platform. */
export function createPageMapPendingEvidence() {
  let token = 0;
  const pending = new Map<string, PendingRecord>();
  const key = (platform: PendingPlatform, kind: PendingKind, id: string) =>
    JSON.stringify([platform, kind, id]);
  return {
    stage(
      platform: PendingPlatform,
      previous: PageMapData[PendingPlatform] | undefined,
      next: PageMapData[PendingPlatform],
    ) {
      for (const kind of ["edges", "candidates"] as const) {
        const oldItems = new Map(pendingItems(previous, kind).map((item) => [item.id, item]));
        const nextItems = pendingItems(next, kind);
        const nextIds = new Set(nextItems.map((item) => item.id));
        for (const entry of pending.values()) {
          if (entry.platform === platform && entry.kind === kind && !nextIds.has(entry.id))
            pending.delete(key(platform, kind, entry.id));
        }
        for (const item of nextItems) {
          const previousItem = oldItems.get(item.id);
          const changed =
            acknowledgedClaims(previousItem) !== acknowledgedClaims(item) ||
            JSON.stringify(previousItem?.transition?.evidence) !==
              JSON.stringify(item.transition?.evidence);
          if (item.transition && changed) {
            pending.set(key(platform, kind, item.id), {
              platform,
              kind,
              id: item.id,
              token: ++token,
            });
          }
        }
      }
    },
    capture: () => new Map(pending),
    acknowledge(
      captured: ReadonlyMap<string, PendingRecord>,
      sent: PageMapData,
      received: PageMapData,
    ) {
      for (const [entryKey, entry] of captured) {
        if (pending.get(entryKey)?.token !== entry.token) continue;
        const sentItem = pendingItems(sent[entry.platform], entry.kind).find(
          (item) => item.id === entry.id,
        );
        const receivedItem = pendingItems(received[entry.platform], entry.kind).find(
          (item) => item.id === entry.id,
        );
        const sentClaims = acknowledgedClaims(sentItem);
        if (sentClaims !== null && sentClaims === acknowledgedClaims(receivedItem))
          pending.delete(entryKey);
      }
    },
    forPlatform(platform: PendingPlatform) {
      const edges = new Set<string>();
      const candidates = new Set<string>();
      for (const entry of pending.values()) {
        if (entry.platform === platform)
          (entry.kind === "edges" ? edges : candidates).add(entry.id);
      }
      return { edges, candidates };
    },
    clear: () => pending.clear(),
  };
}
