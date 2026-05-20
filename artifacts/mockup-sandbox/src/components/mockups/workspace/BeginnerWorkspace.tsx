import {
  Globe,
  Zap,
  FileCode2,
  History,
  Settings,
  Send,
  Monitor,
  Smartphone,
  Tablet,
  CheckCircle2,
  Code2,
  FilePen,
  Save,
  RefreshCw,
  FolderOpen,
  Sparkles,
  Rocket,
  Blocks,
  BrainCircuit,
  ChevronRight,
  Lock,
  Cpu,
  Activity,
} from "lucide-react";

const EVENTS = [
  { type: "reading_files", msg: "Reading files…", done: true },
  { type: "generating_code", msg: "Generating code…", done: true },
  { type: "editing_files", msg: "Writing index.html", done: false },
];

const QUICK_ACTIONS = [
  {
    icon: BrainCircuit,
    label: "Plan full app",
    desc: "Blueprint before building",
    color: "text-violet-400",
    bg: "bg-violet-500/10 border-violet-500/20",
  },
  {
    icon: Zap,
    label: "Build first draft",
    desc: "Generate from your prompt",
    color: "text-yellow-400",
    bg: "bg-yellow-500/10 border-yellow-500/20",
  },
  {
    icon: Blocks,
    label: "Add integrations",
    desc: "Auth, payments, APIs",
    color: "text-blue-400",
    bg: "bg-blue-500/10 border-blue-500/20",
  },
  {
    icon: Rocket,
    label: "Publish app",
    desc: "Go live in one click",
    color: "text-green-400",
    bg: "bg-green-500/10 border-green-500/20",
  },
];

export function BeginnerWorkspace() {
  return (
    <div className="flex h-screen bg-[#0f1117] text-zinc-100 font-sans overflow-hidden select-none">
      {/* Slim sidebar */}
      <div className="w-14 bg-[#161b27] border-r border-zinc-800/60 flex flex-col items-center py-4 gap-2 shrink-0 z-20">
        <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-violet-500 to-blue-600 flex items-center justify-center mb-2 shadow-lg shadow-violet-500/20">
          <Cpu className="h-4.5 w-4.5 text-white" style={{ width: 18, height: 18 }} />
        </div>
        {[Globe, FileCode2, Blocks, Activity, Settings].map((Icon, i) => (
          <button
            key={i}
            className={`w-10 h-10 flex items-center justify-center rounded-xl transition-colors ${
              i === 0
                ? "bg-zinc-700/60 text-zinc-200"
                : "text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800/50"
            }`}
          >
            <Icon style={{ width: 18, height: 18 }} />
          </button>
        ))}
        <div className="flex-1" />
        <div className="w-8 h-8 rounded-full bg-violet-600/80 border border-violet-500/40 flex items-center justify-center text-xs font-bold">
          D
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top bar */}
        <div className="h-12 bg-[#161b27] border-b border-zinc-800/60 flex items-center px-4 gap-3 shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded bg-violet-500/20 border border-violet-500/30 flex items-center justify-center">
              <Globe className="h-3 w-3 text-violet-400" />
            </div>
            <span className="text-sm font-semibold text-zinc-200">Towing Co Landing</span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-violet-500/20 text-violet-400 font-medium border border-violet-500/20">
              building
            </span>
          </div>
          <div className="flex-1" />
          {/* Device selector */}
          <div className="flex items-center gap-0.5 bg-zinc-800/60 rounded-xl p-1">
            {[
              { Icon: Monitor, label: "Desktop" },
              { Icon: Tablet, label: "Tablet" },
              { Icon: Smartphone, label: "Mobile" },
            ].map(({ Icon, label }, i) => (
              <button
                key={label}
                className={`px-2.5 py-1 rounded-lg flex items-center gap-1.5 text-[11px] font-medium transition-colors ${
                  i === 0
                    ? "bg-zinc-700 text-zinc-100 shadow-sm"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                <Icon style={{ width: 13, height: 13 }} />
                <span className="hidden sm:inline">{label}</span>
              </button>
            ))}
          </div>
          <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-green-500/15 border border-green-500/25 text-green-400 text-xs font-semibold hover:bg-green-500/20 transition-colors">
            <Rocket style={{ width: 13, height: 13 }} /> Publish
          </button>
        </div>

        {/* Content area */}
        <div className="flex-1 flex min-h-0 overflow-hidden">
          {/* Preview */}
          <div className="flex-1 bg-[#0f1117] relative flex items-center justify-center overflow-hidden">
            <div
              className="absolute inset-0 opacity-[0.025]"
              style={{
                backgroundImage: "radial-gradient(circle, #7c3aed 1px, transparent 1px)",
                backgroundSize: "28px 28px",
              }}
            />
            {/* Browser frame */}
            <div className="relative z-10 w-[580px] bg-white rounded-2xl shadow-2xl shadow-black/60 overflow-hidden ring-1 ring-zinc-700/50">
              <div className="h-8 bg-zinc-100/95 flex items-center gap-1.5 px-3 border-b border-zinc-200/80">
                <span className="w-2.5 h-2.5 rounded-full bg-red-400" />
                <span className="w-2.5 h-2.5 rounded-full bg-yellow-400" />
                <span className="w-2.5 h-2.5 rounded-full bg-green-400" />
                <div className="flex-1 mx-3 h-5 bg-white rounded-md border border-zinc-200 text-[9px] text-zinc-400 flex items-center px-2 gap-1">
                  <Lock style={{ width: 8, height: 8 }} className="text-zinc-400" />{" "}
                  towing-co-landing.preview
                </div>
              </div>
              <div className="h-64 bg-gradient-to-br from-gray-900 via-slate-800 to-gray-900">
                <div className="p-6">
                  <div className="text-xs text-yellow-400 font-semibold mb-1">
                    24/7 TOWING SERVICE
                  </div>
                  <div className="text-white text-2xl font-bold leading-tight">
                    When You're Stuck,
                    <br />
                    We've Got You.
                  </div>
                  <div className="mt-4 flex gap-2">
                    <div className="px-4 py-2 bg-yellow-400 text-gray-900 rounded-lg text-xs font-bold">
                      Call (555) 247-8911
                    </div>
                    <div className="px-4 py-2 bg-white/10 text-white rounded-lg text-xs font-medium border border-white/20">
                      Our Services
                    </div>
                  </div>
                  <div className="mt-5 grid grid-cols-4 gap-2">
                    {["Towing", "Lockout", "Jump Start", "Tire Change"].map((s) => (
                      <div
                        key={s}
                        className="bg-white/5 border border-white/10 rounded-lg p-2 text-center"
                      >
                        <div className="w-6 h-6 rounded-full bg-yellow-400/20 mx-auto mb-1" />
                        <div className="text-[9px] text-gray-400">{s}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="h-16 bg-white flex items-center justify-around px-6">
                {["Service Area", "About Us", "Reviews", "Contact"].map((s) => (
                  <div key={s} className="text-[10px] text-zinc-500 font-medium">
                    {s}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Right quick-actions panel */}
          <div className="w-56 bg-[#161b27] border-l border-zinc-800/60 flex flex-col p-3 gap-3 overflow-y-auto shrink-0">
            <div className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
              What's next
            </div>
            {QUICK_ACTIONS.map((action) => (
              <button
                key={action.label}
                className={`flex items-start gap-2.5 p-2.5 rounded-xl border text-left transition-all hover:scale-[1.01] ${action.bg}`}
              >
                <action.icon className={`h-4 w-4 mt-0.5 shrink-0 ${action.color}`} />
                <div className="min-w-0">
                  <div className={`text-xs font-semibold ${action.color}`}>{action.label}</div>
                  <div className="text-[10px] text-zinc-500 mt-0.5 leading-snug">{action.desc}</div>
                </div>
              </button>
            ))}
            <div className="mt-1 text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
              Recent versions
            </div>
            {["Initial build", "Add nav bar"].map((v, i) => (
              <div
                key={v}
                className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-zinc-800/50 cursor-pointer"
              >
                <History style={{ width: 12, height: 12 }} className="text-zinc-600 shrink-0" />
                <span className="text-[11px] text-zinc-400 truncate">{v}</span>
                {i === 0 && <span className="ml-auto text-[9px] text-zinc-600">latest</span>}
              </div>
            ))}
          </div>
        </div>

        {/* Bottom AI command center */}
        <div className="shrink-0 border-t border-zinc-800/60 bg-[#161b27]/90 backdrop-blur-sm">
          {/* Live activity ticker */}
          <div className="px-4 py-2 border-b border-zinc-800/40">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-violet-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-violet-500" />
                </span>
                <span className="text-[11px] font-semibold text-violet-300">AI is working</span>
              </div>
              <div className="flex items-center gap-2 flex-1 overflow-x-auto hide-scrollbar">
                {EVENTS.map((ev, i) => {
                  const icons: Record<string, React.ElementType> = {
                    reading_files: FolderOpen,
                    generating_code: Code2,
                    editing_files: FilePen,
                    saving_version: Save,
                    updating_preview: RefreshCw,
                  };
                  const Icon = icons[ev.type] ?? Code2;
                  return (
                    <div key={i} className="flex items-center gap-1 shrink-0">
                      <div
                        className={`flex items-center gap-1.5 px-2 py-0.5 rounded-lg text-[11px] ${
                          !ev.done
                            ? "bg-violet-500/15 text-violet-300 border border-violet-500/25"
                            : "text-zinc-600"
                        }`}
                      >
                        <Icon className={`h-3 w-3 ${!ev.done ? "animate-pulse" : ""}`} />
                        {ev.msg}
                        {ev.done && <CheckCircle2 className="h-3 w-3 text-green-500/60" />}
                      </div>
                      {i < EVENTS.length - 1 && (
                        <ChevronRight className="h-3 w-3 text-zinc-700 shrink-0" />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Main chat input */}
          <div className="p-3">
            <div className="flex items-start gap-2.5">
              {/* AI avatar */}
              <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-violet-600 to-blue-600 flex items-center justify-center shrink-0 shadow-lg shadow-violet-500/20 mt-0.5">
                <Sparkles style={{ width: 14, height: 14 }} className="text-white" />
              </div>
              <div className="flex-1">
                <div className="bg-zinc-800/70 border border-zinc-700/50 rounded-2xl rounded-tl-sm px-4 py-3 relative">
                  <div className="text-sm text-zinc-400 leading-relaxed">
                    What would you like to build or change next?
                  </div>
                  <div className="mt-2.5 h-px bg-zinc-700/40" />
                  <div className="mt-2.5 flex items-center gap-2">
                    <div className="flex items-center gap-1.5 text-xs text-zinc-500 flex-1">
                      <span className="w-px h-4 bg-zinc-500 animate-pulse" />
                      <span className="text-zinc-600">
                        Add a testimonials section with 3 reviews…
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="flex bg-zinc-700/60 rounded-lg p-0.5">
                        {["Lite", "Power"].map((m, i) => (
                          <button
                            key={m}
                            className={`px-2 py-0.5 text-[10px] font-bold rounded-md transition-colors ${
                              i === 1 ? "bg-zinc-600 text-zinc-100" : "text-zinc-500"
                            }`}
                          >
                            {m}
                          </button>
                        ))}
                      </div>
                      <button className="w-8 h-8 bg-violet-600 rounded-xl flex items-center justify-center shadow-lg shadow-violet-500/30 hover:bg-violet-500 transition-colors">
                        <Send style={{ width: 14, height: 14 }} className="text-white" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
