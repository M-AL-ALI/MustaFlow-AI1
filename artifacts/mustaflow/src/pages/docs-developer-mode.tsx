import {
  MessageSquare,
  Brain,
  Wrench,
  RefreshCw,
  Zap,
  MonitorPlay,
  ExternalLink,
  ArrowRight,
  ChevronRight,
} from "lucide-react";
import { Link } from "wouter";
import { DynamicAtom } from "@/components/icons/dynamic-atom";
import logoUrl from "/logo.png";

interface SectionProps {
  number: number;
  icon: React.ElementType;
  title: string;
  summary: string;
  children: React.ReactNode;
}

function Section({ number, icon: Icon, title, summary, children }: SectionProps) {
  return (
    <div className="flex gap-6">
      <div className="flex-shrink-0 flex flex-col items-center gap-2">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 border border-primary/20">
          <Icon className="h-5 w-5 text-primary" />
        </div>
        <div className="w-px flex-1 bg-border min-h-[2rem]" />
      </div>
      <div className="pb-10 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-mono text-muted-foreground/60 tracking-widest uppercase">
            Step {number}
          </span>
        </div>
        <h2 className="text-lg font-semibold text-foreground mb-1">{title}</h2>
        <p className="text-sm text-primary/80 font-medium mb-3">{summary}</p>
        <div className="text-sm text-muted-foreground leading-relaxed space-y-2">{children}</div>
      </div>
    </div>
  );
}

function CalloutBox({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 mt-3">
      <p className="text-xs font-semibold text-foreground mb-1.5 uppercase tracking-wide">
        {title}
      </p>
      <div className="text-xs text-muted-foreground leading-relaxed space-y-1">{children}</div>
    </div>
  );
}

function LoopStep({ n, label }: { n: number; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/15 text-primary text-[10px] font-bold flex-shrink-0">
        {n}
      </span>
      <span>{label}</span>
      {n < 5 && <ArrowRight className="h-3 w-3 text-muted-foreground/40 ml-auto flex-shrink-0" />}
    </div>
  );
}

export default function DocsDevModePage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-border bg-background/80 backdrop-blur-sm">
        <div className="max-w-3xl mx-auto px-6 h-14 flex items-center gap-4">
          <Link href="/" className="flex items-center gap-2 shrink-0">
            <img src={logoUrl} alt="MustaFlow AI" className="h-6 w-auto" />
          </Link>
          <span className="w-px h-5 bg-border" />
          <nav className="flex items-center gap-1 text-xs text-muted-foreground">
            <Link href="/docs" className="hover:text-foreground transition-colors">
              Docs
            </Link>
            <ChevronRight className="h-3 w-3" />
            <span className="text-foreground">Developer Mode</span>
          </nav>
          <div className="flex-1" />
          <Link
            href="/dev"
            className="flex items-center gap-1.5 text-xs text-primary hover:underline"
          >
            Open Developer Mode
            <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-12">
        {/* Hero */}
        <div className="mb-14">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 border border-primary/20">
              <DynamicAtom className="h-6 w-6 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">Developer Mode — how it works</h1>
              <p className="text-sm text-muted-foreground">
                From the moment you type a prompt to the moment code appears in your preview
              </p>
            </div>
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-2xl">
            Developer Mode is a live cloud IDE backed by an AI agent that writes real files into a
            real container. This page explains the full pipeline — every step from prompt submission
            to hot-reload in the preview iframe.
          </p>
        </div>

        {/* Steps */}
        <div>
          <Section
            number={1}
            icon={MessageSquare}
            title="You send a prompt"
            summary="Your text becomes an API request."
          >
            <p>
              When you type a message and press Send, the frontend posts your prompt to the
              MustaFlow API. There is no streaming or special protocol — it is a regular HTTP
              request.
            </p>
            <p>
              The request includes your project ID, the current conversation history, and any
              context about the active file or selection you have open in the editor.
            </p>
          </Section>

          <Section
            number={2}
            icon={Brain}
            title="The backend feeds it to an LLM"
            summary="Your prompt meets the project context."
          >
            <p>
              MustaFlow constructs a system prompt that gives the AI everything it needs to act
              effectively:
            </p>
            <CalloutBox title="What the LLM sees">
              <p>• Your prompt and the full conversation history</p>
              <p>• A description of your project's stack and current file tree</p>
              <p>• A catalog of tools it is allowed to call</p>
              <p>• Platform rules: port binding, HMR chain, safety limits</p>
              <p>• Knowledge from prior builds (lessons learned, past decisions)</p>
            </CalloutBox>
            <p className="mt-2">
              The model is not just generating text — it is deciding what to do with the tools it
              has been given.
            </p>
          </Section>

          <Section
            number={3}
            icon={Wrench}
            title="The agent has tools, not just words"
            summary="Every action calls a real tool with real consequences."
          >
            <p>
              This is the critical difference from a chatbot. The agent is given a set of callable
              tools. When it decides to act, it calls the tool — not describe what it would do.
            </p>
            <CalloutBox title="Core tools">
              <p>
                <span className="font-mono text-foreground">read_file</span> — read an existing
                file from the container filesystem
              </p>
              <p>
                <span className="font-mono text-foreground">write_file</span> — create or overwrite
                a file on disk
              </p>
              <p>
                <span className="font-mono text-foreground">apply_patch</span> — surgical edit: a
                before/after diff applied in-place
              </p>
              <p>
                <span className="font-mono text-foreground">run_command</span> — execute a shell
                command inside the container (npm, tsc, python, etc.)
              </p>
              <p>
                <span className="font-mono text-foreground">pkg_install</span> — add a dependency
                (npm/pip/cargo) without raw shell access
              </p>
              <p>
                <span className="font-mono text-foreground">list_files / search</span> — explore
                the project before editing
              </p>
            </CalloutBox>
            <p className="mt-2">
              The LLM picks which tool to call, with what arguments, and in what order — based
              entirely on your request and what it has observed so far.
            </p>
          </Section>

          <Section
            number={4}
            icon={RefreshCw}
            title="A loop runs until the task is done"
            summary="Think → act → observe → repeat."
          >
            <p>
              The agent does not do everything in one shot. It runs in an agentic loop — each turn
              it takes one action, sees the result, and decides the next step.
            </p>
            <CalloutBox title="The loop">
              <div className="space-y-1.5">
                <LoopStep n={1} label="Receive your prompt" />
                <LoopStep n={2} label="Think — decide the best next action" />
                <LoopStep n={3} label="Call a tool (file write, shell command, etc.)" />
                <LoopStep n={4} label="Observe the result" />
                <LoopStep n={5} label="Repeat — or call finalize when done" />
              </div>
            </CalloutBox>
            <p className="mt-2">
              This loop is what makes complex tasks — "build a full-stack SaaS with auth, a
              database, and a dashboard" — possible. The agent plans, executes, checks its work, and
              adapts, just like a developer would.
            </p>
            <p>
              The loop also grounds the agent in reality. Before editing a file it reads the actual
              content — it cannot hallucinate what your code looks like.
            </p>
          </Section>

          <Section
            number={5}
            icon={Zap}
            title="Every tool call has real side effects"
            summary="Nothing is simulated."
          >
            <p>
              When the agent calls <span className="font-mono text-foreground">write_file</span>,
              the file changes on disk inside your container — immediately. When it runs{" "}
              <span className="font-mono text-foreground">npm install</span>, packages actually get
              installed. When it calls{" "}
              <span className="font-mono text-foreground">run_command</span>, the output you see in
              the terminal is the real stdout/stderr from inside the container.
            </p>
            <p>
              This is intentional. Grounding the agent in a real filesystem means it is always
              working from the true current state of your project, not a model of it.
            </p>
          </Section>

          <Section
            number={6}
            icon={MonitorPlay}
            title="The preview updates as a side effect"
            summary="HMR handles it — the agent never restarts your server."
          >
            <p>
              The preview pane is an iframe pointed at your container through a byte-transparent
              reverse proxy. The moment the agent writes a file, the dev server's filesystem watcher
              detects the change:
            </p>
            <CalloutBox title="The HMR chain">
              <p>1. Agent writes a file via write_file / apply_patch</p>
              <p>2. Dev server filesystem watcher fires (chokidar / nodemon / webpack / vite)</p>
              <p>3. Server pushes a hot-reload signal over WebSocket / SSE to the iframe</p>
              <p>4. Preview refreshes — usually without a full page reload</p>
            </CalloutBox>
            <p className="mt-2">
              The agent does not control this chain. It just writes files. The rest is automatic.
              This is why the agent is instructed never to restart the dev server manually —
              restarting kills the WebSocket connection and causes the preview to go blank until the
              process comes back up.
            </p>
          </Section>
        </div>

        {/* Why this design */}
        <div className="mt-4 rounded-xl border border-border bg-muted/20 p-6 space-y-4">
          <h2 className="text-base font-semibold">Why is it designed this way?</h2>
          <div className="space-y-3 text-sm text-muted-foreground leading-relaxed">
            <div className="flex gap-3">
              <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-primary mt-2" />
              <p>
                <span className="text-foreground font-medium">Tool use makes it an agent.</span> A
                chatbot only produces text. An agent produces text and takes actions with real
                consequences. The difference is the tool catalog.
              </p>
            </div>
            <div className="flex gap-3">
              <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-primary mt-2" />
              <p>
                <span className="text-foreground font-medium">
                  The loop enables multi-step reasoning.
                </span>{" "}
                Complex tasks require dozens of steps. The loop lets the AI plan, execute, observe,
                and adapt — rather than guessing the entire solution upfront.
              </p>
            </div>
            <div className="flex gap-3">
              <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-primary mt-2" />
              <p>
                <span className="text-foreground font-medium">
                  Real files keep the agent honest.
                </span>{" "}
                By reading actual files before writing, the agent always works from the true current
                state of your project — it cannot hallucinate what your code looks like.
              </p>
            </div>
          </div>
        </div>

        {/* Footer CTA */}
        <div className="mt-10 flex items-center justify-between text-xs text-muted-foreground border-t border-border pt-6">
          <span>MustaFlow AI — Developer Mode documentation</span>
          <Link
            href="/dev"
            className="flex items-center gap-1.5 text-primary hover:underline font-medium"
          >
            Open Developer Mode
            <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
      </main>
    </div>
  );
}
