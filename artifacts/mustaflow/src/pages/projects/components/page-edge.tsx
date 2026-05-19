import { memo } from "react";
import { getBezierPath, type EdgeProps } from "@xyflow/react";
import { Lock, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";

export type ConnectionType = "nav" | "auth-gate" | "redirect" | "external";

export type PageEdgeData = {
  connectionType: ConnectionType;
  aiGenerated: boolean;
};

const EDGE_STYLE: Record<ConnectionType, { stroke: string; strokeDasharray?: string; strokeWidth: number }> = {
  nav:       { stroke: "hsl(var(--primary))",    strokeWidth: 2 },
  "auth-gate": { stroke: "hsl(var(--secondary))", strokeDasharray: "6 3", strokeWidth: 1.5 },
  redirect:  { stroke: "hsl(var(--foreground))", strokeDasharray: "2 4", strokeWidth: 1.5 },
  external:  { stroke: "hsl(var(--muted-foreground))", strokeWidth: 1 },
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
  const aiGenerated = data?.aiGenerated ?? true;

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const style = EDGE_STYLE[connectionType] ?? EDGE_STYLE.nav;

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
      />
      <path
        id={id}
        d={edgePath}
        stroke={selected ? "hsl(var(--primary))" : style.stroke}
        strokeWidth={selected ? style.strokeWidth + 0.5 : style.strokeWidth}
        strokeDasharray={style.strokeDasharray}
        fill="none"
        markerEnd={markerEnd}
        className={cn("transition-colors", selected && "drop-shadow-sm")}
      />

      {/* Edge label badge */}
      <foreignObject
        x={labelX - 14}
        y={labelY - 10}
        width={28}
        height={20}
        className="pointer-events-none overflow-visible"
      >
        <div className="flex items-center justify-center">
          {connectionType === "auth-gate" ? (
            <div className="flex items-center gap-0.5 px-1 py-0.5 rounded bg-card border border-border/80 shadow-sm">
              <Lock className="h-2.5 w-2.5 text-secondary" />
            </div>
          ) : aiGenerated ? (
            <div className="flex items-center px-1 py-0.5 rounded bg-primary/10 border border-primary/20">
              <span className="text-[8px] font-bold text-primary leading-none">AI</span>
            </div>
          ) : (
            <div className="flex items-center px-1 py-0.5 rounded bg-card border border-border/80 shadow-sm">
              <Pencil className="h-2.5 w-2.5 text-muted-foreground" />
            </div>
          )}
        </div>
      </foreignObject>
    </>
  );
});
