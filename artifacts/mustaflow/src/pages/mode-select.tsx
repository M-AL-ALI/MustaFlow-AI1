import { useState } from "react";
import { useLocation } from "wouter";
import { useUpdateMyPreferences, getGetMyPreferencesQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { ThemeToggle } from "@/components/theme-toggle";
import { Sparkles, Code2, ArrowRight, Loader2 } from "lucide-react";

export default function ModeSelectPage() {
  const [, setLocation] = useLocation();
  const [selecting, setSelecting] = useState<"builder" | "developer" | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updatePreferences = useUpdateMyPreferences();

  async function handleSelect(mode: "builder" | "developer") {
    if (selecting) return;
    setSelecting(mode);
    try {
      await updatePreferences.mutateAsync({ data: { preferredMode: mode } });
      await queryClient.invalidateQueries({ queryKey: getGetMyPreferencesQueryKey() });
      setLocation(mode === "builder" ? "/projects" : "/dev");
    } catch {
      toast({
        title: "Something went wrong",
        description: "Could not save your preference. Please try again.",
        variant: "destructive",
      });
      setSelecting(null);
    }
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-8 py-5">
        <a href="/" className="flex items-center gap-2.5 group" aria-label="MustaFlow AI home">
          <img
            src={`${import.meta.env.BASE_URL}logo.png`}
            alt="MustaFlow AI"
            className="h-9 w-9 rounded-lg shadow-sm group-hover:scale-105 transition-transform"
          />
          <span className="text-lg font-bold tracking-tight hidden sm:inline">
            MustaFlow <span className="text-primary">AI</span>
          </span>
        </a>
        <ThemeToggle />
      </header>

      {/* Main content */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 pb-16">
        <div className="text-center mb-12">
          <p className="text-sm font-semibold uppercase tracking-widest text-muted-foreground mb-4">
            Welcome — let's get started
          </p>
          <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight mb-4">
            How do you want to build?
          </h1>
          <p className="text-muted-foreground text-lg max-w-md mx-auto">
            Choose your experience. You can switch at any time from Settings.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 w-full max-w-3xl">
          {/* AI Build Mode */}
          <ModeCard
            mode="builder"
            icon={Sparkles}
            title="AI Build Mode"
            description="Describe an idea in plain language. Zero plans and builds it for you — no code needed."
            accent="from-primary/20 via-primary/5 to-transparent"
            borderHover="hover:border-primary/60"
            glowColor="shadow-primary/10"
            selecting={selecting}
            onSelect={handleSelect}
          />

          {/* Developer Mode */}
          <ModeCard
            mode="developer"
            icon={Code2}
            title="Developer Mode"
            description="A full cloud IDE powered by Zero. File tree, terminal, AI agent, and live preview — built for developers."
            accent="from-violet-500/20 via-violet-500/5 to-transparent"
            borderHover="hover:border-violet-500/60"
            glowColor="shadow-violet-500/10"
            selecting={selecting}
            onSelect={handleSelect}
          />
        </div>
      </div>
    </div>
  );
}

interface ModeCardProps {
  mode: "builder" | "developer";
  icon: React.ElementType;
  title: string;
  description: string;
  accent: string;
  borderHover: string;
  glowColor: string;
  selecting: "builder" | "developer" | null;
  onSelect: (mode: "builder" | "developer") => void;
}

function ModeCard({
  mode,
  icon: Icon,
  title,
  description,
  accent,
  borderHover,
  glowColor,
  selecting,
  onSelect,
}: ModeCardProps) {
  const isSelecting = selecting === mode;

  return (
    <button
      onClick={() => onSelect(mode)}
      disabled={selecting !== null}
      className={`
        group relative flex flex-col items-start gap-5 p-8 rounded-2xl border border-border
        bg-card text-left cursor-pointer transition-all duration-200
        ${borderHover}
        hover:-translate-y-1 hover:shadow-xl ${glowColor}
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
        disabled:cursor-not-allowed disabled:opacity-60
        ${isSelecting ? "border-primary/60 -translate-y-1 shadow-xl" : ""}
      `}
    >
      {/* Gradient background */}
      <div
        className={`absolute inset-0 rounded-2xl bg-gradient-to-br ${accent} opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none ${isSelecting ? "opacity-100" : ""}`}
      />

      <div className="relative z-10 flex flex-col gap-4 w-full">
        {/* Icon */}
        <div className="flex items-center justify-between w-full">
          <div className="flex items-center justify-center h-12 w-12 rounded-xl border border-border bg-muted/60 group-hover:border-border/80 transition-colors">
            <Icon className="h-6 w-6 text-foreground" />
          </div>
          {isSelecting ? (
            <Loader2 className="h-5 w-5 text-muted-foreground animate-spin" />
          ) : (
            <ArrowRight className="h-5 w-5 text-muted-foreground opacity-0 group-hover:opacity-100 group-hover:translate-x-1 transition-all duration-200" />
          )}
        </div>

        {/* Text */}
        <div>
          <h2 className="text-xl font-bold tracking-tight mb-2">{title}</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">{description}</p>
        </div>
      </div>
    </button>
  );
}
