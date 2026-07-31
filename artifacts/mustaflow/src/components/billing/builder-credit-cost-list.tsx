import { useBuilderCreditCosts } from "@/lib/builder-followup-submit";

const MODE_ROWS = [
  { mode: "lite", label: "Lite", description: "Minimal correct change, fastest" },
  { mode: "eco", label: "Eco", description: "Clean typed code, no over-engineering" },
  {
    mode: "power",
    label: "Power",
    description: "Production-ready TypeScript, full error handling",
  },
  {
    mode: "pro",
    label: "Pro",
    description: "Security-first strict mode, architectural clarity",
  },
] as const;

export function BuilderCreditCostList() {
  const { standard } = useBuilderCreditCosts();

  return (
    <div className="divide-y divide-border">
      {MODE_ROWS.map((row) => {
        const cost = standard[row.mode];
        return (
          <div
            key={row.mode}
            className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm"
          >
            <span className="text-muted-foreground">
              {row.label} — {row.description}
            </span>
            <span className="shrink-0 font-semibold">
              {cost} credit{cost !== 1 ? "s" : ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}
