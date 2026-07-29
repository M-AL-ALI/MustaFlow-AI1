import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";

export type InlineNarrationEntry = {
  id: number;
  text: string;
};

const MAX_VISIBLE_NARRATION_LINES = 12;
const WORD_INTERVAL_MS = 38;

export function appendNarrationEntry(
  current: InlineNarrationEntry[],
  next: InlineNarrationEntry,
): InlineNarrationEntry[] {
  const text = next.text.trim();
  if (!text || current.some((entry) => entry.id === next.id)) return current;

  return [...current, { ...next, text }]
    .sort((left, right) => left.id - right.id)
    .slice(-MAX_VISIBLE_NARRATION_LINES);
}

function narrationTokens(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [];
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

type WordByWordLineProps = {
  text: string;
  stream: boolean;
};

function WordByWordLine({ text, stream }: WordByWordLineProps) {
  const tokens = useMemo(() => narrationTokens(text), [text]);
  const [visibleTokenCount, setVisibleTokenCount] = useState(() =>
    stream && !prefersReducedMotion() ? Math.min(1, tokens.length) : tokens.length,
  );

  useEffect(() => {
    if (!stream || prefersReducedMotion()) {
      setVisibleTokenCount(tokens.length);
      return;
    }

    setVisibleTokenCount(Math.min(1, tokens.length));
    if (tokens.length <= 1) return;

    const timer = window.setInterval(() => {
      setVisibleTokenCount((current) => {
        if (current >= tokens.length) {
          window.clearInterval(timer);
          return current;
        }
        return current + 1;
      });
    }, WORD_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [stream, text, tokens.length]);

  if (!stream) return <>{text}</>;

  const visibleText = tokens.slice(0, visibleTokenCount).join("");
  const complete = visibleTokenCount >= tokens.length;

  return (
    <>
      <span className="relative block">
        <span aria-hidden="true" className="invisible block">
          {text}
        </span>
        <span aria-hidden="true" className="absolute inset-0 block">
          {visibleText}
          {!complete && (
            <span className="ml-0.5 inline-block h-3 w-px animate-pulse bg-current align-middle opacity-50" />
          )}
        </span>
      </span>
      <span className="sr-only" aria-live="polite">
        {complete ? text : ""}
      </span>
    </>
  );
}

type InlineNarrationStreamProps = {
  entries: InlineNarrationEntry[];
  live?: boolean;
  className?: string;
};

export function InlineNarrationStream({
  entries,
  live = false,
  className,
}: InlineNarrationStreamProps) {
  if (entries.length === 0) return null;

  const lastEntryId = entries.at(-1)?.id;

  return (
    <div
      className={cn("space-y-1 text-xs leading-5 text-muted-foreground", className)}
      data-testid="inline-narration-stream"
    >
      {entries.map((entry) => (
        <div key={entry.id} data-testid="inline-narration-line">
          <WordByWordLine text={entry.text} stream={live && entry.id === lastEntryId} />
        </div>
      ))}
    </div>
  );
}
