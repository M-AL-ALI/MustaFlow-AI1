import { useEffect, useMemo, useState, type ElementType } from "react";
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
import {
  formatOraxDesktopReleaseSize,
  getOraxDesktopReleaseStatus,
  isValidOraxDesktopManifest,
  type OraxDesktopReleaseManifest,
} from "@/lib/orax-desktop-release";
import { useGetMyPreferences } from "@workspace/api-client-react";

const CAPABILITIES: { icon: ElementType; label: string }[] = [
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
  const releaseStatus = useMemo(() => getOraxDesktopReleaseStatus(), []);
  const [releaseManifest, setReleaseManifest] = useState<OraxDesktopReleaseManifest | null>(null);
  const [releaseLoading, setReleaseLoading] = useState(false);
  const [releaseError, setReleaseError] = useState<string | null>(null);

  useEffect(() => {
    if (!releaseStatus.publicDownloadEnabled || !releaseStatus.manifestUrl) {
      setReleaseManifest(null);
      setReleaseError(null);
      setReleaseLoading(false);
      return;
    }

    let cancelled = false;
    setReleaseLoading(true);
    setReleaseError(null);

    fetch(releaseStatus.manifestUrl, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Manifest request failed (${response.status})`);
        }
        return response.json();
      })
      .then((json) => {
        if (!isValidOraxDesktopManifest(json)) {
          throw new Error("Release manifest did not pass validation");
        }
        if (!cancelled) {
          setReleaseManifest(json);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setReleaseManifest(null);
          setReleaseError(error instanceof Error ? error.message : "Release manifest unavailable");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setReleaseLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [releaseStatus.manifestUrl, releaseStatus.publicDownloadEnabled]);

  const publicDownloadReady =
    releaseStatus.publicDownloadEnabled && Boolean(releaseManifest?.downloadUrl);
  const directRelease = publicDownloadReady ? releaseManifest : null;
  const releaseCards = [
    ["Installer", "Windows NSIS build is ready for internal testing"],
    ["Signed release channel", "Download channel is staged for internal release review"],
    ["Release automation", "Manual release workflow is ready for signed upload"],
    [
      "Public access",
      publicDownloadReady
        ? `Public download is live for version ${releaseManifest?.version}`
        : releaseStatus.publicDownloadEnabled
          ? "Public switch is on; waiting for a verified release manifest"
          : "Direct download opens after signing and smoke tests pass; public download disabled until then",
    ],
  ];

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
            {directRelease ? (
              <a
                href={directRelease.downloadUrl}
                className="inline-flex h-12 items-center gap-2 rounded-full bg-foreground px-8 text-sm font-semibold text-background hover:opacity-90"
              >
                <Download className="h-4 w-4" />
                Download for Windows
              </a>
            ) : (
              <a
                href="#download"
                className="inline-flex h-12 items-center gap-2 rounded-full bg-foreground px-8 text-sm font-semibold text-background hover:opacity-90"
              >
                <ArrowRight className="h-4 w-4" />
                Check installer status
              </a>
            )}
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
              Windows installer builds are ready for internal testing and controlled by the signed
              release channel. Public download opens only when the release switch and manifest are
              both verified.
            </p>
          </div>
          <div className="mx-auto grid max-w-3xl grid-cols-1 gap-3 text-left sm:grid-cols-4">
            {releaseCards.map(([label, detail]) => (
              <div key={label} className="rounded-2xl border border-border bg-background p-4">
                <p className="text-sm font-semibold">{label}</p>
                <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
              </div>
            ))}
          </div>
          <div className="mx-auto max-w-3xl rounded-2xl border border-border bg-background p-4 text-left">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-sm font-semibold">Release status</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {releaseStatus.publicDownloadEnabled
                    ? releaseManifest
                      ? `Verified release manifest for ${releaseManifest.version}`
                      : releaseLoading
                        ? "Checking release manifest before enabling download"
                        : releaseError
                          ? `Release manifest unavailable: ${releaseError}`
                          : "Release manifest URL is not configured"
                    : "Public download disabled"}
                </p>
              </div>
              <span className="inline-flex w-fit rounded-full border border-border px-3 py-1 text-xs font-medium text-muted-foreground">
                {publicDownloadReady ? "Download ready" : "Early access"}
              </span>
            </div>
            {releaseManifest ? (
              <div className="mt-3 grid grid-cols-1 gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                <span>Channel: {releaseManifest.channel}</span>
                <span>Size: {formatOraxDesktopReleaseSize(releaseManifest.sizeBytes)}</span>
                <span>SHA-256: {releaseManifest.sha256.slice(0, 12)}...</span>
              </div>
            ) : null}
          </div>
          <div className="mx-auto max-w-3xl rounded-2xl border border-border bg-background p-4 text-left">
            <p className="text-sm font-semibold">After installation</p>
            <p className="mt-1 text-xs text-muted-foreground">
              The installer installs Orax Desktop. On first run, Orax checks PowerShell, Git,
              Node.js, npm, and pnpm on the computer and guides any approved setup needed for local
              coding work.
            </p>
          </div>
          <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
            {directRelease ? (
              <a
                href={directRelease.downloadUrl}
                className="inline-flex h-12 items-center gap-2 rounded-full bg-foreground px-8 text-sm font-semibold text-background hover:opacity-90"
              >
                <Download className="h-4 w-4" />
                Download for Windows
              </a>
            ) : (
              <button
                type="button"
                disabled
                aria-disabled="true"
                className="inline-flex h-12 cursor-not-allowed items-center gap-2 rounded-full bg-muted px-8 text-sm font-semibold text-muted-foreground"
              >
                <Lock className="h-4 w-4" />
                Installer not available yet
              </button>
            )}
            <Link
              href="/orax"
              className="inline-flex h-12 items-center gap-2 rounded-full border border-border bg-background px-8 text-sm font-medium hover:bg-muted"
            >
              Open Workspace
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
          <p className="text-xs text-muted-foreground">
            Installer build pending public release. Public download remains off unless
            VITE_ORAX_DESKTOP_PUBLIC_DOWNLOAD_ENABLED is true and
            VITE_ORAX_DESKTOP_RELEASE_MANIFEST_URL points to a valid signed release manifest.
            Request early access through the MustaFlow team if you need the internal installer.
          </p>
        </section>
      </main>
    </div>
  );
}
