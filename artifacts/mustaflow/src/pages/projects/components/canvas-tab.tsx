import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Paintbrush, Check, Save } from "lucide-react";

export function CanvasTab() {
  return (
    <div className="flex h-full">
      <div className="w-48 border-r border-border bg-card p-4 space-y-4">
        <h3 className="font-semibold text-sm">Screens</h3>
        <div className="space-y-1">
          <div className="px-2 py-1.5 text-sm bg-primary/10 text-primary rounded-md font-medium">Home Page</div>
          <div className="px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted rounded-md cursor-pointer">Dashboard</div>
          <div className="px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted rounded-md cursor-pointer">Settings</div>
        </div>
      </div>
      <div className="flex-1 flex flex-col">
        <div className="p-4 border-b border-border bg-card flex gap-2">
          <Input placeholder="Describe a design change (e.g. Make the hero section darker...)" className="flex-1" />
          <Button variant="secondary"><Paintbrush className="h-4 w-4 mr-2" /> Generate</Button>
        </div>
        <div className="flex-1 p-6 bg-muted/30 overflow-y-auto">
          <div className="grid grid-cols-2 gap-6">
            <div className="border border-primary ring-2 ring-primary/20 rounded-lg overflow-hidden bg-card">
              <div className="h-48 bg-muted border-b border-border flex items-center justify-center text-muted-foreground">Variant A</div>
              <div className="p-3 flex justify-between items-center bg-card">
                <span className="text-sm font-medium">Current</span>
                <Button size="sm"><Check className="h-4 w-4 mr-2" /> Applied</Button>
              </div>
            </div>
            <div className="border border-border rounded-lg overflow-hidden bg-card opacity-50 grayscale">
              <div className="h-48 bg-muted border-b border-border flex items-center justify-center text-muted-foreground">Variant B</div>
              <div className="p-3 flex justify-between items-center bg-card">
                <span className="text-sm font-medium">Darker Hero</span>
                <Button size="sm" variant="outline">Apply</Button>
              </div>
            </div>
          </div>
        </div>
        <div className="p-4 border-t border-border bg-card flex justify-end">
          <Button><Save className="h-4 w-4 mr-2" /> Save as Version</Button>
        </div>
      </div>
    </div>
  );
}
