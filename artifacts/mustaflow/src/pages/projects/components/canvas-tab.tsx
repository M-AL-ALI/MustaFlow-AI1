import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Paintbrush,
  Check,
  Save,
  Sparkles,
  Palette,
  Type,
  ImageIcon,
  RefreshCw,
  Layers,
  Monitor,
  Wand2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useSendMessage,
  useListProjectFiles,
  getListProjectFilesQueryKey,
  getListMessagesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

type TabMode = "design" | "brand-studio";
type StyleOption = "minimal" | "bold" | "playful" | "corporate" | "modern" | "classic";

const STYLE_OPTIONS: { value: StyleOption; label: string; desc: string }[] = [
  { value: "minimal", label: "Minimal", desc: "Clean, whitespace, restrained" },
  { value: "bold", label: "Bold", desc: "Strong colors, heavy type" },
  { value: "playful", label: "Playful", desc: "Rounded, colorful, friendly" },
  { value: "corporate", label: "Corporate", desc: "Professional, trustworthy" },
  { value: "modern", label: "Modern", desc: "Geometric, sleek, tech-forward" },
  { value: "classic", label: "Classic", desc: "Timeless, elegant, refined" },
];

function BrandPreview({ projectId, iframeKey }: { projectId: number; iframeKey: number }) {
  const previewUrl = `/api/projects/${projectId}/preview/brand/preview.html?t=${iframeKey}`;
  const logoUrl = `/api/projects/${projectId}/preview/brand/logo.svg?t=${iframeKey}`;
  const iconUrl = `/api/projects/${projectId}/preview/brand/icon.svg?t=${iframeKey}`;

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Brand board iframe */}
      <div className="flex-1 min-h-0 overflow-hidden rounded-lg border border-border bg-background">
        <iframe
          key={iframeKey}
          src={previewUrl}
          title="Brand preview"
          className="w-full h-full border-0"
          sandbox="allow-scripts allow-same-origin"
        />
      </div>
      {/* Individual asset previews */}
      <div className="shrink-0 grid grid-cols-2 gap-2 pt-2">
        <div className="border border-border rounded-lg p-2 bg-background flex flex-col items-center gap-1">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Logo</div>
          <img
            src={logoUrl}
            alt="Logo"
            className="h-8 object-contain"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        </div>
        <div className="border border-border rounded-lg p-2 bg-zinc-900 flex flex-col items-center gap-1">
          <div className="text-[10px] text-zinc-500 uppercase tracking-wide">Dark bg</div>
          <img
            src={iconUrl}
            alt="Icon"
            className="h-8 object-contain"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        </div>
      </div>
    </div>
  );
}

function BrandEmptyState() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center p-6 gap-4">
      <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
        <Palette className="h-8 w-8 text-primary/50" />
      </div>
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-1">No brand kit yet</h3>
        <p className="text-xs text-muted-foreground max-w-xs leading-relaxed">
          Fill in your brand details and click Generate to create a professional logo, icon, color
          palette, and typography system.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground w-full max-w-xs">
        {[
          { icon: ImageIcon, label: "SVG Logo" },
          { icon: Layers, label: "App Icon" },
          { icon: Palette, label: "Color Palette" },
          { icon: Type, label: "Typography" },
        ].map((item) => (
          <div key={item.label} className="flex items-center gap-1.5 bg-muted/40 rounded-md p-2">
            <item.icon className="h-3.5 w-3.5 text-primary/60" />
            {item.label}
          </div>
        ))}
      </div>
    </div>
  );
}

export function CanvasTab({ projectId }: { projectId: number }) {
  const queryClient = useQueryClient();
  const sendMessage = useSendMessage();
  const { data: files } = useListProjectFiles(projectId, {
    query: { enabled: !!projectId, queryKey: getListProjectFilesQueryKey(projectId) },
  });

  const [mode, setMode] = useState<TabMode>("design");
  const [designPrompt, setDesignPrompt] = useState("");

  // Brand studio state
  const [brandName, setBrandName] = useState("");
  const [tagline, setTagline] = useState("");
  const [industry, setIndustry] = useState("");
  const [style, setStyle] = useState<StyleOption>("modern");
  const [colorHint, setColorHint] = useState("");
  const [generating, setGenerating] = useState(false);
  const [applying, setApplying] = useState(false);
  const [brandIframeKey, setBrandIframeKey] = useState(0);

  const hasBrandFiles = files?.some((f) => f.path.startsWith("brand/"));

  const generateBrandKit = () => {
    if (!brandName.trim()) return;
    setGenerating(true);

    const prompt = [
      `Generate a complete professional brand kit for this project.`,
      `Brand name: ${brandName}`,
      tagline ? `Tagline: ${tagline}` : null,
      industry ? `Industry: ${industry}` : null,
      `Style direction: ${style} — ${STYLE_OPTIONS.find((s) => s.value === style)?.desc}`,
      colorHint ? `Primary color inspiration: ${colorHint}` : null,
      ``,
      `Create these files in the brand/ directory:`,
      `- brand/logo.svg (horizontal wordmark with icon, viewBox="0 0 240 60")`,
      `- brand/icon.svg (square icon mark, viewBox="0 0 60 60")`,
      `- brand/logo-reversed.svg (white/light version for dark backgrounds)`,
      `- brand/favicon.svg (minimal 32x32 favicon version)`,
      `- brand/brand.css (CSS custom properties for colors and typography)`,
      `- brand/preview.html (brand board showing all assets, colors, and typography using Tailwind CDN)`,
      `Use only SVG primitives (rect, circle, path, text) — no external images or fonts.`,
      `Make it professional, scalable, and distinctive for the ${industry || "tech"} industry.`,
    ]
      .filter(Boolean)
      .join("\n");

    sendMessage.mutate(
      {
        id: projectId,
        data: { content: prompt, agentMode: "power", planMode: false, background: false },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListProjectFilesQueryKey(projectId) });
          queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey(projectId) });
          setBrandIframeKey((k) => k + 1);
          setGenerating(false);
        },
        onError: () => setGenerating(false),
      },
    );
  };

  const applyBrandToApp = () => {
    if (!hasBrandFiles) return;
    setApplying(true);
    const prompt = `Apply the brand kit from brand/brand.css to the main app.
Update index.html to import brand/brand.css and use the CSS custom properties (--brand-primary, --brand-secondary, etc.) throughout the design.
Ensure headings use --brand-font-heading, body text uses --brand-font-body, and primary actions use --brand-primary color.
The app should feel visually consistent with the brand identity shown in brand/preview.html.`;

    sendMessage.mutate(
      {
        id: projectId,
        data: { content: prompt, agentMode: "power", planMode: false, background: false },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListProjectFilesQueryKey(projectId) });
          queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey(projectId) });
          setApplying(false);
        },
        onError: () => setApplying(false),
      },
    );
  };

  const generateDesignVariant = () => {
    if (!designPrompt.trim()) return;
    sendMessage.mutate(
      {
        id: projectId,
        data: {
          content: `Design change request: ${designPrompt}`,
          agentMode: "power",
          planMode: false,
          background: false,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListProjectFilesQueryKey(projectId) });
          queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey(projectId) });
          setDesignPrompt("");
        },
      },
    );
  };

  return (
    <div className="flex flex-col h-full">
      {/* Mode switcher */}
      <div className="shrink-0 border-b border-border bg-card px-4 py-2 flex items-center gap-3">
        <div className="flex bg-muted rounded-lg p-0.5">
          <button
            onClick={() => setMode("design")}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
              mode === "design"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Monitor className="h-3.5 w-3.5" /> Design
          </button>
          <button
            onClick={() => setMode("brand-studio")}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
              mode === "brand-studio"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Sparkles className="h-3.5 w-3.5" /> Brand Studio
          </button>
        </div>
        {mode === "brand-studio" && hasBrandFiles && (
          <span className="text-[11px] text-green-400 flex items-center gap-1">
            <Check className="h-3 w-3" /> Brand kit generated
          </span>
        )}
      </div>

      {/* ── DESIGN MODE ── */}
      {mode === "design" && (
        <div className="flex flex-1 min-h-0 overflow-hidden">
          <div className="w-44 border-r border-border bg-card p-3 space-y-3 shrink-0">
            <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
              Screens
            </div>
            <div className="space-y-0.5">
              {(files?.filter((f) => f.path.endsWith(".html")).slice(0, 8) ?? []).map((f) => (
                <div
                  key={f.id}
                  className="px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted rounded-md cursor-pointer truncate"
                >
                  {f.path.replace(".html", "")}
                </div>
              ))}
              {(files?.filter((f) => f.path.endsWith(".html")).length ?? 0) === 0 && (
                <div className="text-xs text-muted-foreground/50 italic px-2">No screens yet</div>
              )}
            </div>
          </div>
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            <div className="p-3 border-b border-border bg-card flex gap-2 shrink-0">
              <Input
                placeholder="Describe a design change (e.g. Make the hero darker, add a sticky nav...)"
                className="flex-1 h-8 text-sm"
                value={designPrompt}
                onChange={(e) => setDesignPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") generateDesignVariant();
                }}
              />
              <Button
                size="sm"
                className="h-8 shrink-0"
                onClick={generateDesignVariant}
                disabled={sendMessage.isPending || !designPrompt.trim()}
              >
                {sendMessage.isPending ? (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <>
                    <Paintbrush className="h-3.5 w-3.5 mr-1.5" /> Generate
                  </>
                )}
              </Button>
            </div>
            <div className="flex-1 p-4 bg-muted/20 overflow-y-auto">
              <div className="text-xs text-muted-foreground text-center py-12">
                Describe a design change above to generate variants of your app. The AI will modify
                your files and show changes in the Preview tab.
              </div>
            </div>
            <div className="p-3 border-t border-border bg-card flex justify-end shrink-0">
              <Button size="sm" variant="outline" disabled>
                <Save className="h-3.5 w-3.5 mr-1.5" /> Save as Version
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── BRAND STUDIO MODE ── */}
      {mode === "brand-studio" && (
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Left: brand form */}
          <div className="w-64 border-r border-border bg-card flex flex-col shrink-0 overflow-y-auto">
            <div className="p-4 space-y-4">
              <div>
                <div className="text-xs font-semibold text-foreground mb-3">Brand Details</div>
                <div className="space-y-3">
                  <div>
                    <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide block mb-1">
                      Brand Name *
                    </label>
                    <Input
                      placeholder="e.g. SwiftRide"
                      className="h-8 text-sm"
                      value={brandName}
                      onChange={(e) => setBrandName(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide block mb-1">
                      Tagline
                    </label>
                    <Input
                      placeholder="e.g. Get there faster"
                      className="h-8 text-sm"
                      value={tagline}
                      onChange={(e) => setTagline(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide block mb-1">
                      Industry
                    </label>
                    <Input
                      placeholder="e.g. Ride-hailing, Healthcare..."
                      className="h-8 text-sm"
                      value={industry}
                      onChange={(e) => setIndustry(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide block mb-1">
                      Color Hint
                    </label>
                    <Input
                      placeholder="e.g. Deep purple, Electric blue..."
                      className="h-8 text-sm"
                      value={colorHint}
                      onChange={(e) => setColorHint(e.target.value)}
                    />
                  </div>
                </div>
              </div>

              <div>
                <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-2">
                  Style Direction
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {STYLE_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => setStyle(opt.value)}
                      className={cn(
                        "text-left px-2 py-1.5 rounded-md text-[11px] border transition-colors",
                        style === opt.value
                          ? "bg-primary/10 border-primary/30 text-primary"
                          : "border-border text-muted-foreground hover:text-foreground hover:border-border",
                      )}
                    >
                      <div className="font-medium">{opt.label}</div>
                      <div className="text-[10px] opacity-60">{opt.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2 pt-1">
                <Button
                  className="w-full h-9"
                  onClick={generateBrandKit}
                  disabled={!brandName.trim() || generating || sendMessage.isPending}
                >
                  {generating || sendMessage.isPending ? (
                    <>
                      <RefreshCw className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Generating…
                    </>
                  ) : (
                    <>
                      <Wand2 className="h-3.5 w-3.5 mr-1.5" /> Generate Brand Kit
                    </>
                  )}
                </Button>

                {hasBrandFiles && (
                  <Button
                    variant="secondary"
                    className="w-full h-9"
                    onClick={applyBrandToApp}
                    disabled={applying || sendMessage.isPending}
                  >
                    {applying ? (
                      <>
                        <RefreshCw className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Applying…
                      </>
                    ) : (
                      <>
                        <Paintbrush className="h-3.5 w-3.5 mr-1.5" /> Apply Brand to App
                      </>
                    )}
                  </Button>
                )}

                {hasBrandFiles && (
                  <Button
                    variant="outline"
                    className="w-full h-9"
                    onClick={() => setBrandIframeKey((k) => k + 1)}
                  >
                    <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Refresh Preview
                  </Button>
                )}
              </div>

              {hasBrandFiles && (
                <div className="space-y-1 pt-1">
                  <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-2">
                    Generated Assets
                  </div>
                  {[
                    "brand/logo.svg",
                    "brand/icon.svg",
                    "brand/logo-reversed.svg",
                    "brand/favicon.svg",
                    "brand/brand.css",
                    "brand/preview.html",
                  ]
                    .filter((path) => files?.some((f) => f.path === path))
                    .map((path) => (
                      <div
                        key={path}
                        className="flex items-center gap-1.5 text-[11px] text-green-400"
                      >
                        <Check className="h-3 w-3 shrink-0" />
                        <span className="font-mono">{path}</span>
                      </div>
                    ))}
                </div>
              )}
            </div>
          </div>

          {/* Right: preview */}
          <div className="flex-1 flex flex-col min-h-0 p-4 bg-muted/20">
            {hasBrandFiles ? (
              <BrandPreview projectId={projectId} iframeKey={brandIframeKey} />
            ) : (
              <BrandEmptyState />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
