import { useLocation, Link } from "wouter";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { Show } from "@clerk/react";
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
} from "lucide-react";

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

interface EndpointRowProps {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  description: string;
}

function EndpointRow({ method, path, description }: EndpointRowProps) {
  const methodColors: Record<string, string> = {
    GET: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    POST: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    PATCH: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    DELETE: "bg-red-500/10 text-red-400 border-red-500/20",
  };
  return (
    <tr className="bg-card">
      <td className="px-4 py-3">
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-bold border ${methodColors[method]}`}
        >
          {method}
        </span>
      </td>
      <td className="px-4 py-3 font-mono text-xs text-foreground">{path}</td>
      <td className="px-4 py-3 text-xs">{description}</td>
    </tr>
  );
}

export default function DevelopersPage() {
  const [, setLocation] = useLocation();

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Sticky header — same pattern as the landing page */}
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
        <div className="max-w-3xl mx-auto px-6 py-12 space-y-12">
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

          {/* Quick links */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {[
              {
                icon: Key,
                label: "Generate API token",
                desc: "Create a personal access token",
                href: "/settings",
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
              <Link href="/settings" className="text-primary hover:underline">
                Settings
              </Link>
              . Pass it in every request using the <InlineCode>Authorization</InlineCode> header:
            </p>
            <CodeBlock language="http">
              {`Authorization: Bearer mf_pat_xxxxxxxxxxxxxxxxxxxxxxxx`}
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
              .
            </p>
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
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  <EndpointRow
                    method="GET"
                    path="/api/v1/projects"
                    description="List all your projects"
                  />
                  <EndpointRow
                    method="POST"
                    path="/api/v1/projects"
                    description="Create a new project"
                  />
                  <EndpointRow
                    method="GET"
                    path="/api/v1/projects/:id"
                    description="Get project details"
                  />
                  <EndpointRow
                    method="POST"
                    path="/api/v1/projects/:id/builds"
                    description="Trigger an AI build from a prompt"
                  />
                  <EndpointRow
                    method="GET"
                    path="/api/v1/projects/:id/builds"
                    description="List build history"
                  />
                  <EndpointRow
                    method="GET"
                    path="/api/v1/projects/:id/builds/:buildId"
                    description="Poll a specific build for status and output"
                  />
                  <EndpointRow
                    method="GET"
                    path="/api/v1/projects/:id/files"
                    description="List generated project files"
                  />
                  <EndpointRow
                    method="GET"
                    path="/api/v1/projects/:id/files/:path"
                    description="Download a specific generated file"
                  />
                  <EndpointRow
                    method="POST"
                    path="/api/v1/projects/:id/publish"
                    description="Publish the latest build to production"
                  />
                  <EndpointRow
                    method="GET"
                    path="/api/healthz"
                    description="API health check — no auth required"
                  />
                </tbody>
              </table>
            </div>
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

          {/* CTA */}
          <div className="rounded-xl border border-border bg-card p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-foreground">Ready to start building?</p>
              <p className="text-xs text-muted-foreground mt-1">
                Generate a personal access token from Settings to authenticate your first API call.
              </p>
            </div>
            <Link
              href="/settings"
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
