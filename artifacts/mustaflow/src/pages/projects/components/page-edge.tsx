import { memo } from "react";
import { EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";
import { Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  parallelTransitionPath,
  transitionBadgeLayout,
  transitionEvidenceLabel,
  transitionSummary,
  type PageMapPublicEdge,
  type TransitionEdgeData,
} from "./page-map-transition-model";

export type ConnectionType = PageMapPublicEdge["connectionType"];
export type PageEdgeData = TransitionEdgeData;

const EDGE_STYLE: Record<
  ConnectionType,
  { stroke: string; strokeDasharray?: string; strokeWidth: number }
> = {
  nav: { stroke: "hsl(var(--muted-foreground))", strokeWidth: 1.5 },
  "auth-gate": { stroke: "hsl(var(--muted-foreground))", strokeDasharray: "6 3", strokeWidth: 1.5 },
  redirect: { stroke: "hsl(var(--muted-foreground))", strokeDasharray: "2 4", strokeWidth: 1.5 },
  external: { stroke: "hsl(var(--muted-foreground))", strokeWidth: 1 },
};

export const PageEdge = memo(function PageEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
  markerEnd,
}: EdgeProps & { data?: PageEdgeData }) {
  const connectionType = data?.connectionType ?? "nav";
  const aiGenerated = data?.aiGenerated === true;
  const provenance = data?.transition
    ? transitionEvidenceLabel(data.transition, data.transitionPending)
    : aiGenerated
      ? "Inferred map; details unknown"
      : "Mapped; details unknown";
  const summary = transitionSummary(data?.transition);
  const connectionLabel =
    {
      nav: "Navigation",
      "auth-gate": "Access gate",
      redirect: "Redirect",
      external: "External link",
    }[connectionType] ?? "Navigation";
  const description = `${connectionLabel}: ${summary}. ${provenance}; runtime not verified.`;

  const [edgePath, labelX, labelY] = data?.parallelOffset
    ? parallelTransitionPath(sourceX, sourceY, targetX, targetY, data.parallelOffset)
    : getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });

  const style = EDGE_STYLE[connectionType] ?? EDGE_STYLE.nav;
  const group = data?.parallelTransitions ?? [];
  const grouped = group.length > 1;
  const groupBox = transitionBadgeLayout(
    sourceX,
    sourceY,
    targetX,
    targetY,
    data?.parallelIndex,
    group.length,
  );
  const pendingCount = group.filter((item) => item.transitionPending).length;

  return (
    <>
      {/* Invisible wider hit area for easier clicking */}
      <path
        id={`${id}-hitbox`}
        d={edgePath}
        stroke="transparent"
        strokeWidth={18}
        fill="none"
        className="cursor-pointer"
        aria-hidden="true"
      />
      <path
        id={id}
        d={edgePath}
        stroke={selected ? "hsl(var(--primary))" : style.stroke}
        strokeWidth={selected ? style.strokeWidth + 0.5 : style.strokeWidth}
        strokeDasharray={aiGenerated ? "5 4" : style.strokeDasharray}
        fill="none"
        markerEnd={markerEnd}
        className={cn("transition-colors", selected && "drop-shadow-sm")}
        role="img"
        aria-label={description}
      >
        <title>{description}</title>
      </path>

      {/* Shared-endpoint labels use one footprint, above SVG path hitboxes. */}
      {grouped && groupBox.visible && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan absolute z-10"
            style={{
              left: 0,
              top: 0,
              width: groupBox.width,
              minHeight: groupBox.height,
              transform: "translate(" + groupBox.x + "px, " + groupBox.y + "px)",
              pointerEvents: "all",
            }}
          >
            <details
              className="relative rounded border border-border bg-card text-[10px] shadow-sm"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <summary
                aria-label={"Choose among " + group.length + " mapped transitions"}
                className="cursor-pointer rounded px-2 py-1.5 text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <span className="font-medium text-foreground">
                  {group.length} mapped transitions
                </span>
                <span className="block truncate">
                  {pendingCount
                    ? pendingCount + " awaiting acknowledgement"
                    : "Inspect actions, conditions and outcomes"}
                </span>
              </summary>
              <div
                role="group"
                aria-label="Transitions sharing endpoints"
                className="absolute left-0 right-0 top-full mt-1 max-h-48 space-y-1 overflow-y-auto rounded border border-border bg-card p-1 shadow-sm"
              >
                {group.map((item, index) => {
                  const itemSummary = transitionSummary(item.transition);
                  const itemEvidence = item.transition
                    ? transitionEvidenceLabel(item.transition, item.transitionPending)
                    : item.aiGenerated
                      ? "Inferred map; details unknown"
                      : "Mapped; details unknown";
                  return (
                    <button
                      key={item.id}
                      type="button"
                      aria-label={"Inspect transition " + item.id + ": " + itemSummary}
                      className="block w-full rounded border border-border px-2 py-1.5 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      onClick={(event) => {
                        event.stopPropagation();
                        data?.onInspect?.(item.id);
                      }}
                    >
                      <span className="block truncate font-medium text-foreground">
                        {index + 1}. {itemSummary}
                      </span>
                      <span className="block truncate text-muted-foreground">{itemEvidence}</span>
                    </button>
                  );
                })}
              </div>
            </details>
          </div>
        </EdgeLabelRenderer>
      )}

      {/* A single edge retains its existing compact badge. */}
      {!grouped && (
        <foreignObject
          x={labelX - 120}
          y={labelY - 20}
          width={240}
          height={44}
          className="overflow-visible"
        >
          <button
            type="button"
            className="nodrag nopan flex w-full flex-col gap-1 rounded border border-border bg-card px-2 py-1 text-left text-[10px] text-muted-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={`Inspect transition ${id}: ${summary}`}
            title={description}
            onClick={(event) => {
              event.stopPropagation();
              data?.onInspect?.(id);
            }}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <span className="w-full truncate font-medium text-foreground">{summary}</span>
            <span className="flex items-center gap-1">
              {connectionType === "auth-gate" && (
                <Lock className="h-2.5 w-2.5" aria-hidden="true" />
              )}
              {data?.parallelCount && data.parallelCount > 1
                ? `${data.parallelIndex}/${data.parallelCount} · `
                : ""}
              {provenance}
            </span>
          </button>
        </foreignObject>
      )}
    </>
  );
});
