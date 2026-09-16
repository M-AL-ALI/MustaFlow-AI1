import { describe, expect, it } from "vitest";
import {
  pageCardStatus,
  pagePurpose,
  pageRedesignPrompt,
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

  it.each([
    "Route: /",
    "Route: / Source-declared page. Navigation has not been runtime verified.",
    "Route: /\nSource-declared page.",
    "Route: /. Source-declared page.",
    "route:/",
    "Route: /, source-declared page.",
    "Route: /; source-declared page.",
  ])("preserves an explicit root route instead of inferring /home from %s", (notes) => {
    const route = pageRouteFromFilePath("src/pages/home.tsx", notes);
    expect(route).toBe("/");
    expect(pageRouteIsNavigable(route)).toBe(true);
    expect(pageRouteIsNavigable(route, true)).toBe(false);
  });

  it("removes the root annotation without hiding the source-only qualification", () => {
    expect(
      pagePurpose({
        label: "Home",
        pageType: "landing",
        notes: "Route: / Source-declared page. Navigation has not been runtime verified.",
      }),
    ).toBe("Source-declared page. Navigation has not been runtime verified.");
    expect(pagePurpose({ label: "Home", pageType: "landing", notes: "Route: /" })).toBe(
      "Introduces the app and guides people to the next step.",
    );
  });

  it("uses the same declared root for the editable redesign request", () => {
    const prompt = pageRedesignPrompt(
      61,
      {
        id: "home",
        label: "Home",
        pageType: "landing",
        filePath: "src/pages/home.tsx",
        notes: "Route: / Source-declared page.",
      },
      "map-revision",
    );
    expect(prompt).toContain('"route": "/"');
    expect(prompt).toContain("Map arrows are not verified runtime behavior.");
  });

  it.each(["//outside.invalid/", "/notes/:id", "/%2e%2e/private", "/notes#details"])(
    "does not turn a non-navigable annotation into an enabled card: %s",
    (declaredRoute) => {
      const route = pageRouteFromFilePath("src/pages/home.tsx", `Route: ${declaredRoute}`);
      expect(pageRouteIsNavigable(route)).toBe(false);
    },
  );

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
    expect(pageCardStatus({})).toBe("Page built");
  });
});
