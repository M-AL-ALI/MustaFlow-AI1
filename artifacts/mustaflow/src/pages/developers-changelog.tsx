import { Link } from "wouter";
import { ArrowRight, Code2, History, Plus, AlertTriangle, Pencil, ChevronLeft } from "lucide-react";

interface ChangeEntry {
  type: "added" | "changed" | "deprecated" | "fixed";
  text: string;
}

interface ChangelogEntry {
  date: string;
  version: string;
  summary: string;
  changes: ChangeEntry[];
}

const CHANGELOG: ChangelogEntry[] = [
  {
    date: "May 2026",
    version: "v1.7",
    summary: "Preview environments, secret scoping, and publish gates",
    changes: [
      {
        type: "added",
        text: "POST /api/projects/:id/preview-env/start — launch an isolated test container before publishing",
      },
      {
        type: "added",
        text: "GET /api/projects/:id/preview-env/status — poll container health and readiness",
      },
      {
        type: "added",
        text: "POST /api/projects/:id/preview-env/approve — mark a snapshot as tested and ready to promote",
      },
      {
        type: "added",
        text: "project_secrets now accept a minRole field (viewer|member|admin|owner) to scope secret visibility per collaborator role",
      },
      {
        type: "added",
        text: "Full-stack projects now require an approved tested snapshot before POST /publish is accepted",
      },
      {
        type: "changed",
        text: "POST /publish returns 409 when an unapproved snapshot is present, with a previewEnvUrl hint in the error body",
      },
      {
        type: "fixed",
        text: "GET /projects/:id/files no longer returns stale file paths after a rollback",
      },
    ],
  },
  {
    date: "April 2026",
    version: "v1.6",
    summary: "Agentic provisioning and Neon database auto-creation",
    changes: [
      {
        type: "added",
        text: "Projects created with builder_mode: 'agentic' now auto-provision a Fly.io container and a Neon Postgres database",
      },
      {
        type: "added",
        text: "GET /api/projects/:id now includes provisioningStatus (provisioning | ready | hibernated | error) and neonProjectId",
      },
      {
        type: "added",
        text: "POST /api/projects/:id/provision/retry — re-run provisioning after a transient failure",
      },
      {
        type: "changed",
        text: "Static projects retain builder_mode: 'static-legacy' and are unaffected by provisioning fields",
      },
    ],
  },
  {
    date: "March 2026",
    version: "v1.5",
    summary: "GDPR data export, org audit log, and variant builds",
    changes: [
      {
        type: "added",
        text: "GET /api/me/export — download a ZIP of all your projects, files, AI chat history, and Knowledge Vault entries (secret values excluded)",
      },
      {
        type: "added",
        text: "DELETE /api/me — soft-delete all user-owned projects (Clerk account deletion handled separately)",
      },
      {
        type: "added",
        text: "GET /api/orgs/:orgId/activity — paginated org-wide activity log; add ?format=csv to export (admin/owner only)",
      },
      {
        type: "added",
        text: "POST /api/projects/:id/canvas/variants — generate 2–8 parallel UI variants from a single prompt in one call",
      },
      {
        type: "changed",
        text: "SecretEntry schema extended with minRole and exposureType fields",
      },
    ],
  },
  {
    date: "February 2026",
    version: "v1.4",
    summary: "Share links, Knowledge Vault API, and mobile build support",
    changes: [
      {
        type: "added",
        text: "POST /api/projects/:id/share — create a public share link with optional expiry and password",
      },
      {
        type: "added",
        text: "GET /api/projects/:id/knowledge — list Knowledge Vault entries the AI has learned from this project",
      },
      {
        type: "added",
        text: "POST /api/projects/:id/builds now accepts stack: 'mobile' to trigger an Expo/React Native build pipeline",
      },
      {
        type: "added",
        text: "deployment_logs now include build_id, platform, download_url, and testflight_url for mobile builds",
      },
      {
        type: "fixed",
        text: "POST /api/projects/:id/builds correctly returns 402 when credits are insufficient rather than a silent 500",
      },
    ],
  },
  {
    date: "January 2026",
    version: "v1.3",
    summary: "Custom domains, version rollback, and publishing webhooks",
    changes: [
      {
        type: "added",
        text: "PATCH /api/projects/:id/settings accepts customDomain to configure a custom hostname for published sites",
      },
      {
        type: "added",
        text: "POST /api/projects/:id/versions/:versionId/rollback — restore any previous snapshot as the active build",
      },
      {
        type: "added",
        text: "GET /api/projects/:id/versions — list all build snapshots with file counts and task reports",
      },
      {
        type: "deprecated",
        text: "GET /api/projects/:id/history is deprecated in favour of /versions and will be removed in v2",
      },
    ],
  },
  {
    date: "November 2025",
    version: "v1.2",
    summary: "Organisations, collaborators, and threaded comments",
    changes: [
      {
        type: "added",
        text: "GET/POST /api/orgs — list and create team organisations",
      },
      {
        type: "added",
        text: "POST /api/orgs/:orgId/members — invite collaborators with owner|admin|editor|viewer roles",
      },
      {
        type: "added",
        text: "GET/POST /api/projects/:id/comments — read and post threaded comments on a project",
      },
      {
        type: "changed",
        text: "All project list and detail responses now include orgId when the project belongs to a team org",
      },
    ],
  },
  {
    date: "September 2025",
    version: "v1.1",
    summary: "Project secrets, file downloads, and publish endpoint",
    changes: [
      {
        type: "added",
        text: "GET/POST/DELETE /api/projects/:id/secrets — manage encrypted environment variables for generated apps",
      },
      {
        type: "added",
        text: "GET /api/projects/:id/files/:path — download any generated file by its path",
      },
      {
        type: "added",
        text: "POST /api/projects/:id/publish — freeze the latest build into a production snapshot",
      },
      {
        type: "fixed",
        text: "GET /api/projects/:id/files now correctly paginates results for projects with more than 200 files",
      },
    ],
  },
  {
    date: "July 2025",
    version: "v1.0",
    summary: "Initial public release",
    changes: [
      {
        type: "added",
        text: "GET/POST /api/v1/projects — list and create projects",
      },
      {
        type: "added",
        text: "GET /api/v1/projects/:id — get project details",
      },
      {
        type: "added",
        text: "POST /api/v1/projects/:id/builds — trigger an AI build from a natural-language prompt",
      },
      {
        type: "added",
        text: "GET /api/v1/projects/:id/builds and /builds/:buildId — list and poll builds",
      },
      {
        type: "added",
        text: "GET /api/v1/projects/:id/files — list generated output files",
      },
      { type: "added", text: "GET /api/healthz — unauthenticated health check" },
    ],
  },
];

const TYPE_CONFIG = {
  added: {
    label: "Added",
    icon: Plus,
    className: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    dot: "bg-emerald-400",
  },
  changed: {
    label: "Changed",
    icon: Pencil,
    className: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    dot: "bg-blue-400",
  },
  deprecated: {
    label: "Deprecated",
    icon: AlertTriangle,
    className: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    dot: "bg-amber-400",
  },
  fixed: {
    label: "Fixed",
    icon: History,
    className: "bg-violet-500/10 text-violet-400 border-violet-500/20",
    dot: "bg-violet-400",
  },
} as const;

function ChangeTag({ type }: { type: ChangeEntry["type"] }) {
  const cfg = TYPE_CONFIG[type];
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold border shrink-0 ${cfg.className}`}
    >
      {cfg.label}
    </span>
  );
}

export default function DevelopersChangelogPage() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-12 space-y-10">
          {/* Page header */}
          <div className="space-y-4">
            <Link
              href="/developers"
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Developer Portal
            </Link>
            <div className="flex items-center gap-3">
              <History className="h-7 w-7 text-primary" />
              <h1 className="text-3xl font-bold">API Changelog</h1>
            </div>
            <p className="text-muted-foreground max-w-xl">
              A full history of additions, changes, and deprecations to the MustaFlow AI REST API.
              Non-breaking additions are shipped within the same version; breaking changes bump the
              version number.
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              {(["added", "changed", "deprecated", "fixed"] as const).map((t) => (
                <ChangeTag key={t} type={t} />
              ))}
            </div>
          </div>

          {/* Timeline */}
          <div className="relative">
            {/* Vertical line */}
            <div className="absolute left-[7px] top-2 bottom-2 w-px bg-border" aria-hidden />

            <div className="space-y-10">
              {CHANGELOG.map((entry) => (
                <div key={entry.version} className="relative pl-8">
                  {/* Timeline dot */}
                  <div className="absolute left-0 top-1.5 h-3.5 w-3.5 rounded-full border-2 border-primary bg-background" />

                  {/* Entry card */}
                  <div className="rounded-xl border border-border bg-card overflow-hidden">
                    <div className="flex items-center justify-between gap-4 px-5 py-4 border-b border-border bg-muted/30">
                      <div className="flex items-center gap-3">
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-primary/10 text-primary border border-primary/20">
                          {entry.version}
                        </span>
                        <span className="text-sm font-semibold text-foreground">
                          {entry.summary}
                        </span>
                      </div>
                      <span className="text-xs text-muted-foreground shrink-0">{entry.date}</span>
                    </div>
                    <ul className="divide-y divide-border">
                      {entry.changes.map((change, i) => (
                        <li key={i} className="flex items-start gap-3 px-5 py-3">
                          <ChangeTag type={change.type} />
                          <span className="text-xs text-muted-foreground leading-relaxed pt-0.5">
                            {change.text}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Footer CTA */}
          <div className="rounded-xl border border-border bg-card p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-foreground">Questions about a change?</p>
              <p className="text-xs text-muted-foreground mt-1">
                Browse the full OpenAPI spec or open a support ticket for migration help.
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <a
                href="/openapi.yaml"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 px-4 py-2 rounded-lg border border-border bg-background text-sm font-medium hover:bg-muted transition-colors"
              >
                <Code2 className="h-3.5 w-3.5" />
                OpenAPI spec
              </a>
              <Link
                href="/help"
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
              >
                Help center
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          </div>
    </div>
  );
}
