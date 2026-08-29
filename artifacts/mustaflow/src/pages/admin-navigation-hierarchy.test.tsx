import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(process.cwd(), "src");
const adminSource = readFileSync(resolve(sourceRoot, "pages/admin.tsx"), "utf8");
const supportSource = readFileSync(resolve(sourceRoot, "pages/support-inbox.tsx"), "utf8");
const breadcrumbsSource = readFileSync(
  resolve(sourceRoot, "components/admin/admin-breadcrumbs.tsx"),
  "utf8",
);
const appSource = readFileSync(resolve(sourceRoot, "App.tsx"), "utf8");

describe("Admin navigation and operational hierarchy", () => {
  it("keeps every Admin route inside a shared, accessible breadcrumb contract", () => {
    expect(appSource).toContain('path="/admin"');
    expect(appSource).toContain('path="/admin/support"');
    expect(adminSource).toContain("<AdminBreadcrumbs");
    expect(adminSource).toContain('{ label: "Projects", href: "/projects" }');
    expect(supportSource).toContain("<AdminBreadcrumbs");
    expect(supportSource).toContain('{ label: "Admin Page", href: "/admin" }');
    expect(breadcrumbsSource).toContain('aria-label="Admin breadcrumbs"');
    expect(breadcrumbsSource).toContain('aria-current={current ? "page" : undefined}');
  });

  it("keeps blocking and degraded operations ahead of informational and exile panels", () => {
    const readiness = adminSource.indexOf('data-admin-priority="blocking"');
    const errors = adminSource.indexOf("<ProdErrorsTile");
    const jobs = adminSource.indexOf("<JobQueueTile");
    const informationalStats = adminSource.indexOf('className="grid grid-cols-2 md:grid-cols-4');
    const developerTools = adminSource.indexOf('href="/admin/developer-tools"');

    expect(readiness).toBeGreaterThan(0);
    expect(errors).toBeGreaterThan(readiness);
    expect(jobs).toBeGreaterThan(errors);
    expect(informationalStats).toBeGreaterThan(jobs);
    expect(developerTools).toBeGreaterThan(informationalStats);
  });

  it("never presents failed operational reads as healthy or empty", () => {
    expect(adminSource).toContain("Launch readiness could not be loaded");
    expect(adminSource).toContain("Treat launch status as unknown");
    expect(adminSource).toContain("Production error history could not be loaded");
    expect(adminSource).toContain("Loading production error history");
    expect(adminSource).toContain("The job queue could not be refreshed");
    expect(adminSource).toContain("setLoadError(true)");
    expect(adminSource).toContain('statsQuery.isError ? "Unavailable"');
  });

  it("distinguishes launch-blocking failures from advisory failures", () => {
    expect(adminSource).toContain("readiness.blockingFailCount} blocking fail");
    expect(adminSource).toContain(
      "readiness.failed - readiness.blockingFailCount} non-blocking fail",
    );
    expect(adminSource).toContain('!check.blocking && check.status === "fail"');
    expect(adminSource).toContain("non-blocking");
    expect(adminSource).not.toContain(
      '<span className="text-destructive">{readiness.failed} fail</span>',
    );
  });

  it("gives a selected ticket contextual exits without browser history", () => {
    expect(supportSource).toContain("Back to Admin Page");
    expect(supportSource).toContain('href="/admin"');
    expect(supportSource).toContain("href={`/projects/${ticket.projectId}`}");
    expect(supportSource).toContain("Open reporting project");
    expect(supportSource).toContain("No project linked to this ticket");
  });
});
