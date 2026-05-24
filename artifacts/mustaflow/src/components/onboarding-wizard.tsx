import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Briefcase,
  UtensilsCrossed,
  Building2,
  Palette,
  GraduationCap,
  Heart,
  CalendarCheck,
  ShoppingCart,
  Zap,
  Sparkles,
  ArrowRight,
  ChevronRight,
  X,
} from "lucide-react";
import { ONBOARDING_INDUSTRIES, TEMPLATES } from "@/lib/templates";
import type { TemplateDefinition } from "@/lib/templates";

const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  Briefcase,
  UtensilsCrossed,
  Building2,
  Palette,
  GraduationCap,
  Heart,
  CalendarCheck,
  ShoppingCart,
  Zap,
  Sparkles,
};

const FIRST_RUN_KEY = "mustaflow_onboarding_completed";

export function hasCompletedOnboarding(): boolean {
  try {
    return localStorage.getItem(FIRST_RUN_KEY) === "1";
  } catch {
    return false;
  }
}

export function markOnboardingComplete(): void {
  try {
    localStorage.setItem(FIRST_RUN_KEY, "1");
  } catch {
    // no-op
  }
}

interface OnboardingWizardProps {
  onUseTemplate: (template: TemplateDefinition) => void;
  onSkip: () => void;
}

type Step = "industry" | "template";

export function OnboardingWizard({ onUseTemplate, onSkip }: OnboardingWizardProps) {
  const [step, setStep] = useState<Step>("industry");
  const [selectedIndustry, setSelectedIndustry] = useState<string | null>(null);

  function handleIndustrySelect(industryId: string) {
    setSelectedIndustry(industryId);
    setStep("template");
  }

  const industry = ONBOARDING_INDUSTRIES.find((i) => i.id === selectedIndustry);
  const recommendedTemplate = industry
    ? TEMPLATES.find((t) => t.id === industry.templateId)
    : null;

  function handleUseTemplate() {
    if (recommendedTemplate) {
      markOnboardingComplete();
      onUseTemplate(recommendedTemplate);
    }
  }

  function handleSkip() {
    markOnboardingComplete();
    onSkip();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-lg bg-card border border-border rounded-2xl shadow-2xl overflow-hidden animate-in slide-in-from-bottom-4 duration-300">
        {/* Header */}
        <div className="flex items-start justify-between p-6 pb-4 border-b border-border">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Sparkles className="h-4 w-4 text-primary" />
              <span className="text-xs font-semibold uppercase tracking-widest text-primary">
                Getting started
              </span>
            </div>
            <h2 className="text-lg font-bold">
              {step === "industry" ? "What do you do?" : "Your recommended starting point"}
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              {step === "industry"
                ? "We'll recommend the perfect template for your use case."
                : "We've picked a template based on your industry. You can customise everything."}
            </p>
          </div>
          <button
            type="button"
            onClick={handleSkip}
            className="text-muted-foreground hover:text-foreground transition-colors shrink-0 mt-0.5"
            aria-label="Skip"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {step === "industry" && (
          <div className="p-6">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {ONBOARDING_INDUSTRIES.map((ind) => {
                const Icon = ICON_MAP[ind.icon] ?? Sparkles;
                return (
                  <button
                    key={ind.id}
                    type="button"
                    onClick={() => handleIndustrySelect(ind.id)}
                    className="flex flex-col items-center gap-2 p-3 rounded-xl border border-border bg-background hover:border-primary/50 hover:bg-primary/5 transition-all text-center group"
                  >
                    <div className="w-10 h-10 rounded-xl bg-muted border border-border flex items-center justify-center group-hover:bg-primary/10 group-hover:border-primary/30 group-hover:text-primary text-muted-foreground transition-all">
                      <Icon className="h-5 w-5" />
                    </div>
                    <span className="text-xs font-medium leading-snug">{ind.label}</span>
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={handleSkip}
              className="w-full mt-4 text-xs text-muted-foreground hover:text-foreground transition-colors py-2"
            >
              Skip — I'll start from scratch
            </button>
          </div>
        )}

        {step === "template" && recommendedTemplate && (
          <div className="p-6">
            {/* Template card */}
            <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 mb-4">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl bg-primary/15 border border-primary/25 flex items-center justify-center shrink-0">
                  <Sparkles className="h-5 w-5 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm">{recommendedTemplate.title}</p>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    {recommendedTemplate.description}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Button type="button" className="w-full gap-2" onClick={handleUseTemplate}>
                Use this template
                <ArrowRight className="h-4 w-4" />
              </Button>
              <button
                type="button"
                onClick={() => setStep("industry")}
                className="flex items-center justify-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors py-1.5"
              >
                <ChevronRight className="h-3 w-3 rotate-180" />
                Back — pick a different industry
              </button>
              <button
                type="button"
                onClick={handleSkip}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
              >
                Skip — start from scratch
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
