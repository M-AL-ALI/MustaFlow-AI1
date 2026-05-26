import { useParams } from "wouter";
import { Code2, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";

export default function DevWorkspacePage() {
  const { id } = useParams<{ id: string }>();

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-6">
      <div className="flex flex-col items-center gap-6 max-w-md text-center">
        <div className="flex items-center justify-center h-16 w-16 rounded-2xl border border-border bg-muted/60">
          <Code2 className="h-8 w-8 text-foreground" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight mb-2">IDE Workspace</h1>
          <p className="text-sm text-muted-foreground font-mono text-left bg-muted/40 rounded-lg px-3 py-1.5 mb-3">
            Project #{id}
          </p>
          <p className="text-muted-foreground text-sm">
            The full cloud IDE is coming in Phase 3. File tree, Monaco editor, terminal, and live
            preview — all in one workspace.
          </p>
        </div>
        <Link href="/dev">
          <Button variant="outline" className="gap-2">
            <ArrowLeft className="h-4 w-4" />
            Back to home
          </Button>
        </Link>
      </div>
    </div>
  );
}
