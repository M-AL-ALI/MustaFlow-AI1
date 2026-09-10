import { useState, useEffect, useId } from "react";
import { X, ArrowRight, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ConnectionType } from "./page-edge";
import {
  copyPageMapTransition,
  manualPageMapTransition,
  transitionDraftError,
  transitionEvidenceLabel,
  transitionSummary,
  type PageMapTransition,
} from "./page-map-transition-model";

export type PageMapEdgeState = {
  id: string;
  sourceLabel: string;
  targetLabel: string;
  connectionType: ConnectionType;
  aiGenerated: boolean;
  transition?: PageMapTransition;
  unresolved?: boolean;
  pending?: boolean;
};

type EdgeDetailPanelProps = {
  edge: PageMapEdgeState | null;
  onClose: () => void;
  onSave: (edgeId: string, connectionType: ConnectionType, transition: PageMapTransition) => void;
  onDelete: (edgeId: string) => void;
  onDraftStart?: () => void;
  onDraftEnd?: () => void;
};

const inputClass =
  "w-full rounded-md border border-border bg-muted px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50";

export function EdgeDetailPanel({
  edge,
  onClose,
  onSave,
  onDelete,
  onDraftStart,
  onDraftEnd,
}: EdgeDetailPanelProps) {
  const formId = useId();
  const [connectionType, setConnectionType] = useState<ConnectionType>("nav");
  const [draft, setDraft] = useState<PageMapTransition>(() => copyPageMapTransition());
  const [dirty, setDirty] = useState(false);
  const [unknownText, setUnknownText] = useState("");

  useEffect(() => {
    setConnectionType(edge?.connectionType ?? "nav");
    setDraft(copyPageMapTransition(edge?.transition));
    setUnknownText(edge?.transition?.unknowns?.join("\n") ?? "");
    setDirty(false);
  }, [edge]);

  if (!edge) return null;
  const error = transitionDraftError(draft);
  const displayed = dirty ? manualPageMapTransition(draft) : draft;
  const change = (next: PageMapTransition) => {
    onDraftStart?.();
    setDirty(true);
    setDraft(next);
  };
  const discard = () => {
    setConnectionType(edge.connectionType);
    setDraft(copyPageMapTransition(edge.transition));
    setUnknownText(edge.transition?.unknowns?.join("\n") ?? "");
    setDirty(false);
    onDraftEnd?.();
  };
  const close = () => {
    onDraftEnd?.();
    onClose();
  };
  const save = () => {
    if (!dirty || error) return;
    onSave(edge.id, connectionType, manualPageMapTransition(draft));
    setDirty(false);
    onDraftEnd?.();
  };
  const fieldId = (name: string) => formId + "-" + name;

  return (
    <aside
      aria-label={edge.unresolved ? "Unresolved transition details" : "Transition details"}
      className={cn(
        "absolute right-0 top-0 bottom-0 z-20 w-80 max-w-full border-l border-border bg-card shadow-xl",
        "flex flex-col",
      )}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold">
          {edge.unresolved ? "Unresolved transition" : "Transition"}
        </h3>
        <button
          type="button"
          aria-label={dirty ? "Discard draft and close transition" : "Close transition details"}
          onClick={close}
          className="rounded p-1 text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2 py-2 text-xs">
          <span className="min-w-0 flex-1 break-words">{edge.sourceLabel}</span>
          <ArrowRight className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 break-words">{edge.targetLabel}</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Map only. Saving these claims does not change app navigation or start generation.
        </p>
        <p className="break-words text-xs">{transitionSummary(displayed)}</p>
        <p role="status" className="text-[11px] text-muted-foreground">
          {dirty
            ? "Manual draft; not saved"
            : transitionEvidenceLabel(edge.transition, edge.pending)}
        </p>

        {!edge.unresolved && (
          <div className="space-y-1">
            <label htmlFor={fieldId("type")} className="text-xs font-medium">
              Mapped connection type
            </label>
            <select
              id={fieldId("type")}
              className={inputClass}
              value={connectionType}
              onChange={(event) => {
                onDraftStart?.();
                setDirty(true);
                setConnectionType(event.target.value as ConnectionType);
              }}
            >
              <option value="nav">Navigation</option>
              <option value="auth-gate">Access gate (mapped claim)</option>
              <option value="redirect">Redirect</option>
              <option value="external">External link</option>
            </select>
          </div>
        )}

        <fieldset className="space-y-2">
          <legend className="mb-1 text-xs font-semibold">Action and control</legend>
          <label className="block text-xs" htmlFor={fieldId("action")}>
            Action
          </label>
          <select
            id={fieldId("action")}
            className={inputClass}
            value={draft.action.kind}
            onChange={(event) =>
              change({
                ...draft,
                action: {
                  ...draft.action,
                  kind: event.target.value as PageMapTransition["action"]["kind"],
                },
              })
            }
          >
            {["unknown", "click", "submit", "load", "programmatic"].map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
          <label className="block text-xs" htmlFor={fieldId("action-label")}>
            Action label
          </label>
          <input
            id={fieldId("action-label")}
            className={inputClass}
            value={draft.action.label ?? ""}
            maxLength={240}
            onChange={(event) =>
              change({
                ...draft,
                action: { ...draft.action, label: event.target.value || undefined },
              })
            }
          />
          <label className="block text-xs" htmlFor={fieldId("control")}>
            Control kind
          </label>
          <select
            id={fieldId("control")}
            className={inputClass}
            value={draft.control.kind}
            onChange={(event) =>
              change({
                ...draft,
                control: {
                  ...draft.control,
                  kind: event.target.value as PageMapTransition["control"]["kind"],
                },
              })
            }
          >
            {["unknown", "link", "button", "form", "call", "other"].map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
          <label className="block text-xs" htmlFor={fieldId("control-label")}>
            Control label
          </label>
          <input
            id={fieldId("control-label")}
            className={inputClass}
            value={draft.control.label ?? ""}
            maxLength={240}
            onChange={(event) =>
              change({
                ...draft,
                control: { ...draft.control, label: event.target.value || undefined },
              })
            }
          />
          <label className="block text-xs" htmlFor={fieldId("locator")}>
            Control locator (description only)
          </label>
          <input
            id={fieldId("locator")}
            className={inputClass}
            value={draft.control.locator ?? ""}
            maxLength={1024}
            onChange={(event) =>
              change({
                ...draft,
                control: { ...draft.control, locator: event.target.value || undefined },
              })
            }
          />
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="mb-1 text-xs font-semibold">Condition</legend>
          <label className="block text-xs" htmlFor={fieldId("condition")}>
            Condition kind
          </label>
          <select
            id={fieldId("condition")}
            className={inputClass}
            value={draft.condition.kind}
            onChange={(event) => {
              const kind = event.target.value as PageMapTransition["condition"]["kind"];
              change({
                ...draft,
                condition:
                  kind === "predicate"
                    ? {
                        kind,
                        expression: draft.condition.expression ?? "",
                        branch: draft.condition.branch,
                      }
                    : { kind, branch: "unknown" },
              });
            }}
          >
            <option value="unknown">Unknown</option>
            <option value="none">No condition mapped</option>
            <option value="predicate">Predicate (descriptive)</option>
          </select>
          {draft.condition.kind === "predicate" && (
            <>
              <label className="block text-xs" htmlFor={fieldId("predicate")}>
                Predicate description
              </label>
              <textarea
                id={fieldId("predicate")}
                className={inputClass}
                rows={2}
                maxLength={2000}
                value={draft.condition.expression ?? ""}
                onChange={(event) =>
                  change({
                    ...draft,
                    condition: { ...draft.condition, expression: event.target.value },
                  })
                }
              />
              <label className="block text-xs" htmlFor={fieldId("branch")}>
                Branch
              </label>
              <select
                id={fieldId("branch")}
                className={inputClass}
                value={draft.condition.branch}
                onChange={(event) =>
                  change({
                    ...draft,
                    condition: {
                      ...draft.condition,
                      branch: event.target.value as PageMapTransition["condition"]["branch"],
                    },
                  })
                }
              >
                <option value="unknown">Unknown</option>
                <option value="true">True</option>
                <option value="false">False</option>
              </select>
            </>
          )}
          <p className="text-[11px] text-muted-foreground">
            Unknown is not unconditional. Predicates are not evaluated.
          </p>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="mb-1 text-xs font-semibold">Outcome and destination</legend>
          <label className="block text-xs" htmlFor={fieldId("outcome")}>
            Outcome
          </label>
          <select
            id={fieldId("outcome")}
            className={inputClass}
            value={draft.outcome.kind}
            onChange={(event) =>
              change({
                ...draft,
                outcome: {
                  ...draft.outcome,
                  kind: event.target.value as PageMapTransition["outcome"]["kind"],
                },
              })
            }
          >
            {["unknown", "navigate", "redirect", "external", "stay"].map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
          <label className="block text-xs" htmlFor={fieldId("outcome-detail")}>
            Outcome detail
          </label>
          <textarea
            id={fieldId("outcome-detail")}
            className={inputClass}
            rows={2}
            value={draft.outcome.detail ?? ""}
            maxLength={1000}
            onChange={(event) =>
              change({
                ...draft,
                outcome: { ...draft.outcome, detail: event.target.value || undefined },
              })
            }
          />
          <label className="block text-xs" htmlFor={fieldId("destination")}>
            Destination kind
          </label>
          <select
            id={fieldId("destination")}
            className={inputClass}
            value={draft.destination.kind}
            onChange={(event) => {
              const kind = event.target.value as PageMapTransition["destination"]["kind"];
              change({
                ...draft,
                destination:
                  kind === "unknown" ? { kind } : { kind, value: draft.destination.value ?? "" },
              });
            }}
          >
            <option value="unknown">Unknown</option>
            <option value="route">App route (descriptive)</option>
            <option value="external">External HTTP(S)</option>
          </select>
          {draft.destination.kind !== "unknown" && (
            <>
              <label className="block text-xs" htmlFor={fieldId("destination-value")}>
                Destination value
              </label>
              <input
                id={fieldId("destination-value")}
                className={inputClass}
                value={draft.destination.value ?? ""}
                maxLength={2048}
                onChange={(event) =>
                  change({
                    ...draft,
                    destination: { ...draft.destination, value: event.target.value },
                  })
                }
              />
            </>
          )}
          <p className="text-[11px] text-muted-foreground">
            Editing a destination does not retarget an arrow, open a URL, or create a page.
          </p>
        </fieldset>

        <div className="space-y-1">
          <label className="text-xs font-medium" htmlFor={fieldId("unknowns")}>
            Unresolved questions (one per line)
          </label>
          <textarea
            id={fieldId("unknowns")}
            className={inputClass}
            rows={3}
            value={unknownText}
            onChange={(event) => {
              setUnknownText(event.target.value);
              const unknowns = event.target.value
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean);
              change({ ...draft, unknowns: unknowns.length ? unknowns : undefined });
            }}
          />
        </div>

        <section aria-label="Transition evidence" className="space-y-2 border-t border-border pt-3">
          <h4 className="text-xs font-semibold">Evidence (read-only)</h4>
          <p className="text-[11px] text-muted-foreground">
            Historical source is a declaration at a recorded file hash, not current-source freshness
            or runtime observation. No runtime behavior has been verified here.
          </p>
          {displayed.evidence.length === 0 ? (
            <p className="text-xs text-muted-foreground">Evidence unknown for all fields.</p>
          ) : (
            displayed.evidence.map((item, index) => (
              <div
                key={index}
                className="space-y-1 rounded border border-border bg-muted/30 p-2 text-[11px]"
              >
                <p>
                  {item.basis === "source" ? "Historical source" : item.basis}:{" "}
                  {item.fields.join(", ")}
                </p>
                {item.source && (
                  <p className="break-all font-mono">
                    {item.source.filePath}
                    <br />
                    SHA256 {item.source.contentSha256}
                    <br />
                    UTF-16 span [{item.source.startOffset}, {item.source.endOffset})
                  </p>
                )}
              </div>
            ))
          )}
        </section>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
      <div className="shrink-0 space-y-2 border-t border-border px-4 py-3">
        <Button
          type="button"
          className="h-8 w-full text-xs"
          disabled={!dirty || !!error}
          onClick={save}
        >
          Save mapped transition
        </Button>
        {dirty && (
          <Button type="button" variant="ghost" className="h-8 w-full text-xs" onClick={discard}>
            Discard transition draft
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          className="h-8 w-full gap-1 text-xs text-destructive"
          onClick={() => {
            onDraftEnd?.();
            onDelete(edge.id);
          }}
        >
          <Trash2 className="h-3 w-3" aria-hidden="true" />
          Remove {edge.unresolved ? "candidate" : "transition"} from map
        </Button>
      </div>
    </aside>
  );
}
