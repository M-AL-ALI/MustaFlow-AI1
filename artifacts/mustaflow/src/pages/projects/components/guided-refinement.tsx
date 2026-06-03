import { authFetch } from "@/lib/api-fetch";
import { useState, useEffect } from "react";
import { HelpCircle, ChevronRight, Loader2, Send, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type ClarifyingQuestion = {
  id: string;
  question: string;
  hint?: string;
  required: boolean;
};

interface GuidedRefinementCardProps {
  questions: ClarifyingQuestion[];
  originalPrompt: string;
  clarificationReason: string;
  onSubmit: (enrichedPrompt: string) => void;
  onSkip: () => void;
}

export function GuidedRefinementCard({
  questions,
  originalPrompt,
  clarificationReason,
  onSubmit,
  onSkip,
}: GuidedRefinementCardProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [currentIdx, setCurrentIdx] = useState(0);

  const requiredQuestions = questions.filter((q) => q.required);
  const allRequiredAnswered = requiredQuestions.every(
    (q) => (answers[q.id]?.trim() ?? "").length > 0,
  );

  const handleSubmit = () => {
    // Build an enriched prompt with original + answers
    const answerLines = questions
      .filter((q) => (answers[q.id]?.trim() ?? "") !== "")
      .map((q) => `${q.question}: ${answers[q.id]!.trim()}`);

    const enriched =
      answerLines.length > 0
        ? `${originalPrompt}\n\nAdditional context:\n${answerLines.map((l) => `- ${l}`).join("\n")}`
        : originalPrompt;

    onSubmit(enriched);
  };

  const isLastQuestion = currentIdx >= questions.length - 1;

  return (
    <div className="mt-2 bg-background border border-border rounded-xl text-xs overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-border flex items-center gap-2">
        <HelpCircle className="h-3.5 w-3.5 text-blue-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-foreground text-xs">A few quick questions</div>
          {clarificationReason && (
            <div className="text-[10px] text-muted-foreground mt-0.5">{clarificationReason}</div>
          )}
        </div>
        <button
          onClick={onSkip}
          className="text-muted-foreground hover:text-foreground transition-colors"
          title="Skip and generate plan with original prompt"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Progress dots */}
      {questions.length > 1 && (
        <div className="flex items-center gap-1 px-3 pt-2">
          {questions.map((_, i) => (
            <button
              key={i}
              onClick={() => setCurrentIdx(i)}
              className={cn(
                "h-1.5 rounded-full transition-all",
                i === currentIdx ? "w-4 bg-primary" : "w-1.5 bg-border",
                i < currentIdx && "bg-primary/40",
              )}
              aria-label={`Question ${i + 1}`}
            />
          ))}
        </div>
      )}

      {/* Current question */}
      <div className="px-3 py-3">
        {questions[currentIdx] && (
          <div className="space-y-2">
            <div className="text-[11px] font-medium text-foreground leading-snug">
              {questions[currentIdx].question}
              {questions[currentIdx].required && (
                <span className="ml-1 text-destructive/70">*</span>
              )}
            </div>
            {questions[currentIdx].hint && (
              <div className="text-[10px] text-muted-foreground/60 italic">
                {questions[currentIdx].hint}
              </div>
            )}
            <textarea
              value={answers[questions[currentIdx].id] ?? ""}
              onChange={(e) =>
                setAnswers((prev) => ({
                  ...prev,
                  [questions[currentIdx].id]: e.target.value,
                }))
              }
              placeholder="Your answer…"
              rows={2}
              className="w-full bg-muted/50 border border-border rounded-lg px-2 py-1.5 text-[11px] text-foreground focus:outline-none focus:border-primary/60 resize-none placeholder:text-muted-foreground/50"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !isLastQuestion) {
                  e.preventDefault();
                  setCurrentIdx((i) => Math.min(i + 1, questions.length - 1));
                }
              }}
            />
          </div>
        )}
      </div>

      {/* Navigation + Submit */}
      <div className="px-3 pb-3 flex items-center gap-2">
        {currentIdx > 0 && (
          <button
            onClick={() => setCurrentIdx((i) => Math.max(i - 1, 0))}
            className="text-[10px] text-muted-foreground hover:text-foreground px-2 py-1 rounded transition-colors"
          >
            Back
          </button>
        )}
        <div className="flex-1" />
        {!isLastQuestion ? (
          <button
            onClick={() => setCurrentIdx((i) => Math.min(i + 1, questions.length - 1))}
            className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg bg-primary/10 text-primary hover:bg-primary/15 transition-colors"
          >
            Next <ChevronRight className="h-3 w-3" />
          </button>
        ) : (
          <button
            onClick={handleSubmit}
            disabled={!allRequiredAnswered}
            className={cn(
              "flex items-center gap-1.5 text-[11px] px-3 py-1 rounded-lg font-medium transition-colors",
              allRequiredAnswered
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : "bg-muted text-muted-foreground cursor-not-allowed",
            )}
          >
            <Send className="h-3 w-3" />
            Generate plan
          </button>
        )}
        <button
          onClick={onSkip}
          className="text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
        >
          Skip
        </button>
      </div>
    </div>
  );
}

interface GuidedRefinementLoaderProps {
  projectId: number;
  prompt: string;
  agentMode: string;
  onReady: (enrichedPrompt: string) => void;
  onSkip: () => void;
}

export function GuidedRefinementLoader({
  projectId,
  prompt,
  agentMode,
  onReady,
  onSkip,
}: GuidedRefinementLoaderProps) {
  const [state, setState] = useState<
    | { phase: "checking" }
    | { phase: "questions"; questions: ClarifyingQuestion[]; reason: string }
    | { phase: "clear" }
  >({ phase: "checking" });

  // Auto-trigger check on mount
  useEffect(() => {
    const check = async () => {
      try {
        const res = await authFetch(`/api/projects/${projectId}/plans/clarify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ prompt, agentMode }),
        });
        if (!res.ok) {
          setState({ phase: "clear" });
          return;
        }
        const data = (await res.json()) as {
          needsClarification: boolean;
          questions: ClarifyingQuestion[];
          clarificationReason: string;
        };
        if (data.needsClarification && data.questions.length > 0) {
          setState({
            phase: "questions",
            questions: data.questions,
            reason: data.clarificationReason,
          });
        } else {
          setState({ phase: "clear" });
        }
      } catch {
        setState({ phase: "clear" });
      }
    };
    void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state.phase === "checking") {
    return (
      <div className="mt-2 flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-[11px] text-muted-foreground bg-background">
        <Loader2 className="h-3 w-3 animate-spin shrink-0" />
        Checking if I need any details before planning…
        <button
          onClick={onSkip}
          className="ml-auto text-muted-foreground/50 hover:text-muted-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    );
  }

  if (state.phase === "clear") {
    // Auto-proceed with original prompt
    onReady(prompt);
    return null;
  }

  return (
    <GuidedRefinementCard
      questions={state.questions}
      originalPrompt={prompt}
      clarificationReason={state.reason}
      onSubmit={onReady}
      onSkip={onSkip}
    />
  );
}
