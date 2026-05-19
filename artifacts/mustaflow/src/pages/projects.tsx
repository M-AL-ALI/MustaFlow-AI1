import { useState } from "react";
import { useGetProjectsSummary, useGetRecentActivity } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  FolderKanban,
  Activity,
  Clock,
  CheckCircle2,
  AlertCircle,
  Plus,
  ArrowRight,
  Sparkles,
} from "lucide-react";
import { Link, useLocation } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { CreateProjectModal } from "@/components/create-project-modal";
import { useCreateProject, getListProjectsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

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
        <Sparkles className="h-4 w-4 text-primary" />
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

export default function ProjectsPage() {
  const { data: summary } = useGetProjectsSummary();
  const { data: activity } = useGetRecentActivity();
  const [modalOpen, setModalOpen] = useState(false);

  const hasProjects = (summary?.recent?.length ?? 0) > 0;

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8 w-full">
      <CreateProjectModal open={modalOpen} onOpenChange={setModalOpen} />

      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Projects</h1>
          <p className="text-muted-foreground mt-1">Manage and monitor your MustaFlow AI builds.</p>
        </div>
        <Button onClick={() => setModalOpen(true)} size="lg" className="shrink-0 gap-2">
          <Plus className="h-4 w-4" />
          New Project
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
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
                      <div className="flex justify-between items-start">
                        <CardTitle className="text-lg">{project.name}</CardTitle>
                        <Badge
                          variant={project.status === "published" ? "default" : "secondary"}
                        >
                          {project.status}
                        </Badge>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-muted-foreground line-clamp-2 mb-4">
                        {project.description || "No description provided."}
                      </p>
                      <div className="flex items-center text-xs text-muted-foreground gap-2">
                        <Clock className="h-3 w-3" />
                        Updated {new Date(project.updatedAt).toLocaleDateString()}
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
              <div className="text-center p-8 text-muted-foreground border border-dashed rounded-lg">
                No recent activity.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
