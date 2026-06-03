import { authFetch } from "@/lib/api-fetch";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Loader2 } from "lucide-react";

export type VaultCategory =
  | "REPORT"
  | "INVESTIGATION"
  | "CORRECTIVE_ACTION"
  | "LESSON_LEARNED"
  | "BEST_PRACTICE"
  | "PROJECT"
  | "SOP"
  | "STANDARD"
  | "AUDIT"
  | "KPI"
  | "RISK"
  | "OTHER";

export type VaultSourceType =
  | "ORA_REPORT"
  | "DATASET_ANALYSIS"
  | "DOCUMENT_ANALYSIS"
  | "IMAGE_ANALYSIS"
  | "VOICE_TRANSCRIPT"
  | "USER_CREATED"
  | "MANUAL_ENTRY"
  | "IMPORT"
  | "OTHER";

const CATEGORY_LABELS: Record<VaultCategory, string> = {
  REPORT: "Report",
  INVESTIGATION: "Investigation",
  CORRECTIVE_ACTION: "Corrective Action",
  LESSON_LEARNED: "Lesson Learned",
  BEST_PRACTICE: "Best Practice",
  PROJECT: "Project",
  SOP: "SOP / Work Instruction",
  STANDARD: "Standard",
  AUDIT: "Audit",
  KPI: "KPI",
  RISK: "Risk",
  OTHER: "Other",
};

const DEPARTMENTS = [
  "Operations",
  "Manufacturing",
  "Packaging",
  "Debone",
  "WBI",
  "Maintenance",
  "Quality",
  "Safety",
  "Engineering",
  "Management",
  "Corporate",
  "Other",
];

export interface VaultSavePayload {
  title: string;
  category: VaultCategory;
  subcategory?: string;
  summary: string;
  content: string;
  tags: string[];
  department?: string;
  sourceType: VaultSourceType;
  sourceReference?: string;
}

interface VaultSaveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaults: Partial<VaultSavePayload>;
  onSaved?: (entryId: number) => void;
}

export function VaultSaveDialog({ open, onOpenChange, defaults, onSaved }: VaultSaveDialogProps) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);

  const [title, setTitle] = useState(defaults.title ?? "");
  const [category, setCategory] = useState<VaultCategory>(defaults.category ?? "REPORT");
  const [subcategory, setSubcategory] = useState(defaults.subcategory ?? "");
  const [summary, setSummary] = useState(defaults.summary ?? "");
  const [content, setContent] = useState(defaults.content ?? "");
  const [tagsRaw, setTagsRaw] = useState((defaults.tags ?? []).join(", "));
  const [department, setDepartment] = useState(defaults.department ?? "");
  const [sourceType] = useState<VaultSourceType>(defaults.sourceType ?? "USER_CREATED");

  const handleSave = async () => {
    if (!title.trim() || !summary.trim() || !content.trim()) {
      toast({
        title: "Missing required fields",
        description: "Title, summary, and content are required.",
        variant: "destructive",
      });
      return;
    }

    setSaving(true);
    try {
      const tags = tagsRaw
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);

      const res = await authFetch("/api/vault", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          category,
          subcategory: subcategory.trim() || undefined,
          summary: summary.trim(),
          content: content.trim(),
          tags,
          department: department || undefined,
          sourceType,
          sourceReference: defaults.sourceReference,
          changeSummary: "Initial save",
        }),
      });

      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
        throw new Error(err.detail ?? err.error ?? `Save failed (${res.status})`);
      }

      const saved = (await res.json()) as { id: number };
      toast({
        title: "Saved to Knowledge Vault",
        description: `"${title}" is now in your vault.`,
      });
      onOpenChange(false);
      onSaved?.(saved.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Save failed";
      toast({ title: "Save failed", description: msg, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Save to Knowledge Vault</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label>Title</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. WBI Throughput Improvement — May 2026"
              maxLength={500}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Select value={category} onValueChange={(v) => setCategory(v as VaultCategory)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.entries(CATEGORY_LABELS) as [VaultCategory, string][]).map(
                    ([val, label]) => (
                      <SelectItem key={val} value={val}>
                        {label}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Department</Label>
              <Select value={department} onValueChange={setDepartment}>
                <SelectTrigger>
                  <SelectValue placeholder="Select…" />
                </SelectTrigger>
                <SelectContent>
                  {DEPARTMENTS.map((d) => (
                    <SelectItem key={d} value={d}>
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Subcategory</Label>
            <Input
              value={subcategory}
              onChange={(e) => setSubcategory(e.target.value)}
              placeholder="e.g. Root Cause Analysis, Five Whys…"
              maxLength={200}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Summary</Label>
            <Textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="One or two sentences describing this entry…"
              rows={2}
              maxLength={2000}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Content</Label>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Full content of the report, lesson, or SOP…"
              rows={6}
              maxLength={50000}
              className="font-mono text-xs"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Tags</Label>
            <Input
              value={tagsRaw}
              onChange={(e) => setTagsRaw(e.target.value)}
              placeholder="seal failure, downtime, WBI (comma-separated)"
              maxLength={500}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save to Vault
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
