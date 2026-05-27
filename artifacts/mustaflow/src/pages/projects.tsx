import { useState, useRef, useEffect, useCallback } from "react";
import { Link, useLocation } from "wouter";
import {
  useGetProjectsSummary,
  useGetRecentActivity,
  useCreateProject,
  useGetSecurityBadgeCountsByProject,
  getGetSecurityBadgeCountsByProjectQueryKey,
  getListProjectsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useClerkUser } from "@/lib/clerk-safe";
import {
  Globe,
  Smartphone,
  FileText,
  Presentation,
  Palette,
  Plus,
  ArrowUp,
  Mic,
  Clock,
  Activity,
  Heart,
  ShieldAlert,
  FolderKanban,
  RefreshCw,
} from "lucide-react";

const EXAMPLE_PROMPTS = [
  "Mobile app proposal",
  "Wellness journal",
  "Quarterly review presentation",
  "E-commerce landing page",
  "Restaurant booking app",
  "Portfolio website",
  "Task management dashboard",
  "Recipe sharing platform",
];

const CATEGORY_CHIPS = [
  { label: "Website", icon: Globe },
  { label: "Mobile", icon: Smartphone },
  { label: "Document", icon: FileText },
  { label: "Slides", icon: Presentation },
  { label: "Design", icon: Palette },
];

function SecurityFindingsBadge({ count }: { count: number }) {
  if (!count) return null;
  return (
    <span
      title={`${count} open critical or high security finding${count === 1 ? "" : "s"}`}
      className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border text-destructive bg-destructive/10 border-destructive/20"
    >
      <ShieldAlert className="h-2.5 w-2.5" />
      {count} critical/high
    </span>
  );
}

function HealthBadge({ score }: { score: number }) {
  const color =
    score >= 80
      ? "text-green-400 bg-green-500/10 border-green-500/20"
      : score >= 50
        ? "text-yellow-400 bg-yellow-500/10 border-yellow-500/20"
        : "text-destructive bg-destructive/10 border-destructive/20";
  return (
    <span
      title={`Health score: ${score}/100`}
      className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border ${color}`}
    >
      <Heart className="h-2.5 w-2.5" />
      {score}
    </span>
  );
}

function HomeHero() {
  const { user } = useClerkUser();
  const [prompt, setPrompt] = useState("");
  const [planMode, setPlanMode] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [exampleIndex, setExampleIndex] = useState(0);
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const createProject = useCreateProject();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const firstName = user?.firstName ?? user?.fullName?.split(" ")[0] ?? null;

  const cycleExample = useCallback(() => {
    setExampleIndex((i) => (i + 1) % EXAMPLE_PROMPTS.length);
  }, []);

  function handleBuild() {
    const text = prompt.trim();
    if (!text) return;
    const words = text.split(/\s+/).slice(0, 5).join(" ");
    const name = words.charAt(0).toUpperCase() + words.slice(1);
    createProject.mutate(
      {
        data: {
          name,
          description: text,
          kind: selectedCategory === "Mobile" ? "mobile-cross" : "web",
          initialPrompt: text,
        },
      },
      {
        onSuccess: (project) => {
          void queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
          setLocation(`/projects/${project.id}`);
        },
      },
    );
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleBuild();
    }
  }

  function useExamplePrompt() {
    setPrompt(EXAMPLE_PROMPTS[exampleIndex]);
    textareaRef.current?.focus();
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] pt-12 pb-6 px-4">
      {/* Greeting */}
      <h1 className="text-3xl md:text-4xl font-bold text-center mb-8 tracking-tight">
        {firstName ? (
          <>
            Hi {firstName}, what do you want to make?
          </>
        ) : (
          "What do you want to make?"
        )}
      </h1>

      {/* Prompt input */}
      <div className="w-full max-w-2xl">
        <div className="relative rounded-2xl border border-border bg-card shadow-sm overflow-hidden focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/10 transition-all">
          {/* Textarea */}
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Make a landing page for..."
            rows={3}
            className="w-full resize-none bg-transparent px-4 pt-4 pb-2 text-sm text-foreground placeholder:text-muted-foreground outline-none"
          />

          {/* Bottom bar */}
          <div className="flex items-center gap-2 px-3 pb-3">
            {/* Attachment button */}
            <button
              type="button"
              className="h-8 w-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
              title="Attach file"
            >
              <Plus className="h-4 w-4" />
            </button>

            <div className="flex-1" />

            {/* Plan toggle */}
            <button
              type="button"
              onClick={() => setPlanMode((v) => !v)}
              className={cn(
                "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors",
                planMode
                  ? "bg-primary/15 text-primary border border-primary/30"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted border border-transparent",
              )}
            >
              <span
                className={cn(
                  "h-3.5 w-3.5 rounded-sm border flex items-center justify-center shrink-0",
                  planMode ? "bg-primary border-primary" : "border-muted-foreground/40",
                )}
              >
                {planMode && (
                  <svg viewBox="0 0 10 8" className="h-2 w-2 fill-primary-foreground">
                    <path d="M1 4l3 3 5-6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </span>
              Plan
            </button>

            {/* Mic button */}
            <button
              type="button"
              className="h-8 w-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
              title="Voice input"
            >
              <Mic className="h-4 w-4" />
            </button>

            {/* Send button */}
            <button
              type="button"
              onClick={handleBuild}
              disabled={createProject.isPending || !prompt.trim()}
              className={cn(
                "h-8 w-8 flex items-center justify-center rounded-lg transition-colors shrink-0",
                prompt.trim()
                  ? "bg-foreground text-background hover:bg-foreground/80"
                  : "bg-muted text-muted-foreground cursor-not-allowed",
              )}
              title="Build"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Category chips */}
        <div className="flex items-center justify-center gap-3 mt-5 flex-wrap">
          {CATEGORY_CHIPS.map(({ label, icon: Icon }) => (
            <button
              key={label}
              type="button"
              onClick={() =>
                setSelectedCategory((prev) => (prev === label ? null : label))
              }
              className={cn(
                "flex flex-col items-center gap-1.5 rounded-xl border px-4 py-2.5 text-xs font-medium transition-all",
                selectedCategory === label
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-card text-muted-foreground hover:border-border/80 hover:text-foreground hover:bg-muted/60",
              )}
            >
              <Icon className="h-5 w-5" />
              {label}
            </button>
          ))}
        </div>

        {/* Example prompts */}
        <div className="flex items-center justify-center gap-2 mt-5 flex-wrap">
          <button
            type="button"
            onClick={cycleExample}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <RefreshCw className="h-3 w-3" />
            Try an example prompt
          </button>
          {[exampleIndex, (exampleIndex + 1) % EXAMPLE_PROMPTS.length, (exampleIndex + 2) % EXAMPLE_PROMPTS.length].map((idx) => (
            <button
              key={EXAMPLE_PROMPTS[idx]}
              type="button"
              onClick={() => {
                setPrompt(EXAMPLE_PROMPTS[idx]);
                textareaRef.current?.focus();
              }}
              className="rounded-full border border-border bg-muted/40 px-3 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted hover:border-border/80 transition-all"
            >
              {EXAMPLE_PROMPTS[idx]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function ProjectsPage() {
  const { data: summary } = useGetProjectsSummary();
  const { data: activity } = useGetRecentActivity();
  const { data: securityCounts } = useGetSecurityBadgeCountsByProject({
    query: { queryKey: getGetSecurityBadgeCountsByProjectQueryKey() },
  });

  const hasProjects = (summary?.recent?.length ?? 0) > 0;

  return (
    <div className="w-full min-h-full">
      {/* Hero / prompt section */}
      <HomeHero />

      {/* Divider */}
      {hasProjects && (
        <div className="px-6 md:px-8 max-w-7xl mx-auto">
          <div className="border-t border-border" />
        </div>
      )}

      {/* Projects + activity section */}
      {hasProjects && (
        <div className="p-6 md:p-8 max-w-7xl mx-auto space-y-8 w-full">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2 space-y-6">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-semibold">Your Projects</h2>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {summary?.recent?.map((project) => (
                  <Link key={project.id} href={`/projects/${project.id}`}>
                    <Card className="hover:border-primary/50 transition-colors cursor-pointer h-full">
                      <CardHeader className="pb-2">
                        <div className="flex justify-between items-start gap-2">
                          <div className="flex flex-col gap-1 min-w-0">
                            <CardTitle className="text-lg leading-tight">{project.name}</CardTitle>
                            {project.chipLabel && (
                              <span className="text-[10px] font-medium text-primary/80 border border-primary/20 bg-primary/5 rounded-full px-2 py-0.5 w-fit">
                                {project.chipLabel}
                              </span>
                            )}
                          </div>
                          <Badge
                            variant={project.status === "published" ? "default" : "secondary"}
                            className="shrink-0"
                          >
                            {project.status}
                          </Badge>
                        </div>
                      </CardHeader>
                      <CardContent>
                        <p className="text-sm text-muted-foreground line-clamp-2 mb-4">
                          {project.description || "No description provided."}
                        </p>
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center text-xs text-muted-foreground gap-2">
                            <Clock className="h-3 w-3" />
                            Updated {new Date(project.updatedAt).toLocaleDateString()}
                          </div>
                          <div className="flex items-center gap-1.5 flex-wrap justify-end">
                            <SecurityFindingsBadge
                              count={securityCounts?.counts?.[String(project.id)] ?? 0}
                            />
                            <HealthBadge score={project.healthScore ?? 0} />
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </Link>
                ))}
              </div>
            </div>

            <div>
              <h2 className="text-xl font-semibold mb-6">Recent Activity</h2>
              <div className="space-y-4">
                {activity?.map((item) => (
                  <div key={item.id} className="flex items-start gap-4 p-3 rounded-lg bg-muted/50">
                    <div className="bg-background rounded-full p-2 mt-0.5">
                      <Activity className="h-4 w-4 text-primary" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">{item.summary}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-xs text-muted-foreground">{item.projectName}</span>
                        <span className="text-xs text-muted-foreground">•</span>
                        <span className="text-xs text-muted-foreground">
                          {new Date(item.createdAt).toLocaleTimeString()}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
                {(!activity || activity.length === 0) && (
                  <div className="rounded-xl border border-dashed border-border bg-card/50 p-8 text-center">
                    <Activity className="h-7 w-7 text-muted-foreground/30 mx-auto mb-2" />
                    <p className="text-sm font-medium text-foreground/60 mb-1">No activity yet</p>
                    <p className="text-xs text-muted-foreground">
                      Build and publish projects to see activity here.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="text-center pt-2">
            <Link href="/projects/all">
              <Button variant="outline" size="sm" className="gap-2">
                <FolderKanban className="h-4 w-4" />
                View all projects
              </Button>
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
