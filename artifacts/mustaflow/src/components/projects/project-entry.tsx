import { BookOpen, LayoutTemplate } from "lucide-react";
import { ProjectComposer } from "./project-composer";

type ProjectEntryProps = {
  prompt: string;
  onPromptChange: (prompt: string) => void;
  onContinue: (prompt: string, platform: "web" | "mobile") => void;
  onBrainstorm: () => void;
  onTemplates: () => void;
  onGuide: () => void;
  templatesOpen?: boolean;
};

// The public entry and dashboard share interaction rules, not parallel composers.
export function ProjectEntry({
  prompt,
  onPromptChange,
  onContinue,
  onBrainstorm,
  onTemplates,
  onGuide,
  templatesOpen = false,
}: ProjectEntryProps) {
  return (
    <div className="nabuflow-shell rounded-2xl border border-border bg-background px-5 py-8 text-foreground sm:px-10 sm:py-12">
      <div className="mx-auto mb-8 flex max-w-[760px] items-center justify-between gap-4">
        <span className="text-sm font-semibold tracking-tight">NabuFlow</span>
        <span className="text-xs text-muted-foreground">An idea is enough to begin</span>
      </div>
      <ProjectComposer
        prompt={prompt}
        onPromptChange={onPromptChange}
        onContinue={onContinue}
        onBrainstorm={onBrainstorm}
      />
      <div className="mx-auto max-w-[760px] border-t border-border pt-5">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <button
            type="button"
            className="nf-quiet-link"
            aria-expanded={templatesOpen}
            onClick={onTemplates}
          >
            <LayoutTemplate size={15} aria-hidden="true" />
            {templatesOpen ? "Hide templates" : "Explore templates"}
          </button>
          <button type="button" className="nf-quiet-link" onClick={onGuide}>
            <BookOpen size={15} aria-hidden="true" />
            Help me choose a starting point
          </button>
        </div>
        <p className="mt-5 max-w-xl text-xs leading-relaxed text-muted-foreground">
          Continue keeps your idea and Web or Mobile choice in this tab for up to 30 minutes. Review
          the brief and project name before creating your project.
        </p>
      </div>
    </div>
  );
}
