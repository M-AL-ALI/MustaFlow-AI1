import { useCallback, useState } from "react";
import { useLocation, Link } from "wouter";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { Show, useAuth } from "@clerk/react";
import {
  Code2,
  Key,
  Zap,
  Terminal,
  Globe,
  ArrowRight,
  ExternalLink,
  BookOpen,
  Lock,
  AlertCircle,
  FileCode,
  GitBranch,
  Webhook,
  Play,
  ChevronDown,
  ChevronUp,
  Loader2,
  CheckCircle2,
  XCircle,
  History,
  GitBranch,
  Webhook,
  Copy,
  Check,
} from "lucide-react";

const SESSION_TOKEN_KEY = "mf_dev_portal_token";

interface SectionProps {
  icon: React.ElementType;
  title: string;
  children: React.ReactNode;
}

function Section({ icon: Icon, title, children }: SectionProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
          <Icon className="h-5 w-5 text-primary" />
        </div>
        <h2 className="text-lg font-semibold">{title}</h2>
      </div>
      <div className="pl-12 space-y-4 text-sm text-muted-foreground leading-relaxed">
        {children}
      </div>
    </div>
  );
}

function CodeBlock({ children, language = "bash" }: { children: string; language?: string }) {
  return (
    <div className="rounded-xl border border-border bg-zinc-950 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-zinc-900/60">
        <span className="text-xs text-muted-foreground font-mono">{language}</span>
      </div>
      <pre className="px-4 py-4 overflow-x-auto text-xs font-mono text-zinc-200 leading-relaxed whitespace-pre">
        {children}
      </pre>
    </div>
  );
}

function InlineCode({ children }: { children: React.ReactNode }) {
  return (
    <code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded text-foreground">
      {children}
    </code>
  );
}

function extractPathParams(path: string): string[] {
  const matches = path.match(/:([a-zA-Z_][a-zA-Z0-9_]*)/g);
  return matches ? matches.map((m) => m.slice(1)) : [];
}

function buildUrl(path: string, params: Record<string, string>): string {
  let resolved = path;
  for (const [key, value] of Object.entries(params)) {
    resolved = resolved.replace(`:${key}`, encodeURIComponent(value || `:${key}`));
  }
  return resolved;
}

interface TryItPanelProps {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  token: string;
  onTokenChange: (t: string) => void;
  hasAuth: boolean;
}

interface ApiResponse {
  status: number;
  statusText: string;
  body: string;
  durationMs: number;
}

function TryItPanel({ method, path, token, onTokenChange, hasAuth }: TryItPanelProps) {
  const pathParams = extractPathParams(path);
  const needsBody = method === "POST" || method === "PUT" || method === "PATCH";

  const [paramValues, setParamValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(pathParams.map((p) => [p, ""])),
  );
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<ApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedCurl, setCopiedCurl] = useState(false);

  const buildCurlCommand = useCallback(() => {
    const resolvedPath = buildUrl(path, paramValues);
    const absoluteUrl = `${window.location.origin}${resolvedPath}`;
    const parts: string[] = [`curl -X ${method}`];
    parts.push(`  -H "Content-Type: application/json"`);
    if (token.trim()) {
      parts.push(`  -H "Authorization: Bearer ${token.trim()}"`);
    }
    if (needsBody && body.trim()) {
      const escaped = body.trim().replace(/'/g, "'\\''");
      parts.push(`  -d '${escaped}'`);
    }
    parts.push(`  "${absoluteUrl}"`);
    return parts.join(" \\\n");
  }, [method, path, paramValues, token, body, needsBody]);

  const handleCopyCurl = useCallback(() => {
    const cmd = buildCurlCommand();
    void navigator.clipboard.writeText(cmd).then(() => {
      setCopiedCurl(true);
      setTimeout(() => setCopiedCurl(false), 2000);
    });
  }, [buildCurlCommand]);

  const handleSend = useCallback(async () => {
    setLoading(true);
    setResponse(null);
    setError(null);

    const url = buildUrl(path, paramValues);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token.trim()) {
      headers["Authorization"] = `Bearer ${token.trim()}`;
    }

    const start = Date.now();
    try {
      const opts: RequestInit = { method, headers };
      if (needsBody && body.trim()) {
        opts.body = body.trim();
      }
      const res = await fetch(url, opts);
      const durationMs = Date.now() - start;
      let text = await res.text();
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // leave as-is if not JSON
      }
      setResponse({ status: res.status, statusText: res.statusText, body: text, durationMs });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, [method, path, paramValues, token, body, needsBody]);

  const statusColor =
    response && response.status < 300
      ? "text-emerald-400"
      : response && response.status < 500
        ? "text-amber-400"
        : "text-red-400";

  return (
    <div className="border-t border-border bg-muted/20 px-4 py-4 space-y-4">
      {/* Token */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">
          Authorization token
          {!hasAuth && (
            <Link href="/settings?tab=developer" className="ml-2 text-primary hover:underline">
              Generate one
            </Link>
          )}
        </label>
        <input
          type="password"
          value={token}
          onChange={(e) => onTokenChange(e.target.value)}
          placeholder="mfp_…"
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
        />
      </div>

      {/* Path params */}
      {pathParams.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Path parameters</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {pathParams.map((param) => (
              <div key={param} className="space-y-1">
                <label className="text-xs text-muted-foreground font-mono">{param}</label>
                <input
                  type="text"
                  value={paramValues[param] ?? ""}
                  onChange={(e) => setParamValues((prev) => ({ ...prev, [param]: e.target.value }))}
                  placeholder={`Enter ${param}`}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Request body */}
      {needsBody && (
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            Request body <span className="text-muted-foreground/60">(JSON)</span>
          </label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={'{\n  "key": "value"\n}'}
            rows={5}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 resize-y"
          />
        </div>
      )}

      {/* URL preview */}
      <div className="rounded-lg border border-border bg-zinc-950/60 px-3 py-2 flex items-center gap-2 overflow-x-auto">
        <span
          className={`text-xs font-mono font-bold shrink-0 ${
            method === "GET"
              ? "text-blue-400"
              : method === "POST"
                ? "text-emerald-400"
                : method === "PUT"
                  ? "text-violet-400"
                  : method === "PATCH"
                    ? "text-amber-400"
                    : "text-red-400"
          }`}
        >
          {method}
        </span>
        <span className="text-xs font-mono text-zinc-300 truncate">
          {buildUrl(path, paramValues)}
        </span>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          onClick={() => void handleSend()}
          disabled={loading}
          className="w-full sm:w-auto"
        >
          {loading ? (
            <>
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              Sending…
            </>
          ) : (
            <>
              <Play className="h-3.5 w-3.5 mr-1.5" />
              Send request
            </>
          )}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={handleCopyCurl}
          className="w-full sm:w-auto"
        >
          {copiedCurl ? (
            <>
              <Check className="h-3.5 w-3.5 mr-1.5 text-emerald-400" />
              Copied!
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5 mr-1.5" />
              Copy as curl
            </>
          )}
        </Button>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-3">
          <XCircle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
          <p className="text-xs text-red-300 font-mono">{error}</p>
        </div>
      )}

      {/* Response */}
      {response && (
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            {response.status < 300 ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
            ) : (
              <XCircle className="h-4 w-4 text-red-400 shrink-0" />
            )}
            <span className={`text-xs font-mono font-bold ${statusColor}`}>
              {response.status} {response.statusText}
            </span>
            <span className="text-xs text-muted-foreground">{response.durationMs} ms</span>
          </div>
          <div className="rounded-xl border border-border bg-zinc-950 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-zinc-900/60">
              <span className="text-xs text-muted-foreground font-mono">response</span>
            </div>
            <pre className="px-4 py-4 overflow-x-auto text-xs font-mono text-zinc-200 leading-relaxed whitespace-pre max-h-72 overflow-y-auto">
              {response.body || "(empty body)"}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

interface EndpointRowProps {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  description: string;
  scope?: string;
  isOpen: boolean;
  onToggle: () => void;
  token: string;
  onTokenChange: (t: string) => void;
  hasAuth: boolean;
}

function EndpointRow({
  method,
  path,
  description,
  scope,
  isOpen,
  onToggle,
  token,
  onTokenChange,
  hasAuth,
}: EndpointRowProps) {
  const methodColors: Record<string, string> = {
    GET: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    POST: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    PUT: "bg-violet-500/10 text-violet-400 border-violet-500/20",
    PATCH: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    DELETE: "bg-red-500/10 text-red-400 border-red-500/20",
  };

  return (
    <>
      <tr className={`bg-card transition-colors ${isOpen ? "bg-muted/30" : "hover:bg-muted/10"}`}>
        <td className="px-4 py-3">
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-bold border ${methodColors[method]}`}
          >
            {method}
          </span>
        </td>
        <td className="px-4 py-3 font-mono text-xs text-foreground">{path}</td>
        <td className="px-4 py-3 text-xs">{description}</td>
        <td className="px-4 py-3">
          {scope && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-mono bg-muted text-muted-foreground border border-border whitespace-nowrap">
              {scope}
            </span>
          )}
        </td>
        <td className="px-4 py-3 text-right">
          <button
            onClick={onToggle}
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-colors border ${
              isOpen
                ? "bg-primary/10 text-primary border-primary/20 hover:bg-primary/20"
                : "bg-muted text-muted-foreground border-border hover:bg-muted/70 hover:text-foreground"
            }`}
          >
            {isOpen ? (
              <>
                Close <ChevronUp className="h-3 w-3" />
              </>
            ) : (
              <>
                Try it <ChevronDown className="h-3 w-3" />
              </>
            )}
          </button>
        </td>
      </tr>
      {isOpen && (
        <tr className="bg-card">
          <td colSpan={5} className="p-0">
            <TryItPanel
              method={method}
              path={path}
              token={token}
              onTokenChange={onTokenChange}
              hasAuth={hasAuth}
            />
          </td>
        </tr>
      )}
    </>
  );
}

interface DevCardProps {
  icon: React.ElementType;
  title: string;
  description: string;
  href: string;
}

function DevCard({ icon: Icon, title, description, href }: DevCardProps) {
  return (
    <Link href={href}>
      <div className="flex items-start gap-3 p-4 rounded-xl border border-border bg-card hover:border-primary/30 hover:bg-primary/5 transition-all cursor-pointer">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
          <Icon className="h-4 w-4 text-primary" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{title}</p>
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{description}</p>
        </div>
      </div>
    </Link>
  );
}

export default function DevelopersPage() {
  const [, setLocation] = useLocation();
  const { isSignedIn } = useAuth();

  const [openEndpoint, setOpenEndpoint] = useState<string | null>(null);
  const [token, setToken] = useState<string>(() => {
    try {
      return sessionStorage.getItem(SESSION_TOKEN_KEY) ?? "";
    } catch {
      return "";
    }
  });

  const handleTokenChange = useCallback((t: string) => {
    setToken(t);
    try {
      if (t) {
        sessionStorage.setItem(SESSION_TOKEN_KEY, t);
      } else {
        sessionStorage.removeItem(SESSION_TOKEN_KEY);
      }
    } catch {
      // ignore
    }
  }, []);

  function toggleEndpoint(key: string) {
    setOpenEndpoint((prev) => (prev === key ? null : key));
  }

  const endpoints: Array<{
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    description: string;
    scope?: string;
  }> = [
    { method: "GET", path: "/api/v1/projects", description: "List all your projects", scope: "projects:read" },
    { method: "POST", path: "/api/v1/projects", description: "Create a new project", scope: "projects:write" },
    { method: "GET", path: "/api/v1/projects/:id", description: "Get project details", scope: "projects:read" },
    {
      method: "POST",
      path: "/api/v1/projects/:id/builds",
      description: "Trigger an AI build from a prompt",
      scope: "builds:trigger",
    },
    { method: "GET", path: "/api/v1/projects/:id/builds", description: "List build history", scope: "builds:read" },
    {
      method: "GET",
      path: "/api/v1/projects/:id/builds/:buildId",
      description: "Poll a specific build for status and output",
      scope: "builds:read",
    },
    {
      method: "POST",
      path: "/api/v1/projects/:id/builds/:buildId/cancel",
      description: "Cancel an in-progress build",
      scope: "builds:trigger",
    },
    {
      method: "GET",
      path: "/api/v1/projects/:id/files",
      description: "List generated project files",
      scope: "files:read",
    },
    {
      method: "GET",
      path: "/api/v1/projects/:id/files/:path",
      description: "Download a specific generated file",
      scope: "files:read",
    },
    {
      method: "PUT",
      path: "/api/v1/projects/:id/files/:path",
      description: "Create or update a project file",
      scope: "files:write",
    },
    {
      method: "GET",
      path: "/api/v1/projects/:id/domains",
      description: "List custom domains",
      scope: "domains:read",
    },
    {
      method: "POST",
      path: "/api/v1/projects/:id/domains",
      description: "Attach a custom domain",
      scope: "domains:write",
    },
    { method: "GET", path: "/api/healthz", description: "API health check — no auth required" },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Sticky header */}
      <header className="sticky top-0 z-30 backdrop-blur-xl bg-background/80 border-b border-border">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <a
            href={import.meta.env.BASE_URL || "/"}
            className="flex items-center gap-2.5 group"
            aria-label="MustaFlow AI home"
          >
            <img
              src={`${import.meta.env.BASE_URL}logo.png`}
              alt="MustaFlow AI"
              className="h-9 w-9 rounded-lg shadow-sm group-hover:scale-105 transition-transform"
            />
            <span className="text-lg font-bold tracking-tight hidden sm:inline">
              MustaFlow <span className="text-primary">AI</span>
            </span>
          </a>
          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-muted-foreground">
            <button
              onClick={() => setLocation("/pricing")}
              className="hover:text-foreground transition-colors"
            >
              Pricing
            </button>
            <button
              onClick={() => setLocation("/developers")}
              className="text-foreground transition-colors"
            >
              Developers
            </button>
            <button
              onClick={() => setLocation("/trust")}
              className="hover:text-foreground transition-colors"
            >
              Security
            </button>
            <button
              onClick={() => setLocation("/help")}
              className="hover:text-foreground transition-colors"
            >
              Help
            </button>
          </nav>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Show when="signed-out">
              <Button
                variant="ghost"
                size="sm"
                className="text-sm"
                onClick={() => setLocation("/sign-in")}
              >
                Log in
              </Button>
              <Button
                size="sm"
                className="rounded-full px-4 text-sm shadow-md"
                onClick={() => setLocation("/sign-up")}
              >
                Create account
              </Button>
            </Show>
            <Show when="signed-in">
              <Button
                size="sm"
                className="rounded-full px-4 text-sm"
                onClick={() => setLocation("/projects")}
              >
                My projects
                <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
              </Button>
            </Show>
          </div>
        </div>
      </header>

      {/* Page content */}
      <main className="flex-1">
        <div className="max-w-4xl mx-auto px-6 py-12 space-y-12">
          {/* Header */}
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <Code2 className="h-7 w-7 text-primary" />
              <h1 className="text-3xl font-bold">Developer Portal</h1>
            </div>
            <p className="text-muted-foreground max-w-xl">
              Automate project creation, trigger builds, and read output files programmatically
              using the MustaFlow AI REST API. Everything the web app does, you can do from your own
              scripts and pipelines.
            </p>
            <p className="text-xs text-muted-foreground">API version: v1 — last updated May 2026</p>
          </div>

          {/* Workspace tools */}
          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground/60">
              Workspace Tools
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <DevCard
                icon={Terminal}
                title="Terminal"
                description="Run shell commands directly inside your project workspace."
                href="/projects"
              />
              <DevCard
                icon={GitBranch}
                title="Git"
                description="Connect your project to a GitHub repository for version control and CI."
                href="/integrations"
              />
              <DevCard
                icon={Webhook}
                title="Integrations"
                description="Link your projects to external services like GitHub, databases, and more."
                href="/integrations"
              />
              <DevCard
                icon={Key}
                title="API Tokens"
                description="Generate personal access tokens to authenticate programmatic API calls."
                href="/settings?tab=developer"
              />
            </div>
          </section>

          {/* Quick links */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {[
              {
                icon: Key,
                label: "Generate API token",
                desc: "Create a personal access token",
                href: "/settings?tab=developer",
                internal: true,
              },
              {
                icon: FileCode,
                label: "OpenAPI spec",
                desc: "Download the full schema",
                href: "/openapi.yaml",
                internal: false,
              },
              {
                icon: Globe,
                label: "Health check",
                desc: "Verify the API is reachable",
                href: "/api/healthz",
                internal: false,
              },
            ].map(({ icon: Icon, label, desc, href, internal }) => (
              <div
                key={label}
                className="rounded-xl border border-border bg-card p-4 flex flex-col gap-3"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
                  <Icon className="h-4 w-4 text-primary" />
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium text-foreground">{label}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
                </div>
                {internal ? (
                  <Link
                    href={href}
                    className="flex items-center gap-1.5 text-xs text-primary hover:underline font-medium"
                  >
                    Open <ArrowRight className="h-3 w-3" />
                  </Link>
                ) : (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-xs text-primary hover:underline font-medium"
                  >
                    Open <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            ))}
          </div>

          {/* Overview */}
          <Section icon={BookOpen} title="API Overview">
            <p>
              The MustaFlow AI API is a REST API over HTTPS. All requests and responses use JSON.
              The base URL for all endpoints is:
            </p>
            <div className="rounded-lg border border-border bg-zinc-950 px-4 py-3 font-mono text-xs text-zinc-200">
              https://mustaflow.app/api/v1
            </div>
            <p>
              The API is versioned via the URL path. Breaking changes increment the version number.
              Non-breaking additions (new fields, new endpoints) are made within the current version
              without a bump.
            </p>
          </Section>

          {/* Authentication */}
          <Section icon={Lock} title="Authentication">
            <p>
              All API requests require a personal access token (PAT). Generate one from{" "}
              <Link href="/settings?tab=developer" className="text-primary hover:underline">
                Settings
              </Link>
              . Pass it in every request using the <InlineCode>Authorization</InlineCode> header:
            </p>
            <CodeBlock language="http">
              {`Authorization: Bearer mfp_xxxxxxxxxxxxxxxxxxxxxxxx`}
            </CodeBlock>
            <p>
              Tokens are scoped to your account and carry all your project permissions. Treat them
              like passwords — do not commit them to source control. You can revoke a token at any
              time from Settings without affecting other tokens.
            </p>
            <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3">
              <AlertCircle className="h-4 w-4 text-amber-400 mt-0.5 shrink-0" />
              <p className="text-xs text-amber-300">
                Requests without a valid token receive a <InlineCode>401 Unauthorized</InlineCode>{" "}
                response. Requests to resources you don&apos;t own receive{" "}
                <InlineCode>403 Forbidden</InlineCode>.
              </p>
            </div>
          </Section>

          {/* Key endpoints */}
          <Section icon={Terminal} title="Key Endpoints">
            <p>
              Below are the most commonly used endpoints. Full details for each endpoint — request
              body schemas, response shapes, and error codes — are in the{" "}
              <a href="/openapi.yaml" className="text-primary hover:underline">
                OpenAPI spec
              </a>
              . Click <strong className="text-foreground">Try it</strong> on any row to fire a live
              request directly from this page.
            </p>

            {!isSignedIn && (
              <div className="flex items-start gap-2.5 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3">
                <Key className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                <p className="text-xs text-primary/80">
                  <Link href="/sign-in" className="font-medium text-primary hover:underline">
                    Sign in
                  </Link>{" "}
                  and paste your API token into the Try it panel to authenticate requests.{" "}
                  <Link href="/settings?tab=developer" className="text-primary hover:underline">
                    Generate a token
                  </Link>{" "}
                  if you don&apos;t have one yet.
                </p>
              </div>
            )}

            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/40 border-b border-border">
                    <th className="text-left px-4 py-2.5 font-medium text-foreground text-xs">
                      Method
                    </th>
                    <th className="text-left px-4 py-2.5 font-medium text-foreground text-xs">
                      Path
                    </th>
                    <th className="text-left px-4 py-2.5 font-medium text-foreground text-xs">
                      Description
                    </th>
                    <th className="text-left px-4 py-2.5 font-medium text-foreground text-xs">
                      Scope
                    </th>
                    <th className="text-right px-4 py-2.5 font-medium text-foreground text-xs">
                      Try it
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {endpoints.map((ep) => {
                    const key = `${ep.method}:${ep.path}`;
                    return (
                      <EndpointRow
                        key={key}
                        method={ep.method}
                        path={ep.path}
                        description={ep.description}
                        scope={ep.scope}
                        isOpen={openEndpoint === key}
                        onToggle={() => toggleEndpoint(key)}
                        token={token}
                        onTokenChange={handleTokenChange}
                        hasAuth={Boolean(isSignedIn)}
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Section>

          {/* Token Scopes */}
          <Section icon={Key} title="Token Scopes">
            <p>
              When you create a personal access token, you choose which scopes it carries. A request
              using a PAT is rejected with <InlineCode>403 Forbidden</InlineCode> if the token does
              not hold the scope required by the endpoint. Session-authenticated requests (browser
              cookies) implicitly carry all scopes.
            </p>
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/40 border-b border-border">
                    <th className="text-left px-4 py-2.5 font-medium text-foreground text-xs">
                      Scope
                    </th>
                    <th className="text-left px-4 py-2.5 font-medium text-foreground text-xs">
                      What it grants
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {[
                    ["projects:read", "List projects and read project metadata"],
                    ["projects:write", "Create new projects"],
                    ["builds:read", "List build history and poll build status"],
                    ["builds:trigger", "Trigger new AI builds and cancel active ones"],
                    ["files:read", "List and download generated project files"],
                    ["files:write", "Create or update project files via the API"],
                    ["domains:read", "List custom domains attached to a project"],
                    ["domains:write", "Attach, verify, and remove custom domains"],
                    ["webhooks:read", "List registered webhooks and delivery history"],
                    ["webhooks:write", "Create, update, and delete webhooks"],
                  ].map(([scope, description]) => (
                    <tr key={scope} className="bg-card">
                      <td className="px-4 py-2.5">
                        <InlineCode>{scope}</InlineCode>
                      </td>
                      <td className="px-4 py-2.5 text-xs">{description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>
              Tokens default to <InlineCode>projects:read</InlineCode>,{" "}
              <InlineCode>builds:read</InlineCode>, and <InlineCode>files:read</InlineCode> when no
              scopes are specified. You can also scope a token to a single project so it cannot
              access any of your other projects even if the scope allows it.
            </p>
          </Section>

          {/* Rate limits */}
          <Section icon={Zap} title="Rate Limits">
            <p>
              Rate limits are applied per account. Exceeding a limit returns{" "}
              <InlineCode>429 Too Many Requests</InlineCode> with a{" "}
              <InlineCode>Retry-After</InlineCode> header indicating how many seconds to wait.
            </p>
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/40 border-b border-border">
                    <th className="text-left px-4 py-2.5 font-medium text-foreground text-xs">
                      Endpoint group
                    </th>
                    <th className="text-left px-4 py-2.5 font-medium text-foreground text-xs">
                      Limit
                    </th>
                    <th className="text-left px-4 py-2.5 font-medium text-foreground text-xs">
                      Window
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {[
                    ["AI builds (all modes)", "20 requests", "1 minute"],
                    ["Publish / export", "10 requests", "1 minute"],
                    ["All other API calls", "300 requests", "15 minutes"],
                    ["/api/healthz", "Unlimited", "—"],
                  ].map(([group, limit, window]) => (
                    <tr key={group} className="bg-card">
                      <td className="px-4 py-2.5 text-xs text-foreground font-medium">{group}</td>
                      <td className="px-4 py-2.5 text-xs">{limit}</td>
                      <td className="px-4 py-2.5 text-xs">{window}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>
              Build calls also deduct from your{" "}
              <Link href="/billing" className="text-primary hover:underline">
                credit balance
              </Link>{" "}
              (lite=1, eco=2, power=5, pro=10). Builds will fail with{" "}
              <InlineCode>402 Payment Required</InlineCode> when your balance is insufficient.
            </p>
          </Section>

          {/* Code samples */}
          <Section icon={Code2} title="Code Samples">
            <p>
              Replace <InlineCode>{"<token>"}</InlineCode> with your personal access token and{" "}
              <InlineCode>{"<project-id>"}</InlineCode> with the project ID from your dashboard.
            </p>

            <div className="space-y-2">
              <p className="font-medium text-foreground text-sm">List projects</p>
              <CodeBlock language="curl">
                {`curl https://mustaflow.app/api/v1/projects \\\n  -H "Authorization: Bearer <token>"`}
              </CodeBlock>
            </div>

            <div className="space-y-2">
              <p className="font-medium text-foreground text-sm">Trigger a build</p>
              <CodeBlock language="curl">
                {`curl -X POST https://mustaflow.app/api/v1/projects/<project-id>/builds \\\n  -H "Authorization: Bearer <token>" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "prompt": "Add a dark mode toggle to the header",\n    "mode": "power"\n  }'`}
              </CodeBlock>
            </div>

            <div className="space-y-2">
              <p className="font-medium text-foreground text-sm">Poll a build until it completes</p>
              <CodeBlock language="fetch (JavaScript)">
                {`const token = "<token>";\nconst projectId = "<project-id>";\nconst buildId = "<build-id>";\n\nasync function waitForBuild() {\n  while (true) {\n    const res = await fetch(\n      \`https://mustaflow.app/api/v1/projects/\${projectId}/builds/\${buildId}\`,\n      { headers: { Authorization: \`Bearer \${token}\` } }\n    );\n    const build = await res.json();\n\n    if (build.status === "completed") {\n      console.log("Build finished:", build.output);\n      break;\n    }\n    if (build.status === "failed") {\n      console.error("Build failed:", build.error);\n      break;\n    }\n\n    // Poll every 2 seconds\n    await new Promise((r) => setTimeout(r, 2000));\n  }\n}\n\nwaitForBuild();`}
              </CodeBlock>
            </div>
          </Section>

          {/* Changelog teaser */}
          <Section icon={History} title="Changelog">
            <p>
              Every addition, breaking change, and deprecation is recorded in the{" "}
              <Link href="/developers/changelog" className="text-primary hover:underline">
                API Changelog
              </Link>
              . Check it before upgrading integrations to catch any breaking changes.
            </p>
            <div className="space-y-2">
              {[
                {
                  version: "v1.7",
                  date: "May 2026",
                  text: "Preview environments, secret scoping, and publish gates",
                },
                {
                  version: "v1.6",
                  date: "April 2026",
                  text: "Agentic provisioning and Neon database auto-creation",
                },
                {
                  version: "v1.5",
                  date: "March 2026",
                  text: "GDPR data export, org audit log, and variant builds",
                },
              ].map(({ version, date, text }) => (
                <div
                  key={version}
                  className="flex items-start gap-3 rounded-lg border border-border bg-card px-4 py-3"
                >
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-primary/10 text-primary border border-primary/20 shrink-0">
                    {version}
                  </span>
                  <span className="flex-1 text-xs text-foreground leading-relaxed">{text}</span>
                  <span className="text-xs text-muted-foreground shrink-0">{date}</span>
                </div>
              ))}
            </div>
            <Link
              href="/developers/changelog"
              className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline font-medium"
            >
              View full changelog <ArrowRight className="h-3 w-3" />
            </Link>
          </Section>

          {/* CTA */}
          <div className="rounded-xl border border-border bg-card p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-foreground">Ready to start building?</p>
              <p className="text-xs text-muted-foreground mt-1">
                Generate a personal access token from Settings to authenticate your first API call.
              </p>
            </div>
            <Link
              href="/settings?tab=developer"
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors shrink-0"
            >
              <Key className="h-3.5 w-3.5" />
              Generate API token
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
