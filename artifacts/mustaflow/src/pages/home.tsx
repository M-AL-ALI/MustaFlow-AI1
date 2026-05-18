import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { 
  Monitor, 
  Smartphone, 
  LayoutDashboard, 
  Paintbrush, 
  BarChart, 
  Table, 
  Zap, 
  Database, 
  MessageSquare, 
  Store,
  Sparkles,
  ArrowRight
} from "lucide-react";
import { useState } from "react";
import { useCreateProject, useListProjects, getListProjectsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

const CHIPS = [
  { name: "Website", icon: Monitor, kind: "web" },
  { name: "Mobile App", icon: Smartphone, kind: "mobile-ios" },
  { name: "Dashboard", icon: LayoutDashboard, kind: "dashboard" },
  { name: "Design", icon: Paintbrush, kind: "design" },
  { name: "Data Viz", icon: BarChart, kind: "dashboard" },
  { name: "Spreadsheet", icon: Table, kind: "spreadsheet" },
  { name: "Automation", icon: Zap, kind: "automation" },
  { name: "API/Backend", icon: Database, kind: "api" },
  { name: "AI Chatbot", icon: MessageSquare, kind: "chatbot" },
  { name: "Marketplace", icon: Store, kind: "marketplace" },
];

export default function HomePage() {
  const [, setLocation] = useLocation();
  const [prompt, setPrompt] = useState("");
  const queryClient = useQueryClient();
  const createProject = useCreateProject();

  const handleBuild = (kind: string = "web") => {
    if (!prompt.trim()) return;
    createProject.mutate({
      data: {
        name: "New Project",
        description: prompt,
        kind: kind as any,
        initialPrompt: prompt
      }
    }, {
      onSuccess: (project) => {
        queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
        setLocation(`/projects/${project.id}`);
      }
    });
  };

  return (
    <div className="flex-1 overflow-y-auto pb-24">
      {/* Hero Section */}
      <div className="max-w-4xl mx-auto pt-24 px-6">
        <h1 className="text-5xl font-bold text-center mb-4 tracking-tight">
          What do you want to build?
        </h1>
        <p className="text-muted-foreground text-center mb-12 text-lg">
          Describe your idea in natural language. MustaFlow AI will plan, build, and deploy it.
        </p>

        <div className="relative max-w-2xl mx-auto mb-8">
          <div className="absolute inset-0 bg-primary/20 blur-xl rounded-full mix-blend-multiply" />
          <div className="relative bg-card border border-border shadow-xl rounded-2xl p-2 flex items-center gap-2">
            <div className="pl-4 text-primary">
              <Sparkles className="h-6 w-6" />
            </div>
            <Input 
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. A marketplace app for local artists to sell prints..."
              className="border-0 focus-visible:ring-0 focus-visible:ring-offset-0 text-lg h-14 bg-transparent shadow-none"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleBuild();
              }}
            />
            <Button 
              size="lg" 
              className="rounded-xl px-6 h-12"
              onClick={() => handleBuild()}
              disabled={createProject.isPending || !prompt.trim()}
            >
              {createProject.isPending ? "Starting..." : "Start Building"}
              {!createProject.isPending && <ArrowRight className="ml-2 h-5 w-5" />}
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap justify-center gap-2 max-w-3xl mx-auto">
          {CHIPS.map((chip) => (
            <button
              key={chip.name}
              aria-label={`Build a ${chip.name}`}
              onClick={() => {
                const template = `Build me a ${chip.name.toLowerCase()}`;
                if (!prompt.trim()) {
                  setPrompt(template);
                } else {
                  handleBuild(chip.kind);
                }
              }}
              className="flex items-center gap-2 px-4 py-2 rounded-full border border-border bg-card hover:bg-muted hover:border-primary/50 transition-colors text-sm font-medium text-foreground"
            >
              <chip.icon className="h-4 w-4 text-muted-foreground" />
              {chip.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
