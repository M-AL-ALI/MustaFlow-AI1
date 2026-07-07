import { Link } from "wouter";
import {
  ArrowLeft,
  ArrowRight,
  Code2,
  CreditCard,
  Download,
  FileSearch,
  GitBranch,
  Globe,
  Lock,
  Monitor,
  Play,
  ShieldCheck,
  Smartphone,
  Terminal,
  Zap,
} from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { useGetMyPreferences } from "@workspace/api-client-react";

const CAPABILITIES: { icon: React.ElementType; label: string }[] = [
  { icon: FileSearch, label: "Understand full codebases" },
  { icon: Code2, label: "Edit local files" },
  { icon: Terminal, label: "Run PowerShell and terminal commands" },
  { icon: Play, label: "Run tests, typechecks, and builds" },
  { icon: Zap, label: "Debug failures and retry fixes" },
  { icon: GitBranch, label: "Review diffs and connect GitHub" },
  { icon: GitBranch, label: "Create branches and pull requests" },
  { icon: FileSearch, label: "Analyze screenshots, files, zips, and logs" },
  { icon: Smartphone, label: "Continue work from your phone" },
  { icon: Globe, label: "Manage remotely from web or mobile" },
];

const STEPS = [
  {
    label: "Install Orax Desktop",
    detail:
      "Download and install the Orax Desktop app on your Windows PC. macOS and Linux support are coming soon.",
  },
  {
    label: "Sign in with MustaFlow AI",
    detail:
      "Sign in with the same MustaFlow AI account you use on the website. All your data stays in sync.",
  },
  {
    label: "Add a project folder",
    detail:
      "Point Orax to a local project folder. Orax will inspect files and prepare context before starting work.",
  },
  {
    label: "Pair web and mobile",
    detail:
      "Scan a QR code from your phone or browser to connect remote-control surfaces to your desktop.",
  },
  {
    label: "Ask Orax to build or fix",
    detail:
      "Describe what you want in plain language — fix a bug, review code, run tests, or create a pull request.",
  },
  {
    label: "Approve sensitive actions",
    detail:
      "File edits, command execution, and Git pushes require your approval based on your permission policy.",
  },
  {
    label: "Push to GitHub",
    detail:
      "When the work is ready, Orax creates a branch, commits the changes, and opens a pull request for review.",
  },
];

const SECURITY = [
  {
    icon: Lock,
    label: "Your machine, your files",
    detail:
      "Orax only accesses the project folders you explicitly approve. Nothing outside those folders is touched.",
  },
  {
    icon: ShieldCheck,
    label: "Approval-gated execution",
    detail:
      "File edits, commands, package installs, and Git pushes require your approval based on your permission policy.",
  },
  {
    icon: ShieldCheck,
    label: "Secrets stay local",
    detail:
      "Environment files and credentials are never sent to MustaFlow Cloud without your explicit approval.",
  },
  {
    icon: Monitor,
    label: "Device revocation",
    detail:
      "Revoke any paired desktop or mobile device instantly from the website, the desktop app, or your phone.",
  },
];

export default function OraxProductPage() {
  const { data: prefs } = useGetMyPreferences();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-background px-4">
        <div className="flex items-center gap-3">
          <Link
            href="/mode-select"
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Back to mode select"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <span className="text-sm font-semibold">Orax</span>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/orax"
            className="hidden items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground sm:inline-flex"
          >
            Open Workspace
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-20 px-4 py-16">
        <section className="space-y-6 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-foreground text-background">
            <Terminal className="h-8 w-8" />
          </div>
          <div>
            <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl">
              Orax by MustaFlow AI
            </h1>
            <p className="mx-auto mt-4 max-w-xl text-lg text-muted-foreground">
              Your local coding and workflow agent. The desktop app runs local work; web and mobile
              are remote control surfaces so you can approve and monitor from anywhere.
            </p>
          </div>
          <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
            <a
              href="#download"
              className="inline-flex h-12 items-center gap-2 rounded-full bg-foreground px-8 text-sm font-semibold text-background hover:opacity-90"
            >
              <Download className="h-4 w-4" />
              Download for Windows
            </a>
            <a
              href="#how-it-works"
              className="inline-flex h-12 items-center gap-2 rounded-full border border-border bg-background px-8 text-sm font-medium hover:bg-muted"
            >
              How Orax works
              <ArrowRight className="h-4 w-4" />
            </a>
          </div>
        </section>

        <section>
          <h2 className="mb-8 text-2xl font-bold tracking-tight">What Orax can do</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {CAPABILITIES.map(({ icon: Icon, label }) => (
              <div
                key={label}
                className="flex items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3"
              >
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="text-sm">{label}</span>
              </div>
            ))}
          </div>
        </section>

        <section id="how-it-works">
          <h2 className="mb-8 text-2xl font-bold tracking-tight">How it works</h2>
          <ol className="space-y-4">
            {STEPS.map((step, index) => (
              <li key={step.label} className="flex items-start gap-4">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-foreground text-sm font-bold text-background">
                  {index + 1}
                </div>
                <div className="min-w-0 pt-1">
                  <div className="font-semibold">{step.label}</div>
                  <p className="mt-0.5 text-sm text-muted-foreground">{step.detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section>
          <h2 className="mb-8 text-2xl font-bold tracking-tight">Security and control</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {SECURITY.map(({ icon: Icon, label, detail }) => (
              <div key={label} className="space-y-2 rounded-2xl border border-border bg-card p-4">
                <div className="flex items-center gap-2">
                  <Icon className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-semibold">{label}</span>
                </div>
                <p className="text-sm text-muted-foreground">{detail}</p>
              </div>
            ))}
          </div>
        </section>

        {prefs ? (
          <section className="space-y-4 rounded-3xl border border-border bg-card p-6">
            <div className="flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-muted-foreground" />
              <h2 className="font-semibold">Your account</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Orax usage is tracked separately from Ora. Credits are shared across your MustaFlow AI
              account.
            </p>
            <Link
              href="/billing"
              className="inline-flex h-9 items-center gap-2 rounded-full border border-border bg-background px-4 text-sm font-medium hover:bg-muted"
            >
              View Billing and Usage
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </section>
        ) : null}

        <section
          id="download"
          className="space-y-5 rounded-3xl border border-border bg-card p-8 text-center"
        >
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-foreground text-background">
            <Terminal className="h-7 w-7" />
          </div>
          <div>
            <h2 className="text-2xl font-bold">Download Orax Desktop</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Windows installer builds are ready for internal testing. Public download opens after
              signing and release review.
            </p>
          </div>
          <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/support/tickets"
              className="inline-flex h-12 items-center gap-2 rounded-full bg-foreground px-8 text-sm font-semibold text-background hover:opacity-90"
            >
              <Download className="h-4 w-4" />
              Request early access
            </Link>
            <Link
              href="/orax"
              className="inline-flex h-12 items-center gap-2 rounded-full border border-border bg-background px-8 text-sm font-medium hover:bg-muted"
            >
              Open Workspace
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
          <p className="text-xs text-muted-foreground">
            Installer build pending public release. Internal builds are produced from the Orax
            Desktop package and are not committed to the repository.
          </p>
        </section>
      </main>
    </div>
  );
}
