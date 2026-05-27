import {
  Package,
  Brain,
  Wrench,
  RefreshCw,
  AlertTriangle,
  ExternalLink,
  ChevronRight,
  ArrowDown,
  Cpu,
  ListChecks,
  BookOpen,
  Plug,
  KeyRound,
  Terminal,
  Server,
  ShieldCheck,
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
  last?: boolean;
}

function Section({ number, icon: Icon, title, summary, children, last }: SectionProps) {
  return (
    <div className="flex gap-6">
      <div className="flex-shrink-0 flex flex-col items-center gap-2">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 border border-primary/20">
          <Icon className="h-5 w-5 text-primary" />
        </div>
        {!last && <div className="w-px flex-1 bg-border min-h-[2rem]" />}
      </div>
      <div className="pb-10 min-w-0">
        <div className="mb-1">
          <span className="text-xs font-mono text-muted-foreground/60 tracking-widest uppercase">
            Section {number}
          </span>
        </div>
        <h2 className="text-lg font-semibold text-foreground mb-1">{title}</h2>
        <p className="text-sm text-primary/80 font-medium mb-3">{summary}</p>
        <div className="text-sm text-muted-foreground leading-relaxed space-y-3">{children}</div>
      </div>
    </div>
  );
}

function Callout({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-4 py-3">
      <p className="text-xs font-semibold text-foreground mb-2 uppercase tracking-wide">{title}</p>
      <div className="text-xs text-muted-foreground leading-relaxed space-y-1">{children}</div>
    </div>
  );
}

function CodeBlock({ children }: { children: React.ReactNode }) {
  return (
    <pre className="rounded-lg border border-border bg-zinc-950 px-4 py-3 text-xs text-emerald-400 font-mono leading-relaxed overflow-x-auto">
      {children}
    </pre>
  );
}

function FlowStep({ label, sub }: { label: string; sub?: string }) {
  return (
    <div className="flex flex-col items-center gap-1 text-center">
      <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs font-medium text-foreground w-full">
        {label}
      </div>
      {sub && <p className="text-[10px] text-muted-foreground/70 leading-tight">{sub}</p>}
    </div>
  );
}

function FlowArrow() {
  return (
    <div className="flex justify-center">
      <ArrowDown className="h-4 w-4 text-muted-foreground/40" />
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
            <span>Docs</span>
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
            real container. This page covers the full pipeline in technical depth — context
            assembly, LLM reasoning, tool calling mechanics, the agentic loop, and the failure modes
            you should know about.
          </p>
        </div>

        {/* Sections */}
        <div>
          <Section
            number={1}
            icon={Package}
            title="The prompt — more than just your words"
            summary="The backend assembles a full context package before anything reaches the AI."
          >
            <p>
              When you press Send, your text is not forwarded directly to the LLM. The backend
              constructs a large payload that gives the model everything it needs to act
              intelligently.
            </p>
            <Callout title="What the LLM receives">
              <p>
                <span className="text-foreground font-medium">System prompt</span> — a detailed
                instruction set: the AI's role, the rules it must follow, every tool it has access
                to, how to format responses, and platform-specific constraints (port binding, HMR
                chain, safety limits).
              </p>
              <p>
                <span className="text-foreground font-medium">File tree</span> — a snapshot of every
                file in the project so the AI knows what already exists before deciding whether to
                create, extend, or replace.
              </p>
              <p>
                <span className="text-foreground font-medium">Conversation history</span> — all
                previous messages in the session, giving the AI memory of what was discussed and
                built.
              </p>
              <p>
                <span className="text-foreground font-medium">Tool definitions</span> — a structured
                description of every callable tool: the name, a description of what it does, and the
                exact schema of arguments it accepts.
              </p>
              <p>
                <span className="text-foreground font-medium">Knowledge context</span> — lessons
                from prior builds on this project, injected as additional context.
              </p>
            </Callout>
            <p>
              The model needs all of this to make intelligent decisions rather than guessing
              blindly. Context assembly is not overhead — it is what makes the difference between an
              agent that can navigate a real codebase and one that hallucinates file paths.
            </p>
          </Section>

          <Section
            number={2}
            icon={Brain}
            title="How the LLM actually thinks"
            summary="Token prediction at scale produces something that looks like reasoning."
          >
            <p>
              The LLM does not think the way humans do. It predicts the most statistically likely
              next token (word fragment) given everything it has seen. But at scale, and with the
              right training, this produces something that looks like reasoning.
            </p>
            <p>
              Modern LLMs are trained to produce{" "}
              <span className="text-foreground font-medium">chain-of-thought</span> — they write out
              reasoning steps before acting. You sometimes see this as the "thinking" text in the
              agent panel. This is not decorative. The model genuinely builds on its own
              intermediate conclusions, which improves the quality of the final decision.
            </p>
            <Callout title="Example chain-of-thought before a tool call">
              <p className="italic">
                "The user wants a login form. I should check whether there is already an auth file
                before creating a new one. If there is, I should extend it rather than create a
                duplicate. Let me read the file tree first, then read the relevant file."
              </p>
            </Callout>
            <p>
              That reasoning then drives the next tool call — reading the auth file rather than
              blindly writing a new one. Suppressing chain-of-thought produces faster but lower
              quality decisions, which is why MustaFlow preserves it for complex tasks.
            </p>
          </Section>

          <Section
            number={3}
            icon={Wrench}
            title="Tool calling — the mechanics"
            summary="Instead of outputting text, the model outputs a structured JSON action."
          >
            <p>
              Tool calling is a specific capability built into modern LLMs. Instead of just
              producing text, the model can output a structured JSON object that tells the backend:
              "call this function with these arguments."
            </p>
            <p>Internally, a tool call looks like this:</p>
            <CodeBlock>{`{
  "tool": "write_file",
  "arguments": {
    "path": "src/components/LoginForm.tsx",
    "content": "import React from 'react'\\n..."
  }
}`}</CodeBlock>
            <p>
              The backend intercepts this output, executes the real action (writes the actual file
              to disk in your container), and returns the result back to the model:
            </p>
            <CodeBlock>{`{
  "result": "success",
  "path": "src/components/LoginForm.tsx",
  "bytes_written": 1842
}`}</CodeBlock>
            <p>
              The model sees this result and continues from there. This back-and-forth — model
              decides, backend executes, result returned — is what makes the agent feel interactive
              rather than a one-shot generator.
            </p>
            <p>
              Critically: the model does not execute anything itself. It only outputs structured
              intent. The backend is the execution boundary. This is what allows the platform to
              enforce safety limits, sandbox file paths, and block destructive operations before
              they reach the container.
            </p>
          </Section>

          <Section
            number={4}
            icon={RefreshCw}
            title="The agentic loop — step by step"
            summary="A single message can trigger 10, 20, or 50 loop iterations."
          >
            <p>
              Here is what actually happens during a single agent run, in full detail. A single user
              message triggers this entire sequence, and the loop repeats as many times as needed
              until the task is done.
            </p>
            <div className="space-y-1.5 mt-2">
              <FlowStep
                label="User sends prompt"
                sub="Text, conversation history, active file context"
              />
              <FlowArrow />
              <FlowStep
                label="Backend assembles full context"
                sub="System prompt + file tree + history + tool definitions + knowledge"
              />
              <FlowArrow />
              <FlowStep
                label="LLM produces chain-of-thought"
                sub="Writes out reasoning before deciding on an action"
              />
              <FlowArrow />
              <FlowStep label="LLM outputs a tool call" sub='e.g. read_file "src/App.tsx"' />
              <FlowArrow />
              <FlowStep
                label="Backend executes the tool"
                sub="Reads the file from disk, returns content"
              />
              <FlowArrow />
              <FlowStep
                label="Result appended to conversation"
                sub="The file content is now part of the LLM's context"
              />
              <FlowArrow />
              <FlowStep
                label="LLM reasons again with new information"
                sub="Decides next action based on what it read"
              />
              <FlowArrow />
              <FlowStep
                label="LLM outputs another tool call"
                sub="e.g. write_file with modified content"
              />
              <FlowArrow />
              <FlowStep
                label="Backend writes the file to disk"
                sub="Real file change in the container"
              />
              <FlowArrow />
              <FlowStep
                label="Dev server detects the change"
                sub="Filesystem watcher fires → HMR signal → preview refreshes"
              />
              <FlowArrow />
              <FlowStep label="Result returned to LLM" sub='e.g. { "result": "success" }' />
              <FlowArrow />
              <FlowStep
                label="LLM decides: is the task done?"
                sub="If not → loop again. If yes → output plain-text summary and call finalize."
              />
            </div>
            <p className="mt-3">
              Every step in this flow is real. The loop is not a simulation. Files written by the
              agent persist in the container. Commands the agent runs have actual output. The
              preview that refreshes is the real dev server responding to real file changes.
            </p>
          </Section>

          <Section
            number={5}
            icon={AlertTriangle}
            title="Why the loop can go wrong"
            summary="Autonomous decisions compound — early mistakes propagate forward."
            last
          >
            <p>
              Because the agent makes decisions autonomously, errors in early steps can silently
              corrupt every subsequent decision. There are three main failure patterns:
            </p>
            <Callout title="1. Stale or misread context">
              <p>
                If the agent misreads a file early in the loop — or assumes a file exists without
                checking — every subsequent decision builds on a wrong assumption. By the time it
                writes the final file, it may have produced code that references functions,
                variables, or paths that do not exist.
              </p>
              <p className="mt-1">
                The fix: the agent is instructed to always read files before editing them, and to
                re-read after complex changes to confirm the result matches expectations.
              </p>
            </Callout>
            <Callout title="2. Silent command failures">
              <p>
                If a shell command fails — a build error, a package that does not install, a test
                that exits non-zero — but the agent does not check the output carefully, it may
                continue as if the command succeeded. The next step then builds on a broken
                foundation.
              </p>
              <p className="mt-1">
                The fix: the agent is required to check stdout/stderr and exit codes after every{" "}
                <span className="font-mono text-foreground">run_command</span> call. Failures must
                be explicitly handled, not ignored.
              </p>
            </Callout>
            <Callout title="3. Context window limits">
              <p>
                There is a hard limit on how many tokens (word fragments) an LLM can hold in its
                context window at once. In a long agent run, if the context fills up, early messages
                — including the original instructions and the first files read — get compressed or
                dropped. The agent can lose track of earlier decisions.
              </p>
              <p className="mt-1">
                The fix: MustaFlow enforces a step cap on loop iterations and a wall-clock time
                limit. The agent is also designed to make small, focused changes rather than
                attempting to do everything in one giant loop, which keeps context usage bounded.
              </p>
            </Callout>
            <p>
              Good agent design adds checkpoints — moments where the agent re-reads files or runs
              verification commands to confirm its assumptions are still correct before proceeding
              to the next phase of a task. This is why the system prompt explicitly instructs the
              agent to run checks after meaningful edits rather than racing to finalize.
            </p>
          </Section>

          <Section
            number={6}
            icon={Cpu}
            title="How the agent picks the right tool"
            summary="Tools are described to the agent, not hardcoded into it."
          >
            <p>
              The agent does not have built-in knowledge of which tools exist. Every time a session
              starts, the backend sends the LLM a structured list of available tools — their names,
              descriptions, and the exact schema of arguments each one accepts. The LLM reads these
              descriptions and reasons over them to decide which tool fits the situation.
            </p>
            <Callout title="What a tool definition looks like internally">
              <CodeBlock>{`{
  "name": "run_command",
  "description": "Run a terminal command in the project
  container. Use this to install packages, run tests,
  or execute scripts.",
  "parameters": {
    "argv": "string[] — command as an argument array"
  }
}`}</CodeBlock>
            </Callout>
            <p>
              When you say "install this package," the agent maps that to{" "}
              <span className="font-mono text-foreground">run_command</span> with{" "}
              <span className="font-mono text-foreground">["npm", "install", "..."]</span>. This is
              not pattern matching — it is semantic reasoning over the tool descriptions using the
              same language understanding the model uses for everything else.
            </p>
            <p>
              This design means new tools can be added to the agent without retraining the model.
              The backend just updates the list sent at session start, and the model adapts
              immediately.
            </p>
          </Section>

          <Section
            number={7}
            icon={ListChecks}
            title="The check sequence"
            summary="The agent mirrors the instincts of an experienced developer."
          >
            <p>
              The checks the agent performs are not arbitrary. They follow the same mental checklist
              a professional developer runs automatically — absorbed from training on vast amounts
              of code reviews, debugging sessions, and developer conversations.
            </p>
            <Callout title="The check sequence">
              <p>
                <span className="text-foreground font-medium">Before writing a file</span> — read
                the existing file first. Writing blindly risks destroying logic the agent did not
                know about.
              </p>
              <p>
                <span className="text-foreground font-medium">Before creating something new</span> —
                search for whether it already exists. Duplicate components, routes, or database
                tables cause cascading conflicts.
              </p>
              <p>
                <span className="text-foreground font-medium">After running a command</span> — check
                the exit code and output. A failed <span className="font-mono">npm install</span>{" "}
                should stop the agent, not let it keep building on broken dependencies.
              </p>
              <p>
                <span className="text-foreground font-medium">After writing code</span> — run a
                typecheck or linter if available. Catches syntax and type errors before they reach
                the preview.
              </p>
              <p>
                <span className="text-foreground font-medium">After a multi-step build</span> —
                re-read key files to confirm the final state matches what was intended. The agent's
                memory of what it wrote can drift from reality when multiple files were changed in
                sequence.
              </p>
            </Callout>
            <p>
              These checkpoints are what separate an agent that compounds errors from one that
              catches and corrects them in the same loop.
            </p>
          </Section>

          <Section
            number={8}
            icon={BookOpen}
            title="How the agent's knowledge grows"
            summary="Three distinct layers: training, session context, and the Knowledge Vault."
          >
            <Callout title="Level 1 — Training (permanent, baked into model weights)">
              <p>
                The LLM was trained on GitHub repositories, Stack Overflow, documentation, technical
                books, and code review threads. It learned common patterns in every major language
                and framework, how to reason through ambiguous requirements, and how to break large
                problems into smaller steps. This knowledge is frozen into the model's weights — it
                does not change during your session.
              </p>
            </Callout>
            <Callout title="Level 2 — Session context (temporary, per conversation)">
              <p>
                Within a session, the agent accumulates understanding by building up the
                conversation window: every file it reads adds to what it knows about your project,
                every tool result tells it whether its last action succeeded, every user message
                corrects or extends its understanding. This resets when the session ends.
              </p>
            </Callout>
            <Callout title="Level 3 — Knowledge Vault (persistent, per project)">
              <p>
                This is where MustaFlow adds something beyond the base model. The Knowledge Vault
                stores lessons learned about your specific project after every build, refine,
                rollback, or publish:
              </p>
              <p className="mt-1 italic">
                "This project uses Tailwind v4 utility classes, not v3."
                <br />
                "The user prefers cards over tables for displaying lists."
                <br />
                "The database uses UUIDs, not integer IDs."
              </p>
              <p className="mt-1">
                These lessons are injected back into context at the start of future sessions. The
                agent effectively remembers your project's patterns across separate conversations —
                even though the LLM itself has no persistent memory.
              </p>
            </Callout>
            <p>
              The Knowledge Vault exists because of the context window limit: you cannot fit the
              entire history of a large project into every prompt. The vault is a curated,
              compressed summary of the most important facts — it lets the agent act like it has
              been working on your project for months even when starting a fresh session.
            </p>
          </Section>

          <Section
            number={9}
            icon={Plug}
            title="How integrations work"
            summary="Pre-wired connections — the agent calls by name, not by raw API."
          >
            <p>
              An integration is a pre-wired connection between the agent and a third-party service
              (Stripe, GitHub, Linear, Google Sheets, etc.). Instead of you having to explain the
              API and provide credentials, the integration layer:
            </p>
            <Callout title="What the integration layer provides">
              <p>
                <span className="text-foreground font-medium">API surface</span> — the integration
                already knows the endpoints, authentication flow, and data shapes for the service.
              </p>
              <p>
                <span className="text-foreground font-medium">Stored credentials</span> — API keys
                and tokens are provisioned and stored securely before the agent ever runs.
              </p>
              <p>
                <span className="text-foreground font-medium">Tool wrappers</span> — the service's
                API is translated into plain-language tool descriptions the agent can reason over,
                exactly like any other tool.
              </p>
            </Callout>
            <p>
              When you say "add Stripe payments," the agent does not look up the Stripe docs. The
              integration layer has already translated Stripe's API into a set of tools with
              plain-language descriptions. The agent picks the right tool by matching your request
              to the description.
            </p>
            <p>
              Under the hood, when the agent calls a Stripe tool, the integration layer retrieves
              the stored credentials, makes the real API call to Stripe, and returns the result. The
              agent never sees the raw credentials — it only sees the result. This keeps the agent
              focused on what to do rather than how to authenticate.
            </p>
          </Section>

          <Section
            number={10}
            icon={KeyRound}
            title="Keys — storage, injection, and security"
            summary="Defense in depth: encrypted at rest, injected at runtime, never exposed."
            last
          >
            <Callout title="Types of credentials">
              <p>
                <span className="text-foreground font-medium">Publishable key (PK)</span> — safe to
                expose in frontend code. Used to initialize client-side SDKs (e.g. Stripe.js,
                Clerk).
              </p>
              <p>
                <span className="text-foreground font-medium">Secret key (SK)</span> — must never
                leave the server. Used for privileged API calls (charge a card, create a user).
              </p>
              <p>
                <span className="text-foreground font-medium">DB connection string</span> — gives
                full read/write access to the database. Treated as the most sensitive credential.
              </p>
            </Callout>
            <p>
              The agent does not generate keys — it provisions them by calling the relevant
              service's API. When a new agentic project is created, a Fly.io machine and a Neon
              Postgres database are provisioned, the connection string is returned and immediately
              encrypted, and stored. It never appears in plain text.
            </p>
            <Callout title="The security chain">
              <p>
                <span className="text-foreground font-medium">At rest</span> — AES-256-GCM
                encryption. Stored as{" "}
                <span className="font-mono">v1:&lt;iv&gt;:&lt;ciphertext&gt;:&lt;auth_tag&gt;</span>
                . The encryption key lives in environment secrets, separate from the database —
                unreadable without it even if the DB is compromised.
              </p>
              <p>
                <span className="text-foreground font-medium">In transit</span> — the server
                decrypts keys in memory and injects them as environment variables into the running
                container. They are never written to a file, never logged, never returned to the
                browser.
              </p>
              <p>
                <span className="text-foreground font-medium">Via the API</span> — requesting a
                secret returns only a masked preview:{" "}
                <span className="font-mono text-foreground">••••••••XXXX</span>. The real value
                never leaves the server.
              </p>
            </Callout>
            <p>
              The agent itself never knows the value of any key. At the start of each session it is
              told only which environment variable names are available. When it writes code that
              needs a credential — for example{" "}
              <span className="font-mono text-foreground">process.env.STRIPE_SECRET_KEY</span> — it
              references it by name. The actual value is injected by the server at runtime. The
              separation is intentional: it keeps the agent stateless with respect to credentials,
              so even if the agent's context were somehow intercepted, there is nothing sensitive in
              it.
            </p>
          </Section>
        </div>

        {/* Why this design */}
        <div className="rounded-xl border border-border bg-muted/20 p-6 space-y-4 mt-4">
          <h2 className="text-base font-semibold">Why is it designed this way?</h2>
          <div className="space-y-3 text-sm text-muted-foreground leading-relaxed">
            {[
              {
                title: "Tool use makes it an agent.",
                body: "A chatbot only produces text. An agent produces structured intent that the backend executes with real consequences. The model cannot bypass the execution boundary — every action is intercepted, validated, and sandboxed before it runs.",
              },
              {
                title: "The loop enables multi-step reasoning.",
                body: "Complex tasks require dozens of steps. The loop lets the AI plan, execute, observe, and adapt — turn by turn — rather than guessing the entire solution upfront. Chain-of-thought within each turn further improves decision quality.",
              },
              {
                title: "Real files keep the agent honest.",
                body: "By reading actual files before writing, the agent always works from the true current state of the project. It cannot hallucinate what your code looks like — the filesystem is the ground truth.",
              },
              {
                title: "The HMR chain is intentional.",
                body: "The agent never restarts the dev server because restarting kills the WebSocket connection and breaks the preview. Instead, every file write automatically triggers the filesystem watcher, which triggers HMR, which updates the iframe. The agent just writes — the rest is infrastructure.",
              },
              {
                title: "Tools are described, not hardcoded.",
                body: "The agent reasons over tool descriptions sent at session start. New capabilities can be added without retraining the model — just update the list. The model adapts immediately.",
              },
              {
                title: "The Knowledge Vault bridges sessions.",
                body: "LLMs have no persistent memory. The vault stores curated, compressed lessons from every build and injects them into future sessions, so the agent can act like it has been working on your project for months even when starting fresh.",
              },
              {
                title: "Keys are never exposed to the agent.",
                body: "The agent references credentials by environment variable name only. Values are encrypted at rest, decrypted in server memory, and injected into the container at runtime. Even if the agent's context were intercepted, there is nothing sensitive in it.",
              },
            ].map(({ title, body }) => (
              <div key={title} className="flex gap-3">
                <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-primary mt-2" />
                <p>
                  <span className="text-foreground font-medium">{title}</span> {body}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* Conclusion */}
        <div className="rounded-xl border border-primary/30 bg-primary/5 p-6 space-y-5 mt-4">
          <div>
            <h2 className="text-base font-semibold">Conclusion</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Developer Mode is not a simulation. Every claim on this page is observable or
              independently verifiable.
            </p>
          </div>
          <div className="space-y-4">
            {[
              {
                icon: Terminal,
                title: "Tool calling with real filesystem access",
                note: "you can see this happen",
                body: "Every file write, command run, and search the agent performs is logged in the activity panel in real time. The files it writes appear immediately on disk inside the container — you can open a terminal and inspect them directly.",
              },
              {
                icon: Server,
                title: "Runs in a real Linux container",
                note: "verifiable",
                body: "Each Developer Mode project is backed by a dedicated Fly.io machine running a standard Linux environment. The agent's shell commands execute inside that container — not in a sandbox emulator, not in a browser process. Port binding, package installation, and process management all behave exactly as they would on a real server.",
              },
              {
                icon: Plug,
                title:
                  "Integrations provisioned through the platform, injected as environment variables",
                note: "documented publicly",
                body: "Third-party service connections (Stripe, GitHub, and others) are set up through Replit's integration layer. Credentials are stored in the platform's secrets store and injected into the container as environment variables at runtime. The agent references them by name — it never handles the raw values.",
              },
              {
                icon: ShieldCheck,
                title: "Keys stored as environment secrets, never exposed in browser responses",
                note: "observable",
                body: "You can verify this yourself: open the browser's network panel, call the secrets API, and inspect the response. Every secret value is returned as a masked preview — the real value is absent. The server decrypts secrets in memory only at build time and injects them directly into the container environment. They never travel to the client.",
              },
            ].map(({ icon: Icon, title, note, body }) => (
              <div key={title} className="flex gap-4">
                <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center mt-0.5">
                  <Icon className="h-4 w-4 text-primary" />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium text-foreground">
                    {title}{" "}
                    <span className="text-xs font-normal text-muted-foreground">({note})</span>
                  </p>
                  <p className="text-sm text-muted-foreground leading-relaxed">{body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
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
