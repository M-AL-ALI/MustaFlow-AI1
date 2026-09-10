import { useId, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { pagePreviewUrl, pageRouteFromFilePath } from "./page-map-card-model";
import { resolvePageRouteExample } from "./page-map-route-example";

type PreviewPage = {
  id: string;
  label: string;
  filePath: string;
  notes?: string;
  planned?: boolean;
};

type PageMapPreviewActionProps = {
  projectId: number;
  node: PreviewPage;
  onOpenPreview: (route: string) => void;
};

export function PageMapPreviewAction(props: PageMapPreviewActionProps) {
  const route = pageRouteFromFilePath(props.node.filePath, props.node.notes);
  // Remount the local draft on every target change, including A -> B -> A.
  // Example values never enter map persistence, browser storage, or agent prompts.
  const scope = JSON.stringify([
    props.projectId,
    props.node.id,
    props.node.filePath,
    route,
    !!props.node.planned,
  ]);
  return <PagePreviewDraft key={scope} {...props} route={route} />;
}

function PagePreviewDraft({
  projectId,
  node,
  onOpenPreview,
  route,
}: PageMapPreviewActionProps & { route: string }) {
  const id = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const result = resolvePageRouteExample(route, values);
  const unavailable = node.planned
    ? "Build this page before opening it in Preview."
    : !node.filePath.trim()
      ? "This page needs a mapped source file before it can open in Preview."
      : !Number.isSafeInteger(projectId) || projectId <= 0
        ? "Choose a project before opening Preview."
        : result.kind === "unsupported"
          ? "This route needs a concrete path. Open Preview directly to inspect it."
          : null;
  const canOpen =
    !unavailable && result.kind === "ready" && !!pagePreviewUrl(projectId, result.route);
  const hasParameters = !unavailable && result.parameters.length > 0;

  return (
    <section
      aria-labelledby={id + "-heading"}
      className="rounded-xl border border-border bg-muted/20 p-3 space-y-3"
    >
      <h3 id={id + "-heading"} className="text-xs font-semibold text-foreground">
        Open this page
      </h3>
      <code dir="ltr" className="block break-all text-[11px] text-muted-foreground">
        {route}
      </code>
      <p id={id + "-help"} className="text-[11px] leading-relaxed text-muted-foreground">
        {unavailable ??
          (hasParameters
            ? "Enter an existing record ID or slug. These example values are temporary and stay in this panel."
            : "Open this route in the project's Preview.")}
      </p>
      {hasParameters &&
        result.parameters.map((name, index) => {
          const invalid =
            result.kind === "too-long" ||
            (result.kind === "invalid-value" && result.parameter === name);
          return (
            <div key={name} className="space-y-1.5">
              <label
                htmlFor={id + "-value-" + index}
                className="block break-all text-xs font-medium"
              >
                {"Example " + name}
              </label>
              <input
                id={id + "-value-" + index}
                value={Object.prototype.hasOwnProperty.call(values, name) ? values[name] : ""}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [name]: event.target.value }))
                }
                type="text"
                autoComplete="off"
                spellCheck={false}
                maxLength={256}
                dir="auto"
                aria-required="true"
                aria-invalid={invalid}
                aria-describedby={id + "-help" + (invalid ? " " + id + "-error" : "")}
                className="w-full min-w-0 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
              />
            </div>
          );
        })}
      {!unavailable && (result.kind === "invalid-value" || result.kind === "too-long") && (
        <p role="alert" id={id + "-error"} className="text-[11px] text-destructive">
          {result.kind === "too-long"
            ? "These example values make the preview path too long. Shorten one or more values to continue."
            : "Use a single ID or slug for " +
              result.parameter +
              ", without spaces, URL separators, or encoded characters."}
        </p>
      )}
      <p aria-live="polite" className="break-all text-[11px] text-muted-foreground">
        {canOpen && result.kind === "ready"
          ? "Ready to open: " + result.route
          : hasParameters && result.kind === "needs-values"
            ? "Enter each example value to continue."
            : null}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full gap-1.5 text-xs"
        disabled={!canOpen}
        onClick={() => {
          if (canOpen && result.kind === "ready") onOpenPreview(result.route);
        }}
      >
        Open in Preview <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
      </Button>
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        Opening Preview does not confirm that the page works. Existing app sign-in and permissions
        still apply.
      </p>
    </section>
  );
}
