import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  read: vi.fn(),
  readFiles: vi.fn(),
  write: vi.fn(),
}));
vi.mock("./page-map-repository", () => ({ pageMapRepository: mocks }));
vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: { chat: { completions: { create: mocks.create } } },
}));
vi.mock("./logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));

import {
  EMPTY_PAGE_MAP,
  extractPageMap,
  extractPageMapForFiles,
  mergeWithExisting,
  type PageMapPlatform,
} from "./page-map";
import { manualPageMapTransition } from "./page-map-transition";
import { assertPageMapPlatform } from "./page-map-validation";

const files = (body: string) => [
  {
    path: "index.html",
    mimeType: "text/html",
    content: `<!doctype html><html><body>${body}</body></html>`,
  },
  {
    path: "about.html",
    mimeType: "text/html",
    content: "<!doctype html><html><body>About</body></html>",
  },
];
const graph = (body: string, existing?: PageMapPlatform) =>
  extractPageMapForFiles(files(body), "web", existing);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.create.mockRejectedValue(new Error("AI unavailable in this test"));
});

describe("fresh Page Map source integration", () => {
  it("preserves unresolved declarations and exact source evidence when AI is unavailable", async () => {
    const result = await graph('<a href="missing.html">Continue</a>');
    expect(result.edges).toEqual([]);
    expect(result.unresolvedTransitions).toHaveLength(1);
    const candidate = result.unresolvedTransitions![0];
    expect(candidate.source).toBe(result.nodes.find((node) => node.filePath === "index.html")!.id);
    expect(
      candidate.transition.evidence.some(
        (item) => item.basis === "source" && item.source?.filePath === "index.html",
      ),
    ).toBe(true);
    expect(() => assertPageMapPlatform(result)).not.toThrow();
  });

  it("keeps parallel source controls over a same-pair AI inference and remaps candidate pages", async () => {
    const sourceGraph = await graph(
      '<a href="about.html">About us</a><a href="about.html">Learn more</a><a href="missing.html">Missing</a>',
    );
    const homeId = sourceGraph.nodes.find((node) => node.filePath === "index.html")!.id;
    const aboutId = sourceGraph.nodes.find((node) => node.filePath === "about.html")!.id;
    mocks.create.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              nodes: [
                {
                  id: "enriched-home",
                  label: "Home",
                  filePath: "index.html",
                  pageType: "landing",
                  notes: "Home",
                },
                {
                  id: "enriched-about",
                  label: "About",
                  filePath: "about.html",
                  pageType: "other",
                  notes: "About",
                },
              ],
              edges: [
                {
                  id: "inferred-pair",
                  source: "enriched-home",
                  target: "enriched-about",
                  connectionType: "auth-gate",
                },
              ],
            }),
          },
        },
      ],
    });
    const result = await graph(
      '<a href="about.html">About us</a><a href="about.html">Learn more</a><a href="missing.html">Missing</a>',
    );
    expect(result.edges).toHaveLength(2);
    expect(new Set(result.edges.map((edge) => edge.id)).size).toBe(2);
    for (const edge of result.edges) {
      expect(edge).toMatchObject({
        source: homeId,
        target: aboutId,
        connectionType: "nav",
      });
      expect(edge.transition?.evidence.some((item) => item.basis === "source")).toBe(true);
    }
    expect(result.unresolvedTransitions).toHaveLength(1);
    expect(result.nodes.find((node) => node.id === homeId)?.label).toBe("Home");
    expect(result.unresolvedTransitions![0].source).toBe(homeId);
    expect(
      result.unresolvedTransitions![0].transition.evidence.some((item) => item.basis === "source"),
    ).toBe(true);
  });

  it("preserves manual candidate and edge edits through successful AI identity changes", async () => {
    const body = '<a href="missing.html">Continue</a><a href="about.html">About</a>';
    const first = await graph(body);
    const home = first.nodes.find((node) => node.filePath === "index.html")!;
    const about = first.nodes.find((node) => node.filePath === "about.html")!;
    const candidate = first.unresolvedTransitions![0];
    const annotated = {
      ...candidate,
      transition: manualPageMapTransition({
        ...candidate.transition,
        action: { kind: "click" as const, label: "User-authored intent" },
      }),
    };
    const manualEdge = {
      ...first.edges[0],
      aiGenerated: false,
      transition: manualPageMapTransition(first.edges[0].transition!),
    };
    const edited = { ...first, edges: [manualEdge], unresolvedTransitions: [annotated] };
    const original = JSON.stringify(edited);
    const enrichment = (prefix: string) => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              nodes: [
                {
                  id: `${prefix}-home`,
                  filePath: "index.html",
                  label: "Enriched home",
                  pageType: "landing",
                  notes: "Updated description",
                },
                {
                  id: `${prefix}-about`,
                  filePath: "about.html",
                  label: "Enriched about",
                  pageType: "other",
                  notes: "About",
                },
              ],
              edges: [
                {
                  id: `${prefix}-return`,
                  source: `${prefix}-about`,
                  target: `${prefix}-home`,
                  connectionType: "nav",
                },
              ],
            }),
          },
        },
      ],
    });
    let current: PageMapPlatform = edited;
    for (const prefix of ["first-ai", "second-ai"]) {
      mocks.create.mockResolvedValue(enrichment(prefix));
      current = await graph(body, current);
      expect(current.nodes.find((node) => node.id === home.id)).toMatchObject({
        label: "Enriched home",
        filePath: "index.html",
      });
      expect(current.nodes.find((node) => node.id === home.id)?.notes).toBe(home.notes);
      expect(current.unresolvedTransitions).toEqual([annotated]);
      expect(current.edges.find((edge) => edge.id === manualEdge.id)).toEqual(manualEdge);
      expect(current.edges.find((edge) => edge.id === `${prefix}-return`)).toMatchObject({
        source: about.id,
        target: home.id,
      });
      expect(JSON.stringify(edited)).toBe(original);
    }
  });

  it("replaces obsolete automatic candidates after file changes instead of accumulating them", async () => {
    const first = await graph('<a href="missing.html">Old label</a>');
    const original = JSON.stringify(first);
    const next = await graph('<a href="other.html">New label</a>', first);
    expect(next.unresolvedTransitions).toHaveLength(1);
    expect(next.unresolvedTransitions![0].id).not.toBe(first.unresolvedTransitions![0].id);
    expect(JSON.stringify(first)).toBe(original);
    expect((await graph("No links", next)).unresolvedTransitions).toEqual([]);
  });

  it("preserves user-annotated candidates and gives their same identity precedence", async () => {
    const first = await graph('<a href="missing.html">Continue</a>');
    const candidate = first.unresolvedTransitions![0];
    const annotated = {
      ...candidate,
      transition: manualPageMapTransition({
        ...candidate.transition,
        action: { kind: "click" as const, label: "User intent" },
      }),
    };
    const edited = { ...first, unresolvedTransitions: [annotated] };
    const repeated = await graph('<a href="missing.html">Continue</a>', edited);
    expect(repeated.unresolvedTransitions).toEqual([annotated]);
    expect((await graph("No links", edited)).unresolvedTransitions).toEqual([annotated]);
  });

  it("does not preserve removed source output by accidentally promoting its rebound evidence to manual", async () => {
    const first = await graph('<a href="missing.html">Continue</a>');
    const changed = first.nodes.map((node) => ({ ...node, filePath: `renamed/${node.filePath}` }));
    expect(mergeWithExisting(changed, [], first, []).unresolvedTransitions).toEqual([]);
  });

  it("keeps source-free declarations without inventing a page", async () => {
    const first = await graph('<a href="missing.html">Continue</a>');
    const { source: _source, ...unattributed } = first.unresolvedTransitions![0];
    const result = mergeWithExisting(first.nodes, [], { nodes: first.nodes, edges: [] }, [
      unattributed,
    ]);
    expect(result.unresolvedTransitions).toEqual([unattributed]);
    expect(result.unresolvedTransitions![0].source).toBeUndefined();
  });

  it("fails closed rather than silently dropping manual work when merged capacity is exceeded", async () => {
    const first = await graph('<a href="missing.html">Continue</a>');
    const base = first.unresolvedTransitions![0];
    const manual = Array.from({ length: 1000 }, (_, index) => ({
      ...base,
      id: `manual-${index}`,
      transition: manualPageMapTransition(base.transition),
    }));
    const existing = { ...first, unresolvedTransitions: manual };
    expect(() => mergeWithExisting(first.nodes, [], existing, [base])).toThrow(/limits|identities/);
    expect(existing.unresolvedTransitions).toHaveLength(1000);
  });

  it("persists the discovered candidate through the repository CAS without changing other platforms", async () => {
    const prior = { ...EMPTY_PAGE_MAP, ios: { nodes: [], edges: [], unresolvedTransitions: [] } };
    mocks.read.mockResolvedValue({ pageMapData: prior });
    mocks.readFiles.mockResolvedValue({
      files: files('<a href="missing.html">Continue</a>'),
      revision: "test-source-revision",
    });
    mocks.write.mockResolvedValue(true);
    await extractPageMap(60);
    expect(mocks.write).toHaveBeenCalledTimes(1);
    const [id, saved, expected, revision] = mocks.write.mock.calls[0];
    expect(id).toBe(60);
    expect(saved.web.unresolvedTransitions).toHaveLength(1);
    expect(saved.ios).toEqual(prior.ios);
    expect(saved.android).toEqual(prior.android);
    expect(expected).toBe(prior);
    expect(revision).toBe("test-source-revision");
  });
});
