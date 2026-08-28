import { Wrench } from "lucide-react";
import { AdminBreadcrumbs } from "@/components/admin/admin-breadcrumbs";
import { AdminDeveloperTools } from "@/pages/admin";

export default function AdminDeveloperToolsPage() {
  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">
      <AdminBreadcrumbs
        items={[
          { label: "Projects", href: "/projects" },
          { label: "Admin Page", href: "/admin" },
          { label: "Developer tools" },
        ]}
      />

      <header className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <Wrench className="h-6 w-6 text-primary mt-0.5" />
          <div>
            <h1 className="text-2xl font-bold">Developer tools</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Owner-only diagnostics, evaluations, skill controls, and architecture telemetry. These
              tools are intentionally separate from day-to-day operations.
            </p>
          </div>
        </div>
        <a
          href="/admin"
          className="shrink-0 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted"
        >
          Back to Admin Page
        </a>
      </header>

      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
        These controls are for platform diagnosis and agent maintenance. Their data refreshes on
        page load or through each panel&apos;s own refresh control.
      </div>

      <AdminDeveloperTools />
    </div>
  );
}
