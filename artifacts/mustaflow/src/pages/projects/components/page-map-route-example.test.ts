import { describe, expect, it } from "vitest";
import { resolvePageRouteExample } from "./page-map-route-example";
import { pagePreviewUrl } from "./page-map-card-model";

describe("Page Map concrete route examples", () => {
  it("retains parameters when encoded Unicode values exceed the route budget", () => {
    const long = "\u6f22".repeat(256);
    expect(resolvePageRouteExample("/notes/:id", { id: long })).toEqual({
      kind: "too-long",
      parameters: ["id"],
    });
    expect(resolvePageRouteExample("/notes/:id", { id: "42" })).toEqual({
      kind: "ready",
      parameters: ["id"],
      route: "/notes/42",
    });
  });
  it("distinguishes the exact 2048-character boundary from a correctable overflow", () => {
    const template = "/" + "a".repeat(2043) + "/:id";
    const exact = resolvePageRouteExample(template, { id: "abc" });
    expect(exact.kind).toBe("ready");
    if (exact.kind !== "ready") throw new Error("Expected a boundary-length route");
    expect(exact.route).toHaveLength(2048);
    expect(resolvePageRouteExample(template, { id: "abcd" })).toEqual({
      kind: "too-long",
      parameters: ["id"],
    });
  });
  it.each(["/", "/notes", "/caf%C3%A9", "/\u062d\u0633\u0627\u0628"])(
    "keeps a concrete route unchanged: %s",
    (route) => {
      expect(resolvePageRouteExample(route)).toEqual({ kind: "ready", parameters: [], route });
    },
  );
  it("requires every parameter without inventing a record", () => {
    expect(resolvePageRouteExample("/teams/:team/notes/:id", { team: "alpha" })).toEqual({
      kind: "needs-values",
      parameters: ["team", "id"],
    });
  });
  it("resolves multiple and repeated parameters deterministically", () => {
    expect(
      resolvePageRouteExample("/teams/:team/notes/:id/related/:id", {
        team: "alpha",
        id: "note-42",
      }),
    ).toEqual({
      kind: "ready",
      parameters: ["team", "id"],
      route: "/teams/alpha/notes/note-42/related/note-42",
    });
  });
  it("encodes Unicode IDs once and retains the existing project preview boundary", () => {
    const result = resolvePageRouteExample("/notes/:id", {
      id: "\u0645\u0644\u0627\u062d\u0638\u0629",
    });
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("Expected a concrete route");
    expect(result.route).toBe(
      "/notes/" + encodeURIComponent("\u0645\u0644\u0627\u062d\u0638\u0629"),
    );
    expect(pagePreviewUrl(901, result.route)).toBe("/api/projects/901/preview" + result.route);
  });
  it.each([
    "",
    "notes/:id",
    "//outside.test/:id",
    "/../:id",
    "/%252e%252e/:id",
    "/notes/:id?",
    "/notes/*",
    "/notes/[...id]",
    "/notes/prefix-:id",
    "/notes/:id#x",
    "https://outside.test/:id",
  ])("leaves unsupported templates unresolved: %s", (route) => {
    expect(resolvePageRouteExample(route, { id: "42" }).kind).toBe("unsupported");
  });
  it.each([
    "..",
    ".",
    "a/b",
    "a\\b",
    "https://outside.test",
    "a?x=1",
    "a#x",
    "%2e%2e",
    "%252f",
    "a b",
    "a\n",
    "a\u007f",
    "[id]",
    "*",
    "\ud800",
    "a".repeat(257),
  ])("refuses a non-segment value: %s", (id) => {
    expect(resolvePageRouteExample("/notes/:id", { id })).toMatchObject({
      kind: "invalid-value",
      parameter: "id",
    });
  });
  it("does not read inherited parameter values", () => {
    const values = Object.create({ id: "inherited" }) as Record<string, string>;
    expect(resolvePageRouteExample("/notes/:id", values).kind).toBe("needs-values");
    expect(resolvePageRouteExample("/notes/:constructor", {}).kind).toBe("needs-values");
  });
  it("supports own properties without changing the object prototype", () => {
    const values = JSON.parse('{"__proto__":"record-1","constructor":"record-2"}') as Record<
      string,
      string
    >;
    expect(resolvePageRouteExample("/notes/:__proto__/:constructor", values)).toMatchObject({
      kind: "ready",
      route: "/notes/record-1/record-2",
    });
    expect(Object.getPrototypeOf(values)).toBe(Object.prototype);
  });
  it("bounds both template and resulting route lengths", () => {
    expect(resolvePageRouteExample("/" + "a".repeat(2048)).kind).toBe("unsupported");
    expect(
      resolvePageRouteExample("/" + "a".repeat(2040) + "/:id", { id: "long-record" }).kind,
    ).toBe("too-long");
  });
});
