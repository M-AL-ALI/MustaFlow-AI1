import { useLocation } from "wouter";
import { Code2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function DevPage() {
  const [, setLocation] = useLocation();

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-6">
      <div className="flex flex-col items-center gap-6 max-w-md text-center">
        <div className="flex items-center justify-center h-16 w-16 rounded-2xl border border-border bg-muted/60">
          <Code2 className="h-8 w-8 text-foreground" />
        </div>
        <div>
          <h1 className="text-3xl font-bold tracking-tight mb-3">Developer Mode</h1>
          <p className="text-muted-foreground text-base">
            The full cloud IDE is coming soon. File tree, terminal, AI agent, and live preview —
            built for developers.
          </p>
        </div>
        <Button variant="outline" onClick={() => setLocation("/settings")}>
          Switch mode in Settings
        </Button>
      </div>
    </div>
  );
}
