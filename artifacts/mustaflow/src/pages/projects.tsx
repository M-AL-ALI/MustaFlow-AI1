import { useState } from "react";
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
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { CreateProjectModal } from "@/components/create-project-modal";
import { AgentIcon } from "@/components/agent-icon";
import {
  FolderKanban,
  Activity,
  Clock,
  CheckCircle2,
  AlertCircle,
  Plus,
  ArrowRight,
  CheckSquare,
  Square,
  ChevronDown,
  ChevronUp,
  Rocket,
  Eye,
  Heart,
  ShieldAlert,
} from "lucide-react";

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
function QuickStartBox() {
  const [prompt, setPrompt] = useState("");
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const createProject = useCreateProject();

  function handleBuild() {
    if (!prompt.trim()) return;
    const words = prompt.trim().split(/\s+/).slice(0, 5).join(" ");
    const name = words.charAt(0).toUpperCase() + words.slice(1);
    createProject.mutate(
      {
        data: { name, description: prompt, kind: "web", initialPrompt: prompt },
      },
      {
        onSuccess: (project) => {
          void queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
          setLocation(`/projects/${project.id}`);
        },
      },
    );
  }

  return (
    <div className="relative rounded-2xl border border-border bg-card p-5 shadow-sm">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-primary">
          <AgentIcon size={16} />
        </span>
        <span className="text-sm font-semibold text-foreground">Quick start</span>
      </div>
      <div className="flex gap-2">
        <Input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What do you want to build?"
          onKeyDown={(e) => {
            if (e.key === "Enter") handleBuild();
          }}
          className="h-10"
        />
        <Button
          onClick={handleBuild}
          disabled={createProject.isPending || !prompt.trim()}
          className="shrink-0"
        >
          {createProject.isPending ? "…" : <ArrowRight className="h-4 w-4" />}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground mt-2">
        Press Enter or click the arrow — we'll create and open your project instantly.
      </p>
    </div>
  );
}

function WelcomeCard({ onCreateProject }: { onCreateProject: () => void }) {
  return (
    <div className="rounded-2xl border border-primary/20 bg-primary/5 p-8 text-center space-y-4">
      <div className="w-14 h-14 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto text-primary">
        <AgentIcon size={28} />
      </div>
      <div>
        <h2 className="text-xl font-bold mb-2">Welcome to MustaFlow AI</h2>
        <p className="text-sm text-muted-foreground max-w-md mx-auto">
          Describe any app in plain language and the AI will build it for you in seconds. No coding
          needed.
        </p>
      </div>
      <Button onClick={onCreateProject} size="lg" className="gap-2">
        <Plus className="h-4 w-4" />
        Create your first project
      </Button>
      <p className="text-xs text-muted-foreground">
        Or type your idea in the quick start box below
      </p>
    </div>
  );
}

interface ChecklistItem {
  id: string;
  icon: React.ElementType;
  label: string;
  description: string;
  done: boolean;
  action?: () => void;
  actionLabel?: string;
}

function GettingStartedChecklist({
  hasProject,
  hasBuilt,
  hasPreviewed,
  hasPublished,
  onCreateProject,
}: {
  hasProject: boolean;
  hasBuilt: boolean;
  hasPreviewed: boolean;
  hasPublished: boolean;
  onCreateProject: () => void;
}) {
  const [open, setOpen] = useState(true);
  const allDone = hasProject && hasBuilt && hasPreviewed && hasPublished;

  if (allDone) return null;

  const items: ChecklistItem[] = [
    {
      id: "create",
      icon: FolderKanban,
      label: "Create your first project",
      description: "Give your idea a name and describe what you want to build.",
      done: hasProject,
      action: hasProject ? undefined : onCreateProject,
      actionLabel: "Create project",
    },
    {
      id: "build",
      icon: AgentIcon,
      label: "Run your first AI build",
      description: "Send a message in the AI Builder chat and watch your app come to life.",
      done: hasBuilt,
    },
    {
      id: "preview",
      icon: Eye,
      label: "Preview your app",
      description: "Open the Preview tab to see your generated app running live.",
      done: hasPreviewed,
    },
    {
      id: "publish",
      icon: Rocket,
      label: "Publish it",
      description: "Share your app with a public URL from the Publishing tab.",
      done: hasPublished,
    },
  ];

  const doneCount = items.filter((i) => i.done).length;

  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden">
      <button
        className="w-full flex items-center gap-3 px-5 py-4 hover:bg-muted/40 transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex-1 flex items-center gap-3 text-left">
          <CheckSquare className="h-4 w-4 text-primary shrink-0" />
          <div>
            <div className="text-sm font-semibold">Getting started</div>
            <div className="text-xs text-muted-foreground">
              {doneCount} of {items.length} steps complete
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="w-24 h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-500"
              style={{ width: `${(doneCount / items.length) * 100}%` }}
            />
          </div>
          {open ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </button>

      {open && (
        <div className="border-t border-border divide-y divide-border">
          {items.map((item) => (
            <div
              key={item.id}
              className={cn(
                "flex items-start gap-4 px-5 py-4 transition-colors",
                item.done && "opacity-60",
              )}
            >
              <div className="mt-0.5 shrink-0">
                {item.done ? (
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                ) : (
                  <Square className="h-4 w-4 text-muted-foreground/50" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div
                  className={cn(
                    "text-sm font-medium",
                    item.done && "line-through text-muted-foreground",
                  )}
                >
                  {item.label}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">{item.description}</div>
              </div>
              {item.action && !item.done && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={item.action}
                  className="shrink-0 text-xs h-7"
                >
                  {item.actionLabel}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ProjectsPage() {
  const { data: summary } = useGetProjectsSummary();
  const { data: activity } = useGetRecentActivity();
  const { data: securityCounts } = useGetSecurityBadgeCountsByProject({
    query: { queryKey: getGetSecurityBadgeCountsByProjectQueryKey() },
  });
  const [modalOpen, setModalOpen] = useState(false);

  const hasProjects = (summary?.recent?.length ?? 0) > 0;
  const totalProjects = summary?.total ?? 0;
  const publishedCount = summary?.byStatus?.published ?? 0;
  const isNewUser = totalProjects === 0;

  // Infer checklist state from available data
  const hasProject = totalProjects > 0;
  const hasBuilt =
    (summary?.byStatus?.building ?? 0) > 0 ||
    (summary?.byStatus?.published ?? 0) > 0 ||
    (summary?.byStatus?.testing ?? 0) > 0 ||
    totalProjects > 0;
  const hasPreviewed = hasBuilt;
  const hasPublished = publishedCount > 0;

  return (
    <div className="p-6 md:p-8 max-w-7xl mx-auto space-y-8 w-full">
      <CreateProjectModal open={modalOpen} onOpenChange={setModalOpen} />

      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Projects</h1>
          <p className="text-muted-foreground mt-1 text-sm md:text-base">
            Manage and monitor your MustaFlow AI builds.
          </p>
        </div>
        <Button onClick={() => setModalOpen(true)} size="default" className="shrink-0 gap-2">
          <Plus className="h-4 w-4" />
          <span className="hidden sm:inline">New Project</span>
          <span className="sm:hidden">New</span>
        </Button>
      </div>

      {/* Welcome card for brand new users */}
      {isNewUser && <WelcomeCard onCreateProject={() => setModalOpen(true)} />}

      {/* Stats row — only show once user has projects */}
      {hasProjects && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Projects</CardTitle>
              <FolderKanban className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{summary?.total || 0}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Building</CardTitle>
              <Activity className="h-4 w-4 text-primary" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{summary?.byStatus?.building || 0}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Published</CardTitle>
              <CheckCircle2 className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{summary?.byStatus?.published || 0}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Failed</CardTitle>
              <AlertCircle className="h-4 w-4 text-destructive" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{summary?.byStatus?.failed || 0}</div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Getting started checklist — show for users who haven't published yet */}
      {!hasPublished && hasProject && (
        <GettingStartedChecklist
          hasProject={hasProject}
          hasBuilt={hasBuilt}
          hasPreviewed={hasPreviewed}
          hasPublished={hasPublished}
          onCreateProject={() => setModalOpen(true)}
        />
      )}

      <QuickStartBox />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-6">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold">Recent Projects</h2>
          </div>

          {hasProjects ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {summary?.recent?.map((project) => (
                <Link key={project.id} href={`/projects/${project.id}`}>
                  <Card className="hover:border-primary/50 transition-colors cursor-pointer h-full">
                    <CardHeader className="pb-2">
                      <div className="flex justify-between items-start gap-2">
                        <CardTitle className="text-lg leading-tight">{project.name}</CardTitle>
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
          ) : (
            <div className="rounded-2xl border border-dashed border-border bg-card/50 px-6 py-16 text-center">
              <FolderKanban className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
              <h3 className="text-base font-semibold text-foreground mb-1">No projects yet</h3>
              <p className="text-sm text-muted-foreground mb-5">
                Create your first project to get started. Describe your idea and the AI builder will
                do the rest.
              </p>
              <Button onClick={() => setModalOpen(true)} className="gap-2">
                <Plus className="h-4 w-4" />
                Create your first project
              </Button>
            </div>
          )}
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
                  Build and publish projects to see your activity here.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
