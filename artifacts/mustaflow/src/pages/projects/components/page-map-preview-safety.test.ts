import { describe, expect, it } from "vitest";
import {
  pagePreviewUrl,
  pageRedesignPrompt,
  pageRouteFromFilePath,
  pageRouteIsNavigable,
  webContainerPageUrl,
} from "./page-map-card-model";
describe("Project-local Page Map previews", () => {
  it.each([
    "/index.html",
    "/Account",
    "/exports",
    "/caf\u00e9",
    "/\u062d\u0633\u0627\u0628",
    "/caf%C3%A9",
  ])("accepts a valid app route: %s", (route) => {
    expect(pageRouteIsNavigable(route)).toBe(true);
    expect(pagePreviewUrl(901, route)).toBe("/api/projects/901/preview" + route);
  });
  it("uses the app route instead of a React source file", () => {
    expect(
      pagePreviewUrl(
        901,
        pageRouteFromFilePath("src/pages/Account.tsx", "Route: /account/profile"),
      ),
    ).toBe("/api/projects/901/preview/account/profile");
    expect(pagePreviewUrl(901, "/")).toBe("/api/projects/901/preview/index.html");
  });
  it.each([
    "//outside.test/page",
    "/../ora",
    "/%2e%2e/ora",
    "/%252e%252e/ora",
    "/settings\\\\..\\\\ora",
    "/users/:id",
    "/users/[id]",
    "/page?redirect=x",
    "/page#section",
    "https://outside.test",
  ])("refuses an unsafe or unresolved route: %s", (route) => {
    expect(pageRouteIsNavigable(route)).toBe(false);
    expect(pagePreviewUrl(901, route)).toBeNull();
  });
  it("requires a real project identity", () => {
    expect(pagePreviewUrl(-1, "/")).toBeNull();
    expect(pagePreviewUrl(NaN, "/")).toBeNull();
  });
});

describe("Page Map WebContainer navigation and composer targets", () => {
  it("keeps the selected route and runtime origin, including toolbar query and hash", () => {
    expect(webContainerPageUrl("https://runtime.example/", "/account/profile")).toBe(
      "https://runtime.example/account/profile",
    );
    expect(webContainerPageUrl("https://runtime.example/old", "/settings?tab=layout#colors")).toBe(
      "https://runtime.example/settings?tab=layout#colors",
    );
    expect(webContainerPageUrl("https://runtime.example/", "/")).toBe("https://runtime.example/");
  });

  it.each(["//outside.test", "/../escape", "/%252e%252e/escape", "/users/:id", "/users/[id]"])(
    "does not turn an unsafe or unresolved route into a WebContainer URL: %s",
    (route) => {
      expect(webContainerPageUrl("https://runtime.example/", route)).toBeNull();
    },
  );

  it.each([
    "javascript:alert(1)",
    "data:text/html,hello",
    "https://user:secret@runtime.example/",
    "not a URL",
  ])("rejects an unusable runtime base: %s", (base) => {
    expect(webContainerPageUrl(base, "/account")).toBeNull();
  });

  it("keeps same-label pages distinct in the prepared request", () => {
    const node = {
      id: "admin-account",
      label: "Account",
      pageType: "settings",
      filePath: "src/admin/Account.tsx",
      notes: "Route: /admin/account",
    };
    const draft = pageRedesignPrompt(901, node, "a".repeat(64));
    expect(draft).toContain('"nodeId": "admin-account"');
    expect(draft).toContain('"filePath": "src/admin/Account.tsx"');
    expect(draft).toContain('"route": "/admin/account"');
    expect(draft).toContain(`"mapRevision": "${"a".repeat(64)}"`);
    expect(draft).toContain("Requested changes (describe before sending):");
  });

  it("does not invent a concrete preview route for a planned page", () => {
    const draft = pageRedesignPrompt(
      901,
      {
        id: "planned-page",
        label: "Reports",
        pageType: "other",
        filePath: "",
        planned: true,
      },
      null,
    );
    expect(draft).toContain('"filePath": null');
    expect(draft).toContain('"route": null');
    expect(draft).toContain('"planned": true');
  });
});

describe("Page Map control-character boundaries", () => {
  it.each(Array.from({ length: 33 }, (_, code) => code))(
    "rejects raw and encoded control/space code %i without narrowing Unicode routes",
    (code) => {
      const character = String.fromCharCode(code);
      expect(pageRouteIsNavigable("/a" + character + "b")).toBe(false);
      expect(pageRouteIsNavigable("/a%" + code.toString(16).padStart(2, "0") + "b")).toBe(false);
    },
  );
  it.each([...Array.from({ length: 32 }, (_, code) => code), 127])(
    "rejects toolbar controls even in query/hash: %i",
    (code) => {
      expect(
        webContainerPageUrl("https://runtime.example/", "/account?x=" + String.fromCharCode(code)),
      ).toBeNull();
      expect(
        webContainerPageUrl("https://runtime.example/", "/account#x" + String.fromCharCode(code)),
      ).toBeNull();
    },
  );
});
