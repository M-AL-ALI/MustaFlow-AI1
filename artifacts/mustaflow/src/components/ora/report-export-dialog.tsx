import { useState, useEffect } from "react";
import {
  Activity,
  Briefcase,
  CheckSquare,
  ClipboardList,
  Cog,
  FileText,
  Layers,
  Loader2,
  RefreshCw,
  Search,
  Target,
  TrendingUp,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import type { OraMessage } from "@/hooks/use-ora-chat";
import type { ReportTemplateId } from "@/lib/file-generation/report-templates";
import { REPORT_TEMPLATES } from "@/lib/file-generation/report-templates";
import type { ReportMetadata } from "@/lib/file-generation/report-metadata";
import { downloadDocx } from "@/lib/file-generation/generate-docx";
import { downloadXlsx } from "@/lib/file-generation/generate-xlsx";
import { downloadPptx } from "@/lib/file-generation/generate-pptx";
import { downloadPdf } from "@/lib/file-generation/generate-pdf";

export type ExportSource =
  | { kind: "message"; message: OraMessage }
  | { kind: "conversation"; messages: OraMessage[] };

export type ExportDialogType = "docx" | "xlsx" | "pptx" | "pdf";

interface ReportExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: ExportSource;
  hasDataset: boolean;
  exportType: ExportDialogType;
  basename: string;
}

const TEMPLATE_ICONS: Record<ReportTemplateId, React.ElementType> = {
  default: FileText,
  "executive-summary": Briefcase,
  "operations-review": Activity,
  "manufacturing-review": Cog,
  "kpi-review": TrendingUp,
  "root-cause-investigation": Search,
  "corrective-action": CheckSquare,
  "continuous-improvement": RefreshCw,
  "lean-six-sigma": Layers,
  "project-status": ClipboardList,
  "strategic-planning": Target,
};

const EXPORT_TYPE_LABEL: Record<ExportDialogType, string> = {
  docx: "Word Report",
  xlsx: "Excel Workbook",
  pptx: "Presentation",
  pdf: "PDF Report",
};

const LS_META_KEY = "mf_report_meta_v1";

function loadSavedMeta(): {
  company: string;
  department: string;
  preparedFor: string;
  preparedBy: string;
} {
  try {
    const raw = localStorage.getItem(LS_META_KEY);
    return raw
      ? (JSON.parse(raw) as ReturnType<typeof loadSavedMeta>)
      : { company: "", department: "", preparedFor: "", preparedBy: "" };
  } catch {
    return { company: "", department: "", preparedFor: "", preparedBy: "" };
  }
}

function saveMeta(values: ReturnType<typeof loadSavedMeta>) {
  try {
    localStorage.setItem(LS_META_KEY, JSON.stringify(values));
  } catch {
    // ignore
  }
}

function toTitleCase(s: string): string {
  return s.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function ReportExportDialog({
  open,
  onOpenChange,
  source,
  hasDataset,
  exportType,
  basename,
}: ReportExportDialogProps) {
  const { toast } = useToast();
  const [selectedTemplate, setSelectedTemplate] = useState<ReportTemplateId>("default");
  const [company, setCompany] = useState("");
  const [department, setDepartment] = useState("");
  const [preparedFor, setPreparedFor] = useState("");
  const [preparedBy, setPreparedBy] = useState("");
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    if (open) {
      const saved = loadSavedMeta();
      setCompany(saved.company);
      setDepartment(saved.department);
      setPreparedFor(saved.preparedFor);
      setPreparedBy(saved.preparedBy);
    }
  }, [open]);

  const message = source.kind === "message" ? source.message : null;
  const messages = source.kind === "conversation" ? source.messages : null;

  const templateObj =
    REPORT_TEMPLATES.find((t) => t.id === selectedTemplate) ?? REPORT_TEMPLATES[0];

  async function handleGenerate() {
    const reportTitle = toTitleCase(basename);
    const meta: ReportMetadata = {
      title: reportTitle,
      reportType: templateObj.label,
      templateId: selectedTemplate,
      company: company.trim() || "Company / Organization",
      department: department.trim() || "Department",
      preparedFor: preparedFor.trim(),
      preparedBy: preparedBy.trim(),
      generatedDate: new Date().toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      }),
    };

    saveMeta({
      company: company.trim(),
      department: department.trim(),
      preparedFor: preparedFor.trim(),
      preparedBy: preparedBy.trim(),
    });

    setGenerating(true);
    try {
      if (exportType === "docx") {
        if (hasDataset && message?.datasetResult) {
          await downloadDocx(
            { kind: "dataset", data: message.datasetResult, title: reportTitle },
            basename,
            meta,
            selectedTemplate,
          );
        } else if (message) {
          await downloadDocx(
            { kind: "message", message, title: reportTitle },
            basename,
            meta,
            selectedTemplate,
          );
        } else if (messages) {
          await downloadDocx(
            { kind: "conversation", messages, title: reportTitle },
            basename,
            meta,
            selectedTemplate,
          );
        }
      } else if (exportType === "xlsx") {
        if (hasDataset && message?.datasetResult) {
          await downloadXlsx(
            { kind: "dataset", data: message.datasetResult, title: reportTitle },
            basename,
            meta,
            selectedTemplate,
          );
        }
      } else if (exportType === "pptx") {
        if (hasDataset && message?.datasetResult) {
          await downloadPptx(
            { kind: "dataset", data: message.datasetResult, title: reportTitle },
            basename,
            meta,
            selectedTemplate,
          );
        } else if (message) {
          await downloadPptx(
            { kind: "message", message, title: reportTitle },
            basename,
            meta,
            selectedTemplate,
          );
        } else if (messages) {
          await downloadPptx(
            { kind: "conversation", messages, title: reportTitle },
            basename,
            meta,
            selectedTemplate,
          );
        }
      } else if (exportType === "pdf") {
        if (hasDataset && message?.datasetResult) {
          downloadPdf(
            { kind: "dataset", data: message.datasetResult, title: reportTitle },
            basename,
            meta,
            selectedTemplate,
          );
        } else if (message) {
          downloadPdf(
            { kind: "message", message, title: reportTitle },
            basename,
            meta,
            selectedTemplate,
          );
        } else if (messages) {
          downloadPdf(
            { kind: "conversation", messages, title: reportTitle },
            basename,
            meta,
            selectedTemplate,
          );
        }
      }
      onOpenChange(false);
    } catch {
      toast({
        title: "Export failed",
        description: "Could not generate the file. Please try again.",
        variant: "destructive",
      });
    } finally {
      setGenerating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Generate {EXPORT_TYPE_LABEL[exportType]}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Template selector */}
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">Select a report template</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {REPORT_TEMPLATES.map((template) => {
                const Icon = TEMPLATE_ICONS[template.id];
                const isSelected = selectedTemplate === template.id;
                return (
                  <button
                    key={template.id}
                    type="button"
                    onClick={() => setSelectedTemplate(template.id)}
                    className={cn(
                      "flex flex-col items-start gap-1.5 rounded-lg border p-3 text-left transition-colors",
                      "hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      isSelected ? "border-primary bg-primary/5" : "border-border",
                    )}
                  >
                    <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span
                      className={cn(
                        "text-xs font-medium leading-snug",
                        isSelected && "text-primary",
                      )}
                    >
                      {template.label}
                    </span>
                  </button>
                );
              })}
            </div>
            {templateObj && (
              <p className="text-xs text-muted-foreground">{templateObj.description}</p>
            )}
          </div>

          {/* Divider */}
          <div className="border-t border-border" />

          {/* Cover page metadata */}
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Cover page details{" "}
              <span className="text-xs">
                (optional — used as editable placeholders if left blank)
              </span>
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="rep-company" className="text-xs">
                  Company / Organization
                </Label>
                <Input
                  id="rep-company"
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  placeholder="Company / Organization"
                  className="h-8 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rep-dept" className="text-xs">
                  Department
                </Label>
                <Input
                  id="rep-dept"
                  value={department}
                  onChange={(e) => setDepartment(e.target.value)}
                  placeholder="Department"
                  className="h-8 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rep-for" className="text-xs">
                  Prepared For
                </Label>
                <Input
                  id="rep-for"
                  value={preparedFor}
                  onChange={(e) => setPreparedFor(e.target.value)}
                  placeholder="Recipient / Executive"
                  className="h-8 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rep-by" className="text-xs">
                  Prepared By
                </Label>
                <Input
                  id="rep-by"
                  value={preparedBy}
                  onChange={(e) => setPreparedBy(e.target.value)}
                  placeholder="Author / Team"
                  className="h-8 text-sm"
                />
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={generating}>
            Cancel
          </Button>
          <Button onClick={() => void handleGenerate()} disabled={generating}>
            {generating && <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />}
            Generate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
