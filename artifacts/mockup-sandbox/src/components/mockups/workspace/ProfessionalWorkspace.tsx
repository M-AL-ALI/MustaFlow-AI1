import {
  LayoutDashboard,
  FolderOpen,
  Zap,
  Globe,
  Lock,
  Settings,
  BrainCircuit,
  History,
  Send,
  ServerCog,
  CheckCircle2,
  Code2,
  FilePen,
  Save,
  RefreshCw,
  Monitor,
  Smartphone,
  Tablet,
  ChevronDown,
  Plus,
  Blocks,
  TerminalSquare,
  CheckSquare,
  KeyRound,
  AlertTriangle,
  FileCode2,
  Layers,
  Activity,
  BarChart3,
  Cpu,
  PanelLeft,
} from "lucide-react";

const EVENTS = [
  { type: "reading_files", msg: "Reading project files…", file: null, done: true },
  { type: "generating_code", msg: "Generating code with AI…", file: null, done: true },
  { type: "editing_files", msg: "Writing index.html", file: "index.html", done: true },
  { type: "saving_version", msg: "Saving version rollback point…", file: null, done: true },
  { type: "updating_preview", msg: "Refreshing preview…", file: null, done: false },
];

const LEFT_NAV = [
  { icon: LayoutDashboard, label: "Projects" },
  { icon: BrainCircuit, label: "Knowledge" },
  { icon: Blocks, label: "Templates" },
  { icon: Activity, label: "Activity" },
  { icon: BarChart3, label: "Analytics" },
];

const SIDEBAR_ITEMS = [
  { icon: TerminalSquare, label: "New Task" },
  { icon: CheckSquare, label: "Plans" },
  { icon: Zap, label: "Tasks" },
  { icon: FileCode2, label: "Files" },
  { icon: Blocks, label: "Integrations" },
  { icon: Lock, label: "Secrets" },
  { icon: Globe, label: "Publishing" },
  { icon: History, label: "Versions" },
  { icon: Settings, label: "Settings" },
];

const TABS = ["Preview", "Canvas", "Tools & Files", "Publishing", "Logs", "Analytics", "Domains", "Manage"];

export function ProfessionalWorkspace() {
  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100 font-sans overflow-hidden select-none">

      {/* Global icon nav */}
      <div className="w-12 bg-zinc-900 border-r border-zinc-800 flex flex-col items-center py-3 gap-1 shrink-0 z-20">
        <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-violet-500 to-blue-600 flex items-center justify-center mb-3 shadow-lg">
          <Cpu className="h-4 w-4 text-white" />
        </div>
        {LEFT_NAV.map((item) => (
          <button
            key={item.label}
            title={item.label}
            className="w-9 h-9 flex items-center justify-center rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
          >
            <item.icon className="h-4 w-4" />
          </button>
        ))}
        <div className="flex-1" />
        <div className="w-7 h-7 rounded-full bg-violet-600 flex items-center justify-center text-[10px] font-bold text-white">
          D
        </div>
      </div>

      {/* Project sidebar */}
      <div className="w-52 bg-zinc-900/70 border-r border-zinc-800 flex flex-col z-10 shrink-0">
        <div className="px-3 py-3 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded bg-violet-600/20 border border-violet-500/30 flex items-center justify-center shrink-0">
              <Globe className="h-3.5 w-3.5 text-violet-400" />
            </div>
            <div className="min-w-0">
              <div className="text-xs font-semibold truncate text-zinc-100">Towing Co Landing</div>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="text-[10px] text-zinc-500">web</span>
                <span className="text-[10px] px-1.5 py-px rounded-full bg-violet-500/20 text-violet-400 font-medium">building</span>
              </div>
            </div>
          </div>
        </div>
        <div className="p-2 space-y-px overflow-y-auto flex-1 text-xs">
          {SIDEBAR_ITEMS.map((item, i) => (
            <button
              key={item.label}
              className={`flex items-center gap-2.5 w-full px-2.5 py-1.5 rounded-md text-left transition-colors ${
                i === 2
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/50"
              }`}
            >
              <item.icon className="h-3.5 w-3.5 shrink-0" />
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

        {/* Tab bar */}
        <div className="bg-zinc-900/50 border-b border-zinc-800 px-2 pt-2 flex items-end gap-1 shrink-0">
          {TABS.map((tab, i) => (
            <button
              key={tab}
              className={`px-3 py-1.5 text-[11px] font-medium rounded-t-md border transition-colors whitespace-nowrap ${
                i === 0
                  ? "bg-zinc-950 border-zinc-700 border-b-zinc-950 text-zinc-100 relative top-px"
                  : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {tab}
            </button>
          ))}
          <div className="flex-1" />
          {/* Device selector */}
          <div className="flex items-center gap-0.5 mb-1.5 bg-zinc-800/60 rounded-lg p-0.5">
            {[Monitor, Tablet, Smartphone].map((Icon, i) => (
              <button
                key={i}
                className={`p-1.5 rounded-md transition-colors ${
                  i === 0
                    ? "bg-zinc-700 text-zinc-100 shadow-sm"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            ))}
          </div>
        </div>

        {/* Preview area */}
        <div className="flex-1 bg-zinc-950 relative overflow-hidden flex items-center justify-center">
          {/* Checkerboard bg */}
          <div className="absolute inset-0 opacity-[0.03]" style={{
            backgroundImage: "linear-gradient(45deg, #fff 25%, transparent 25%), linear-gradient(-45deg, #fff 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #fff 75%), linear-gradient(-45deg, transparent 75%, #fff 75%)",
            backgroundSize: "20px 20px",
            backgroundPosition: "0 0, 0 10px, 10px -10px, -10px 0px",
          }} />
          {/* Simulated preview frame */}
          <div className="relative z-10 w-[640px] bg-white rounded-lg shadow-2xl overflow-hidden border border-zinc-700">
            <div className="h-7 bg-zinc-100 flex items-center gap-1.5 px-3 border-b border-zinc-200">
              <span className="w-2.5 h-2.5 rounded-full bg-red-400" />
              <span className="w-2.5 h-2.5 rounded-full bg-yellow-400" />
              <span className="w-2.5 h-2.5 rounded-full bg-green-400" />
              <div className="flex-1 mx-3 h-4 bg-zinc-200 rounded text-[9px] text-zinc-500 flex items-center px-2">
                preview • towing-co-landing
              </div>
            </div>
            <div className="h-56 bg-gradient-to-br from-slate-800 to-slate-900 flex items-center justify-center">
              <div className="text-center">
                <div className="text-white text-2xl font-bold">FastTow 24/7</div>
                <div className="text-slate-400 text-sm mt-1">Professional Towing Services</div>
                <div className="mt-4 px-5 py-2 bg-yellow-400 text-slate-900 rounded-lg text-sm font-semibold inline-block">
                  Call Now: (555) 247-8911
                </div>
              </div>
            </div>
            <div className="h-16 bg-white flex items-center justify-around px-6 border-t border-zinc-100">
              {["Towing", "Lockout", "Jump Start", "Tire Change"].map((s) => (
                <div key={s} className="text-center">
                  <div className="w-8 h-8 rounded-full bg-zinc-100 mx-auto mb-1" />
                  <div className="text-[9px] text-zinc-500">{s}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Activity stream + Chat — fixed bottom */}
        <div className="shrink-0 border-t border-zinc-800 bg-zinc-900/60 backdrop-blur">

          {/* Activity stream */}
          <div className="border-b border-zinc-800/60 px-4 py-2">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-violet-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-violet-500" />
              </span>
              <span className="text-[11px] font-semibold text-zinc-300">Live Activity</span>
              <span className="ml-auto text-[10px] text-zinc-600">5 steps</span>
            </div>
            <div className="flex items-center gap-3 overflow-x-auto hide-scrollbar">
              {EVENTS.map((ev, i) => {
                const icons: Record<string, React.ElementType> = {
                  reading_files: FolderOpen,
                  generating_code: Code2,
                  editing_files: FilePen,
                  saving_version: Save,
                  updating_preview: RefreshCw,
                };
                const Icon = icons[ev.type] ?? Code2;
                const isActive = !ev.done;
                return (
                  <div key={i} className="flex items-center gap-1.5 shrink-0">
                    <div className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] ${
                      isActive
                        ? "bg-violet-500/15 text-violet-300 border border-violet-500/30"
                        : ev.done
                        ? "bg-zinc-800/50 text-zinc-500"
                        : "bg-zinc-800/50 text-zinc-500"
                    }`}>
                      <Icon className={`h-3 w-3 ${isActive ? "animate-pulse" : ""}`} />
                      <span className="whitespace-nowrap">{ev.msg}</span>
                      {ev.done && <CheckCircle2 className="h-3 w-3 text-green-500/70" />}
                    </div>
                    {i < EVENTS.length - 1 && <span className="text-zinc-700 text-xs">›</span>}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Chat input */}
          <div className="p-3">
            <div className="flex items-center gap-2 mb-2">
              <button className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors">
                Plan Mode
              </button>
              <button className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold text-violet-400 bg-violet-500/10 transition-colors">
                <ServerCog className="h-3 w-3" /> Background
              </button>
              <div className="ml-auto flex bg-zinc-800/60 rounded-md p-0.5">
                {["LITE", "ECO", "POWER", "PRO"].map((m) => (
                  <button
                    key={m}
                    className={`px-2 py-0.5 text-[9px] font-bold rounded transition-colors ${
                      m === "POWER"
                        ? "bg-zinc-700 text-zinc-100 shadow-sm"
                        : "text-zinc-500 hover:text-zinc-300"
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
            <div className="relative">
              <div className="w-full bg-zinc-800/70 border border-zinc-700/60 rounded-xl px-3 py-2.5 pr-10 text-sm text-zinc-500 min-h-[42px]">
                Add a testimonials section with 3 customer reviews…
              </div>
              <button className="absolute right-2 bottom-2 w-7 h-7 bg-violet-600 rounded-lg flex items-center justify-center shadow">
                <Send className="h-3.5 w-3.5 text-white" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
