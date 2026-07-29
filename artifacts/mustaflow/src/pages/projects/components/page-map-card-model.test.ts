import { describe, expect, it } from "vitest";
import {
  pageCardStatus,
  pagePurpose,
  pageRouteFromFilePath,
  pageRouteIsNavigable,
} from "./page-map-card-model";

describe("page map card model", () => {
  it("turns common page file paths into preview routes", () => {
    expect(pageRouteFromFilePath("src/pages/index.tsx")).toBe("/");
    expect(pageRouteFromFilePath("src/pages/settings.tsx")).toBe("/settings");
    expect(pageRouteFromFilePath("about.html")).toBe("/about.html");
    expect(pageRouteFromFilePath("src/app/projects/[id]/page.tsx")).toBe("/projects/:id");
    expect(pageRouteFromFilePath("src/pages/Account.tsx", "Route: /account/profile.")).toBe(
      "/account/profile",
    );
  });

  it("only enables preview navigation for concrete built routes", () => {
    expect(pageRouteIsNavigable("/settings")).toBe(true);
    expect(pageRouteIsNavigable("/projects/:id")).toBe(false);
    expect(pageRouteIsNavigable("/settings", true)).toBe(false);
  });

  it("uses notes as purpose and exposes an honest page status", () => {
    expect(pagePurpose({ label: "Tasks", pageType: "list", notes: "Shows all active work." })).toBe(
      "Shows all active work.",
    );
    expect(
      pagePurpose({
        label: "Tasks",
        pageType: "list",
        notes: "Route: /tasks. browse active work.",
      }),
    ).toBe("Browse active work.");
    expect(pagePurpose({ label: "Tasks", pageType: "list" })).toContain("collection");
    expect(pageCardStatus({ isBuilding: true })).toBe("Updating");
    expect(pageCardStatus({ hasError: true })).toBe("Needs attention");
    expect(pageCardStatus({ planned: true })).toBe("Planned");
    expect(pageCardStatus({ isNew: true })).toBe("New");
    expect(pageCardStatus({})).toBe("Ready");
  });
});
