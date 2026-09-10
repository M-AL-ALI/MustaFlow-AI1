import { describe, expect, it } from "vitest";
import type { PageMapPlatform } from "./page-map";
import {
  PAGE_MAP_TRANSITION_FIELDS,
  pageMapTransitionSchema,
  reconcilePageMapPlatformUpdate,
  type PageMapTransition,
} from "./page-map-transition";
import { pageMapUpdateSchema, parseStoredPageMap } from "./page-map-validation";

const revision = "b".repeat(64);
function claims(): PageMapTransition {
  return {
    version: 1,
    action: { kind: "click", label: "Account link" },
    control: { kind: "link", locator: "source declaration" },
    condition: { kind: "unknown", branch: "unknown" },
    outcome: { kind: "navigate" },
    destination: { kind: "route", value: "/account" },
    evidence: [
      {
        basis: "source",
        fields: ["action", "control", "destination"],
        source: {
          filePath: "src/Home.tsx",
          contentSha256: "a".repeat(64),
          startOffset: 10,
          endOffset: 30,
        },
      },
    ],
    unknowns: ["Runtime execution and remaining conditions are not observed."],
  };
}
function platform(): PageMapPlatform {
  return {
    nodes: ["home", "account"].map((id) => ({
      id,
      label: id,
      pageType: "other",
      filePath: "src/" + id + ".tsx",
      position: { x: 0, y: 0 },
      isNew: false,
      hasError: false,
      aiGenerated: true,
      notes: "Route: /" + id,
    })),
    edges: [
      {
        id: "edge-source-1",
        source: "home",
        target: "account",
        connectionType: "nav",
        aiGenerated: true,
        transition: claims(),
      },
    ],
    unresolvedTransitions: [
      {
        id: "unresolved-1",
        source: "home",
        transition: { ...claims(), destination: { kind: "unknown" } },
      },
    ],
  };
}
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("Page Map transition contract and evidence boundary", () => {
  it("keeps a legacy graph without fabricating transition knowledge", () => {
    const legacy = platform();
    delete legacy.edges[0].transition;
    delete legacy.unresolvedTransitions;
    expect(parseStoredPageMap({ web: legacy }).web).toEqual(legacy);
  });

  it("does not erase a valid legacy edge when a stored extension is unsupported", () => {
    const raw = clone(platform()) as unknown as { edges: Array<{ transition: unknown }> };
    raw.edges[0].transition = { version: 99 };
    const parsed = parseStoredPageMap({ web: raw }).web;
    expect(parsed.edges).toHaveLength(1);
    expect(parsed.edges[0].transition).toBeUndefined();
  });

  it("rejects unsupported versions, runtime claims and malformed predicates in PUT", () => {
    const next = platform();
    const base = claims();
    for (const invalid of [
      { ...base, version: 99 },
      { ...base, evidence: [{ basis: "runtime-observed", fields: ["action"] }] },
      { ...base, condition: { kind: "predicate", branch: "true" } },
      { ...base, condition: { kind: "none", expression: "loggedIn", branch: "true" } },
    ]) {
      const input = { ...next, edges: [{ ...next.edges[0], transition: invalid }] };
      expect(
        pageMapUpdateSchema.safeParse({ expectedRevision: revision, web: input }).success,
      ).toBe(false);
    }
  });

  it("preserves omitted extensions and candidates for a matching old-client layout save", () => {
    const current = platform();
    const incoming = clone(current);
    incoming.nodes[0].position.x = 50;
    delete incoming.edges[0].transition;
    delete incoming.unresolvedTransitions;
    const result = reconcilePageMapPlatformUpdate(current, incoming);
    expect(result.edges[0].transition).toEqual(current.edges[0].transition);
    expect(result.unresolvedTransitions).toEqual(current.unresolvedTransitions);
    expect(result.nodes[0].position.x).toBe(50);
  });

  it("keeps an omitted platform unchanged", () => {
    const current = platform();
    expect(reconcilePageMapPlatformUpdate(current, undefined)).toBe(current);
  });

  it("ignores client replacement evidence on unchanged stored claims", () => {
    const current = platform();
    const incoming = clone(current);
    incoming.edges[0].transition!.evidence[0].source!.contentSha256 = "c".repeat(64);
    const result = reconcilePageMapPlatformUpdate(current, incoming);
    expect(result.edges[0].transition).toEqual(current.edges[0].transition);
  });

  it("downgrades changed claims and protects their manual ownership from extraction", () => {
    const current = platform();
    const incoming = clone(current);
    incoming.edges[0].transition!.condition = {
      kind: "predicate",
      expression: "loggedIn",
      branch: "true",
    };
    const result = reconcilePageMapPlatformUpdate(current, incoming);
    expect(result.edges[0].aiGenerated).toBe(false);
    expect(result.edges[0].transition!.evidence).toEqual([
      { basis: "manual", fields: [...PAGE_MAP_TRANSITION_FIELDS] },
    ]);
    expect(result.edges[0].transition!.condition.expression).toBe("loggedIn");
  });

  it("never accepts copied authoritative evidence for a new edge, even with identical endpoints", () => {
    const current = platform();
    const incoming = clone(current);
    incoming.edges.push({ ...clone(incoming.edges[0]), id: "edge-user-2" });
    const result = reconcilePageMapPlatformUpdate(current, incoming);
    expect(result.edges).toHaveLength(2);
    expect(result.edges[0].transition!.evidence[0].basis).toBe("source");
    expect(result.edges[1].transition!.evidence).toEqual([
      { basis: "manual", fields: [...PAGE_MAP_TRANSITION_FIELDS] },
    ]);
    expect(result.edges[1].aiGenerated).toBe(false);
  });

  it("does not carry omitted evidence across changed endpoint identity or connection type", () => {
    for (const change of ["file", "route", "type"] as const) {
      const current = platform();
      const incoming = clone(current);
      delete incoming.edges[0].transition;
      if (change === "file") incoming.nodes[0].filePath = "src/Other.tsx";
      if (change === "route") incoming.nodes[0].notes = "Route: /other";
      if (change === "type") incoming.edges[0].connectionType = "auth-gate";
      expect(reconcilePageMapPlatformUpdate(current, incoming).edges[0].transition).toBeUndefined();
    }
  });

  it("downgrades submitted evidence when the same edge ID is rebound", () => {
    const current = platform();
    const incoming = clone(current);
    incoming.edges[0].source = "account";
    incoming.edges[0].target = "home";
    expect(
      reconcilePageMapPlatformUpdate(current, incoming).edges[0].transition!.evidence[0].basis,
    ).toBe("manual");
  });

  it("does not forge evidence on new or changed unresolved candidates", () => {
    const current = platform();
    const incoming = clone(current);
    incoming.unresolvedTransitions!.push({
      ...clone(incoming.unresolvedTransitions![0]),
      id: "unresolved-user-2",
    });
    const result = reconcilePageMapPlatformUpdate(current, incoming);
    expect(result.unresolvedTransitions![0].transition.evidence[0].basis).toBe("source");
    expect(result.unresolvedTransitions![1].transition.evidence[0].basis).toBe("manual");
  });

  it("preserves omission but respects explicit unresolved-candidate deletion", () => {
    const current = platform();
    const incoming = clone(current);
    incoming.unresolvedTransitions = [];
    expect(reconcilePageMapPlatformUpdate(current, incoming).unresolvedTransitions).toEqual([]);
    incoming.unresolvedTransitions = undefined;
    incoming.nodes = incoming.nodes.filter((node) => node.id !== "home");
    incoming.edges = [];
    expect(reconcilePageMapPlatformUpdate(current, incoming).unresolvedTransitions).toEqual([]);
  });

  it("accepts separate transitions sharing endpoints but rejects duplicate identities", () => {
    const next = platform();
    next.edges.push({ ...clone(next.edges[0]), id: "edge-branch-2" });
    expect(pageMapUpdateSchema.safeParse({ expectedRevision: revision, web: next }).success).toBe(
      true,
    );
    next.edges[1].id = next.edges[0].id;
    expect(pageMapUpdateSchema.safeParse({ expectedRevision: revision, web: next }).success).toBe(
      false,
    );
  });

  it("bounds claims and rejects executable or credential-bearing external destinations", () => {
    const base = claims();
    expect(
      pageMapTransitionSchema.safeParse({
        ...base,
        unknowns: Array.from({ length: 17 }, () => "unknown"),
      }).success,
    ).toBe(false);
    for (const value of ["javascript:alert(1)", "https://user:secret@example.test/"]) {
      expect(
        pageMapTransitionSchema.safeParse({
          ...base,
          destination: { kind: "external", value },
        }).success,
      ).toBe(false);
    }
    expect(
      pageMapTransitionSchema.safeParse({
        ...base,
        condition: { kind: "unknown", branch: "unknown" },
        evidence: [],
      }).success,
    ).toBe(true);
  });
});
