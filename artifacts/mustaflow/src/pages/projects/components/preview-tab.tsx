import { Monitor, Smartphone, Tablet } from "lucide-react";
import { Button } from "@/components/ui/button";

export function PreviewTab({ project }: { project: any }) {
  return (
    <div className="flex flex-col h-full bg-background relative">
      <div className="flex items-center justify-between p-2 border-b border-border bg-card">
        <div className="flex bg-muted rounded-lg p-1">
          <Button variant="ghost" size="sm" className="h-7 px-3 text-xs bg-background shadow-sm">Web</Button>
          <Button variant="ghost" size="sm" className="h-7 px-3 text-xs text-muted-foreground">iOS</Button>
          <Button variant="ghost" size="sm" className="h-7 px-3 text-xs text-muted-foreground">Android</Button>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-8 w-8"><Monitor className="h-4 w-4" /></Button>
          <Button variant="ghost" size="icon" className="h-8 w-8"><Tablet className="h-4 w-4 text-muted-foreground" /></Button>
          <Button variant="ghost" size="icon" className="h-8 w-8"><Smartphone className="h-4 w-4 text-muted-foreground" /></Button>
        </div>
      </div>
      <div className="flex-1 p-6 flex items-center justify-center bg-muted/30">
        <div className="w-full max-w-4xl h-[600px] border border-border bg-card rounded-lg shadow-lg flex flex-col overflow-hidden">
          <div className="h-10 bg-muted border-b border-border flex items-center px-4 gap-2">
            <div className="flex gap-1.5">
              <div className="w-3 h-3 rounded-full bg-destructive/80" />
              <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
              <div className="w-3 h-3 rounded-full bg-green-500/80" />
            </div>
            <div className="mx-auto bg-background px-3 py-1 rounded text-xs text-muted-foreground border border-border flex-1 max-w-md text-center">
              localhost:3000
            </div>
          </div>
          <div className="flex-1 flex items-center justify-center text-muted-foreground flex-col">
            <div className="animate-pulse bg-primary/10 p-4 rounded-full mb-4">
              <Monitor className="h-8 w-8 text-primary" />
            </div>
            <p className="font-medium">Live preview will appear here</p>
            <p className="text-sm mt-1">Status: {project.status}</p>
            <p className="text-xs mt-2 opacity-50">Last updated: {new Date(project.updatedAt).toLocaleTimeString()}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
