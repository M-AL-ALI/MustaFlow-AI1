import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const here = resolve(import.meta.dirname);
const admin = readFileSync(resolve(here, "admin.tsx"), "utf8");
const records = readFileSync(resolve(here, "admin-records.tsx"), "utf8");
const app = readFileSync(resolve(here, "../App.tsx"), "utf8");

describe("Admin drill-ins", () => {
  it.each([
    ["Total Projects", "/admin/records/projects"],
    ["Published", "/admin/records/published-projects"],
    ["Users with Credits", "/admin/records/credit-accounts"],
    ["Transactions", "/admin/records/transactions"],
  ])("makes %s a real records link", (label, href) => {
    expect(admin).toContain(`label="${label}"`);
    expect(admin).toContain(`href="${href}"`);
  });

  it("mounts the governed record surface inside the Admin guard", () => {
    expect(app).toContain(
      'const AdminRecordsPage = builderLazy(() => import("./pages/admin-records"))',
    );
    expect(app).toContain('<Route path="/admin/records/:kind">');
    expect(app).toContain("<AdminGuard>");
  });

  it("keeps account identities masked and makes the unavailable unmask path explicit", () => {
    expect(records).toContain('masking: "account-identities-masked"');
    expect(records).toContain("never exposes raw");
    expect(records).toContain("Unmasking is not available in this phase.");
    expect(records).not.toContain("userId:");
  });

  it("gives every record a useful detail surface and keeps project entry consent-gated", () => {
    expect(records).toContain("<details");
    expect(records).toContain("Serving version");
    expect(records).toContain("Current balance");
    expect(records).toContain("Balance after");
    expect(records).toContain("Project workspace access remains consent-gated");
  });

  it("bounds project filters and list pagination", () => {
    expect(records).toContain("maxLength={120}");
    expect(records).toContain('limit: "25"');
    expect(records).toContain("Previous");
    expect(records).toContain("Next");
  });
});
