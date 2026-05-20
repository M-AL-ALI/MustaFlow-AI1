import { useEffect, useRef, useState } from "react";
import { Sparkles, ArrowRight, Loader2, CheckCircle2, Monitor } from "lucide-react";

const PROMPT_TEXT = "A marketplace for local artists to sell prints";

const BUILD_LINES = [
  { delay: 0, text: "Planning project structure..." },
  { delay: 400, text: "Generating layout & navigation..." },
  { delay: 900, text: "Building product listing grid..." },
  { delay: 1400, text: "Adding search & filter sidebar..." },
  { delay: 1900, text: "Styling with Tailwind CSS..." },
  { delay: 2400, text: "Wiring up interactions..." },
  { delay: 2900, text: "Optimising for mobile..." },
  { delay: 3200, text: "Finalising & previewing..." },
];

type Phase = "typing" | "building" | "preview" | "done";

const PHASE_DURATIONS: Record<Phase, number> = {
  typing: 2800,
  building: 4200,
  preview: 4000,
  done: 0,
};

const LOOP_PHASES: Phase[] = ["typing", "building", "preview"];

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return reduced;
}

function useLoop(phases: Phase[], phaseDurations: Record<Phase, number>, paused: boolean) {
  const [phase, setPhase] = useState<Phase>(phases[0]);
  const [phaseIndex, setPhaseIndex] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (paused) return;
    const current = phases[phaseIndex];
    const duration = phaseDurations[current];
    timerRef.current = setTimeout(() => {
      const next = (phaseIndex + 1) % phases.length;
      setPhaseIndex(next);
      setPhase(phases[next]);
    }, duration);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [phaseIndex, paused, phases, phaseDurations]);

  return phase;
}

function TypingPhase() {
  const [displayed, setDisplayed] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    setDisplayed("");
    setDone(false);
    let i = 0;
    const interval = setInterval(() => {
      i++;
      setDisplayed(PROMPT_TEXT.slice(0, i));
      if (i >= PROMPT_TEXT.length) {
        clearInterval(interval);
        setTimeout(() => setDone(true), 300);
      }
    }, 42);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex flex-col h-full justify-center px-6 gap-4">
      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-1">
        Step 1 — Describe your idea
      </div>
      <div className="bg-card border border-border rounded-2xl p-2 flex items-center gap-2 shadow-lg">
        <div className="pl-3 text-primary shrink-0">
          <Sparkles className="h-5 w-5" />
        </div>
        <div className="flex-1 text-sm py-2 px-1 text-foreground min-h-[2rem] flex items-center">
          <span>{displayed}</span>
          <span className="inline-block w-0.5 h-4 bg-primary ml-0.5 animate-pulse" />
        </div>
        <div
          className={`shrink-0 rounded-xl px-4 py-2 text-xs font-semibold flex items-center gap-1.5 transition-all duration-300 ${
            done ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
          }`}
        >
          Start Building
          <ArrowRight className="h-3.5 w-3.5" />
        </div>
      </div>
      <p className="text-xs text-muted-foreground text-center">
        Plain English — no templates, no forms
      </p>
    </div>
  );
}

function BuildingPhase() {
  const [visibleLines, setVisibleLines] = useState<string[]>([]);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    setVisibleLines([]);
    setProgress(0);

    const timers: ReturnType<typeof setTimeout>[] = [];
    BUILD_LINES.forEach(({ delay, text }) => {
      timers.push(
        setTimeout(() => {
          setVisibleLines((prev) => [...prev, text]);
          setProgress(
            Math.round(
              ((BUILD_LINES.findIndex((l) => l.text === text) + 1) / BUILD_LINES.length) * 100,
            ),
          );
        }, delay),
      );
    });
    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <div className="flex flex-col h-full justify-center px-6 gap-3">
      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-1">
        Step 2 — AI builds it
      </div>
      <div className="bg-card border border-border rounded-xl overflow-hidden shadow-lg">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border bg-muted/40">
          <Loader2 className="h-3.5 w-3.5 text-primary animate-spin" />
          <span className="text-xs font-medium text-foreground">Building your marketplace...</span>
          <span className="ml-auto text-xs text-muted-foreground font-mono">{progress}%</span>
        </div>
        <div className="p-4 space-y-1.5 font-mono text-xs min-h-[120px]">
          {BUILD_LINES.map((line) => {
            const isVisible = visibleLines.includes(line.text);
            const isDone =
              (isVisible && line !== BUILD_LINES[BUILD_LINES.length - 1]) || progress === 100;
            return (
              <div
                key={line.text}
                className={`flex items-center gap-2 transition-all duration-300 ${
                  isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1"
                }`}
              >
                {isDone ? (
                  <CheckCircle2 className="h-3 w-3 text-primary shrink-0" />
                ) : isVisible ? (
                  <Loader2 className="h-3 w-3 text-muted-foreground animate-spin shrink-0" />
                ) : (
                  <div className="h-3 w-3 shrink-0" />
                )}
                <span className={isDone ? "text-foreground" : "text-muted-foreground"}>
                  {line.text}
                </span>
              </div>
            );
          })}
        </div>
        <div className="px-4 pb-4">
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-500 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function PreviewPhase() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 80);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="flex flex-col h-full justify-center px-6 gap-3">
      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-1">
        Step 3 — Live preview
      </div>
      <div
        className={`bg-card border border-border rounded-xl overflow-hidden shadow-lg transition-all duration-500 ${
          mounted ? "opacity-100 scale-100" : "opacity-0 scale-95"
        }`}
      >
        {/* Browser chrome */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/40">
          <div className="flex gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-red-400/70" />
            <div className="w-2.5 h-2.5 rounded-full bg-yellow-400/70" />
            <div className="w-2.5 h-2.5 rounded-full bg-green-400/70" />
          </div>
          <div className="flex-1 bg-muted rounded-md px-2 py-0.5 text-[10px] text-muted-foreground font-mono truncate">
            mustaflow.app/p/artist-marketplace
          </div>
          <Monitor className="h-3 w-3 text-muted-foreground" />
        </div>
        {/* Fake app preview */}
        <div className="bg-white dark:bg-zinc-900 p-3">
          {/* App nav */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-1.5">
              <div className="w-4 h-4 rounded bg-violet-500" />
              <div className="w-20 h-2.5 rounded bg-zinc-800 dark:bg-zinc-200" />
            </div>
            <div className="flex gap-2">
              <div className="w-12 h-2 rounded bg-zinc-200 dark:bg-zinc-700" />
              <div className="w-12 h-2 rounded bg-zinc-200 dark:bg-zinc-700" />
              <div className="w-16 h-5 rounded bg-violet-500" />
            </div>
          </div>
          {/* Search bar */}
          <div className="h-7 rounded-lg bg-zinc-100 dark:bg-zinc-800 mb-3 flex items-center px-2 gap-2">
            <div className="w-3 h-3 rounded-full bg-zinc-300 dark:bg-zinc-600" />
            <div className="w-32 h-2 rounded bg-zinc-300 dark:bg-zinc-600" />
          </div>
          {/* Product grid */}
          <div className="grid grid-cols-3 gap-2">
            {[
              { color: "bg-rose-200 dark:bg-rose-800", w: "w-14", label: "w-10" },
              { color: "bg-sky-200 dark:bg-sky-800", w: "w-12", label: "w-12" },
              { color: "bg-amber-200 dark:bg-amber-800", w: "w-16", label: "w-8" },
              { color: "bg-emerald-200 dark:bg-emerald-800", w: "w-10", label: "w-14" },
              { color: "bg-purple-200 dark:bg-purple-800", w: "w-14", label: "w-10" },
              { color: "bg-pink-200 dark:bg-pink-800", w: "w-12", label: "w-11" },
            ].map((card, i) => (
              <div key={i} className="rounded-lg bg-zinc-50 dark:bg-zinc-800 overflow-hidden">
                <div className={`${card.color} h-12 w-full`} />
                <div className="p-1.5 space-y-1">
                  <div className={`h-1.5 rounded ${card.w} bg-zinc-300 dark:bg-zinc-600`} />
                  <div className={`h-1.5 rounded ${card.label} bg-zinc-200 dark:bg-zinc-700`} />
                  <div className="w-8 h-3 rounded bg-violet-400 mt-1" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-center gap-1.5">
        <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
        <span className="text-xs text-muted-foreground">
          Live at your public URL — share it instantly
        </span>
      </div>
    </div>
  );
}

export function DemoAnimation() {
  const reducedMotion = usePrefersReducedMotion();
  const phase = useLoop(LOOP_PHASES, PHASE_DURATIONS, reducedMotion);

  return (
    <div className="relative w-full max-w-lg mx-auto">
      {/* Glow backdrop */}
      <div className="absolute -inset-8 bg-[radial-gradient(ellipse_at_center,hsl(var(--primary)/0.12)_0%,transparent_70%)] blur-3xl pointer-events-none" />

      {/* Outer frame */}
      <div className="relative rounded-3xl border border-border bg-background/80 backdrop-blur-sm shadow-2xl overflow-hidden">
        {/* Top chrome bar */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-muted/30">
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-border" />
            <div className="w-3 h-3 rounded-full bg-border" />
            <div className="w-3 h-3 rounded-full bg-border" />
          </div>
          <div className="flex-1 flex items-center justify-center">
            <div className="flex gap-1">
              {LOOP_PHASES.map((p) => (
                <div
                  key={p}
                  className={`h-1 rounded-full transition-all duration-500 ${
                    phase === p ? "w-6 bg-primary" : "w-1.5 bg-border"
                  }`}
                />
              ))}
            </div>
          </div>
          <div className="w-14" />
        </div>

        {/* Phase content — reduced-motion: show static preview only */}
        <div className="relative h-[240px]">
          {reducedMotion ? (
            <div className="absolute inset-0">
              <PreviewPhase />
            </div>
          ) : (
            <>
              <div
                className={`absolute inset-0 transition-all duration-300 ${
                  phase === "typing" ? "opacity-100" : "opacity-0 pointer-events-none"
                }`}
              >
                {phase === "typing" && <TypingPhase />}
              </div>
              <div
                className={`absolute inset-0 transition-all duration-300 ${
                  phase === "building" ? "opacity-100" : "opacity-0 pointer-events-none"
                }`}
              >
                {phase === "building" && <BuildingPhase />}
              </div>
              <div
                className={`absolute inset-0 transition-all duration-300 ${
                  phase === "preview" ? "opacity-100" : "opacity-0 pointer-events-none"
                }`}
              >
                {phase === "preview" && <PreviewPhase />}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
