import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { BuilderFile } from "./builder";
import { discoverSourcePageMap, stabilizeSourcePageMap } from "./page-map-source";
import { pageMapTransitionSchema, pageMapUnresolvedTransitionSchema } from "./page-map-transition";
import { assertPageMapPlatform } from "./page-map-validation";

const file = (path: string, content: string): BuilderFile => ({
  path,
  content,
  mimeType: path.endsWith(".html") ? "text/html" : "text/plain",
});
const reactFiles = (home: string): BuilderFile[] => [
  file(
    "src/App.tsx",
    [
      'import { Route } from "react-router-dom";',
      'import Home from "./Home"; import Done from "./Done";',
      'export const App = () => <><Route path="/" element={<Home/>}/><Route path="/done" element={<Done/>}/></>;',
    ].join("\n"),
  ),
  file("src/Home.tsx", home),
  file("src/Done.tsx", "export default function Done(){ return <h1>Done</h1>; }"),
];
const records = (result: ReturnType<typeof discoverSourcePageMap>) => [
  ...result.edges
    .filter((edge) => edge.transition)
    .map((edge) => ({
      id: edge.id,
      source: edge.source,
      transition: edge.transition!,
    })),
  ...(result.unresolvedTransitions ?? []),
];
const assertEvidence = (
  inputs: BuilderFile[],
  result: ReturnType<typeof discoverSourcePageMap>,
) => {
  for (const record of records(result)) {
    expect(pageMapUnresolvedTransitionSchema.safeParse(record).success).toBe(true);
    expect(pageMapTransitionSchema.safeParse(record.transition).success).toBe(true);
    expect(new Set(record.transition.evidence.flatMap((item) => item.fields))).toEqual(
      new Set(["action", "control", "condition", "outcome", "destination"]),
    );
    expect(record.transition.control.locator).toBeUndefined();
    const sourceEvidence = record.transition.evidence.filter((item) => item.basis === "source");
    expect(sourceEvidence.length).toBeGreaterThan(0);
    for (const item of sourceEvidence) {
      const reference = item.source!;
      const content = inputs.find((input) => input.path === reference.filePath)!.content;
      expect(reference.contentSha256).toBe(
        createHash("sha256").update(content, "utf8").digest("hex"),
      );
      expect(reference.startOffset).toBeGreaterThanOrEqual(0);
      expect(reference.endOffset).toBeLessThanOrEqual(content.length);
      expect(content.slice(reference.startOffset, reference.endOffset).length).toBeGreaterThan(0);
    }
  }
};

describe("bounded source transition declarations", () => {
  it("retains parallel HTML links with identical endpoints and distinct declaration IDs", () => {
    const inputs = [
      file("index.html", '<a href="done.html">First</a><a href="done.html">Second</a>'),
      file("done.html", "<title>Done</title>"),
    ];
    const result = discoverSourcePageMap(inputs);
    expect(result.edges).toHaveLength(2);
    expect(new Set(result.edges.map((edge) => edge.id)).size).toBe(2);
    expect(new Set(result.edges.map((edge) => edge.source + "->" + edge.target)).size).toBe(1);
    expect(result.edges.map((edge) => edge.transition!.control.label)).toEqual(["First", "Second"]);
    expect(result.edges.map((edge) => edge.transition!.destination)).toEqual([
      { kind: "route", value: "/done.html" },
      { kind: "route", value: "/done.html" },
    ]);
    expect(discoverSourcePageMap(inputs)).toEqual(result);
    assertEvidence(inputs, result);
  });

  it("records separate true and false navigation declarations inside one click handler", () => {
    const home = [
      'import { useNavigate } from "react-router-dom";',
      "export default function Home(){",
      " const navigate = useNavigate();",
      ' return <button onClick={() => { if (ready) navigate("/done"); else navigate("/done"); }}>Continue</button>;',
      "}",
    ].join("\n");
    const inputs = reactFiles(home);
    const result = discoverSourcePageMap(inputs);
    expect(result.edges).toHaveLength(2);
    expect(new Set(result.edges.map((edge) => edge.id)).size).toBe(2);
    expect(new Set(result.edges.map((edge) => edge.source + "->" + edge.target)).size).toBe(1);
    expect(result.edges.map((edge) => edge.transition!.condition.branch).sort()).toEqual([
      "false",
      "true",
    ]);
    for (const edge of result.edges) {
      expect(edge.transition).toMatchObject({
        action: { kind: "click" },
        control: { kind: "button", label: "Continue" },
        condition: { kind: "predicate", expression: "ready" },
        outcome: { kind: "navigate" },
        destination: { kind: "route", value: "/done" },
      });
      const evidence = edge.transition!.evidence.find((item) => item.fields.includes("condition"))!;
      expect(evidence.basis).toBe("source");
      expect(home.slice(evidence.source!.startOffset, evidence.source!.endOffset)).toBe("ready");
    }
    assertEvidence(inputs, result);
  });

  it("records conditional JSX declarations without merging their common destination", () => {
    const inputs = reactFiles(
      'export default function Home(){ return ready ? <a href="/done">Ready</a> : <a href="/done">Wait</a>; }',
    );
    const result = discoverSourcePageMap(inputs);
    expect(result.edges).toHaveLength(2);
    expect(result.edges.map((edge) => edge.transition!.condition.branch).sort()).toEqual([
      "false",
      "true",
    ]);
    expect(new Set(result.edges.map((edge) => edge.id)).size).toBe(2);
    assertEvidence(inputs, result);
  });

  it("does not cross a function boundary or manufacture proof from complex conditions", () => {
    const bodies = [
      'if (ready) { const later = () => navigate("/done"); return <button onClick={later}>Go</button>; }',
      'if (ready) { if (other) navigate("/done"); }',
      'if (ready) { for (const item of items) navigate("/done"); }',
      'if (/ready/.test(value)) navigate("/done");',
      'ready && navigate("/done");',
    ];
    for (const body of bodies) {
      const inputs = reactFiles(
        'import { useNavigate } from "react-router-dom"; export default function Home(){ const navigate = useNavigate(); ' +
          body +
          " }",
      );
      const result = discoverSourcePageMap(inputs);
      expect(result.edges).toHaveLength(1);
      expect(result.edges[0].transition!.condition).toEqual({ kind: "unknown", branch: "unknown" });
      expect(result.edges[0].transition!.action.kind).toBe("programmatic");
      expect(result.edges[0].transition!.control.kind).toBe("call");
      assertEvidence(inputs, result);
    }
  });

  it("retains computed link and call destinations as unknown candidates", () => {
    const inputs = reactFiles(
      [
        'import { useNavigate } from "react-router-dom";',
        "export default function Home(){ const navigate = useNavigate(); return <><a href={pickRoute()}>Next</a>",
        "<button onClick={() => navigate(next)}>Continue</button></>; }",
      ].join("\n"),
    );
    const result = discoverSourcePageMap(inputs);
    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toEqual([]);
    expect(result.unresolvedTransitions).toHaveLength(2);
    for (const candidate of result.unresolvedTransitions!) {
      expect(candidate.source).toBe(
        result.nodes.find((node) => node.filePath === "src/Home.tsx")!.id,
      );
      expect(candidate.transition.destination).toEqual({ kind: "unknown" });
      expect(
        candidate.transition.evidence.find((item) => item.fields.includes("destination"))!.basis,
      ).toBe("unknown");
    }
    expect(
      result.unresolvedTransitions!.map((candidate) => candidate.transition.control.kind).sort(),
    ).toEqual(["button", "link"]);
    assertEvidence(inputs, result);
  });

  it("describes HTTP(S) externals and excludes executable or credentialed URL metadata", () => {
    const inputs = [
      file(
        "index.html",
        [
          '<a href="https://outside.test/help?from=home">Help</a>',
          '<a href="javascript:alert(1)">Unsafe</a>',
          '<a href="data:text/html,bad">Data</a>',
          '<a href="https://name:secret@outside.test/">Credentials</a>',
          '<a href="//outside.test/path">Protocol relative</a>',
        ].join("\n"),
      ),
    ];
    const result = discoverSourcePageMap(inputs);
    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toEqual([]);
    expect(result.unresolvedTransitions).toHaveLength(5);
    expect(result.unresolvedTransitions![0].transition).toMatchObject({
      action: { kind: "click" },
      outcome: { kind: "external" },
      destination: { kind: "external", value: "https://outside.test/help?from=home" },
    });
    for (const candidate of result.unresolvedTransitions!.slice(1)) {
      expect(candidate.transition.destination).toEqual({ kind: "unknown" });
      expect(candidate.transition.outcome).toEqual({ kind: "unknown" });
      expect(
        candidate.transition.evidence.filter((item) => item.fields.includes("outcome")),
      ).toEqual([{ basis: "unknown", fields: ["outcome"] }]);
    }
    const metadata = JSON.stringify(records(result));
    expect(metadata).not.toContain("javascript:");
    expect(metadata).not.toContain("data:text");
    expect(metadata).not.toContain("secret");
    assertEvidence(inputs, result);
  });

  it("keeps an unmapped route descriptive and does not guess an ambiguous source", () => {
    const inputs = [
      file(
        "App.tsx",
        [
          'import { Route } from "wouter";',
          'export const App = () => <><Route path="/" component={Home}/><Route path="/second" component={Other}/>',
          '<a href="/missing">Missing</a></>;',
        ].join("\n"),
      ),
    ];
    const result = discoverSourcePageMap(inputs);
    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toEqual([]);
    expect(result.unresolvedTransitions).toHaveLength(1);
    expect(result.unresolvedTransitions![0].source).toBeUndefined();
    expect(result.unresolvedTransitions![0].transition.destination).toEqual({
      kind: "route",
      value: "/missing",
    });
    assertEvidence(inputs, result);
  });

  it("records the exact content hash and end-exclusive UTF-16 declaration spans", () => {
    const home = '<!-- \u{1f680} -->\n<a href="done.html">Go \u{1f680}</a>';
    const inputs = [file("index.html", home), file("done.html", "<title>Done</title>")];
    const result = discoverSourcePageMap(inputs);
    const transition = result.edges[0].transition!;
    const outcome = transition.evidence.find((item) => item.fields.includes("outcome"))!.source!;
    const control = transition.evidence.find((item) => item.fields.includes("control"))!.source!;
    expect(outcome.startOffset).toBe(home.indexOf("<a"));
    expect(outcome.endOffset).toBe(home.indexOf(">", home.indexOf("<a")) + 1);
    expect(home.slice(outcome.startOffset, outcome.endOffset)).toBe('<a href="done.html">');
    expect(home.slice(control.startOffset, control.endOffset)).toBe(
      '<a href="done.html">Go \u{1f680}</a>',
    );
    expect(transition.control.label).toBe("Go \u{1f680}");
    const changed = discoverSourcePageMap([
      file("index.html", home.replace("Go", "To")),
      inputs[1],
    ]);
    expect(changed.edges[0].id).not.toBe(result.edges[0].id);
    assertEvidence(inputs, result);
  });

  it("remaps unresolved sources while preserving declaration IDs and source evidence", () => {
    const inputs = [
      file("index.html", '<a href="done.html">Done</a><a href="https://outside.test/">Away</a>'),
      file("done.html", "<title>Done</title>"),
      file("src/orphan.tsx", "export const orphan = <a href={next}>Unknown</a>;"),
    ];
    const discovered = discoverSourcePageMap(inputs);
    const existing = {
      nodes: discovered.nodes.map((node, index) => ({ ...node, id: "prior-" + index })),
      edges: [],
    };
    const result = stabilizeSourcePageMap(discovered, existing);
    expect(result.nodes.map((node) => node.id)).toEqual(existing.nodes.map((node) => node.id));
    expect(result.edges[0].source).toBe("prior-0");
    expect(result.edges[0].target).toBe("prior-1");
    expect(result.edges[0].id).toBe(discovered.edges[0].id);
    expect(result.edges[0].transition).toBe(discovered.edges[0].transition);
    const external = result.unresolvedTransitions!.find(
      (candidate) => candidate.transition.destination.kind === "external",
    )!;
    expect(external.source).toBe("prior-0");
    const orphan = result.unresolvedTransitions!.find(
      (candidate) => candidate.transition.destination.kind === "unknown",
    )!;
    expect(orphan.source).toBeUndefined();
    expect(result.unresolvedTransitions!.map((candidate) => candidate.id)).toEqual(
      discovered.unresolvedTransitions!.map((candidate) => candidate.id),
    );
    expect(stabilizeSourcePageMap({ nodes: [], edges: [] }).unresolvedTransitions).toBeUndefined();
    assertEvidence(inputs, result);
  });

  it("ignores script, comment, template and embedded transition metadata declarations", () => {
    const inputs = [
      file(
        "index.html",
        [
          "<script>const markup = '<a href=\"fake.html\">Fake</a>';</script>",
          '<!-- <a href="comment.html">Comment</a> -->',
          '<template><a href="template.html">Template</a></template>',
          '<script type="application/json">{"transition":{"action":{"kind":"load"},"destination":{"kind":"route","value":"/invented"}}}</script>',
          '<a href="done.html">Actual</a>',
        ].join("\n"),
      ),
      file("done.html", "<title>Done</title>"),
      file(
        "src/metadata.tsx",
        [
          'import { Route } from "react-router-dom";',
          'const text = \'<Route path="/fake" component={Fake}/><a href="/fake">Fake</a>\';',
          '/* <Route path="/comment" component={Fake}/><a href="/comment">Fake</a> */',
        ].join("\n"),
      ),
    ];
    const result = discoverSourcePageMap(inputs);
    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
    expect(records(result)).toHaveLength(1);
    expect(result.edges[0].transition!.control.label).toBe("Actual");
    assertEvidence(inputs, result);
  });

  it("does not attribute shadowed, mutable or out-of-scope navigator aliases", () => {
    const homes = [
      'import { useNavigate } from "react-router-dom"; export default function Home(){ const navigate=useNavigate(); return <button onClick={(navigate) => navigate("/done")}>Go</button>; }',
      'import { useNavigate } from "react-router-dom"; function hidden(){ const navigate=useNavigate(); } export default function Home(){ return <button onClick={() => navigate("/done")}>Go</button>; }',
      'import { useNavigate } from "react-router-dom"; export default function Home(){ let navigate=useNavigate(); navigate=other; return <button onClick={() => navigate("/done")}>Go</button>; }',
      'import { Link } from "react-router-dom"; export default function Home(Link){ return <Link to="/done">Go</Link>; }',
      'import { useNavigate } from "react-router-dom"; export default function Home(useNavigate){ const navigate=useNavigate(); navigate("/done"); return null; }',
    ];
    for (const home of homes) expect(records(discoverSourcePageMap(reactFiles(home)))).toEqual([]);
  });

  it("keeps HTML base-dependent links unresolved, including declarations before the base", () => {
    const inputs = [
      file(
        "index.html",
        '<a href="done.html">Done</a><base href="https://outside.test/"><a href="https://other.test/">Other</a>',
      ),
      file("done.html", "<title>Done</title>"),
    ];
    const result = discoverSourcePageMap(inputs);
    expect(result.edges).toEqual([]);
    expect(result.unresolvedTransitions).toHaveLength(2);
    expect(result.unresolvedTransitions![0].transition.destination).toEqual({ kind: "unknown" });
    expect(result.unresolvedTransitions![0].transition.unknowns!.join(" ")).toContain("base");
    expect(result.unresolvedTransitions![1].transition.destination.kind).toBe("external");
    assertEvidence(inputs, result);
  });

  it("does not treat spreads, duplicate destinations or function actions as literal URLs", () => {
    const inputs = reactFiles(
      [
        "export default function Home(){ return <>",
        '<a href="/done" {...props}>Spread</a>',
        '<a href="/done" href="/other">Duplicate</a>',
        '<form action={submitAction} aria-label="Save"><button>Save</button></form>',
        "</>; }",
      ].join("\n"),
    );
    const result = discoverSourcePageMap(inputs);
    expect(result.edges).toEqual([]);
    expect(result.unresolvedTransitions).toHaveLength(3);
    for (const candidate of result.unresolvedTransitions!)
      expect(candidate.transition.destination).toEqual({ kind: "unknown" });
    expect(
      result.unresolvedTransitions!.find(
        (candidate) => candidate.transition.control.kind === "form",
      )!.transition.action.kind,
    ).toBe("submit");
    assertEvidence(inputs, result);
  });

  it("describes explicit native form actions and Next router replacement calls", () => {
    const inputs = reactFiles(
      [
        'import { useRouter } from "next/navigation";',
        "export default function Home(){ const router = useRouter(); return <>",
        '<form action="/done" aria-label="Save"><button>Save</button></form>',
        '<button onClick={() => router.replace("/done")}>Replace</button>',
        "</>; }",
      ].join("\n"),
    );
    const result = discoverSourcePageMap(inputs);
    expect(result.edges).toHaveLength(2);
    expect(
      result.edges.find((edge) => edge.transition!.control.kind === "form")!.transition,
    ).toMatchObject({
      action: { kind: "submit" },
      control: { kind: "form", label: "Save" },
      outcome: { kind: "navigate" },
    });
    expect(
      result.edges.find((edge) => edge.transition!.control.kind === "button")!.transition,
    ).toMatchObject({
      action: { kind: "click" },
      control: { kind: "button", label: "Replace" },
      outcome: { kind: "redirect" },
    });
    assertEvidence(inputs, result);
  });

  it("keeps the 1001-unmatched-anchor producer result within the platform candidate boundary", () => {
    const result = discoverSourcePageMap([
      file("index.html", '<a href="missing.html">Missing</a>'.repeat(1001)),
    ]);
    const platform = assertPageMapPlatform(result);
    expect(platform.nodes).toHaveLength(1);
    expect(platform.edges).toEqual([]);
    expect(platform.unresolvedTransitions).toHaveLength(1000);
    expect(new Set(platform.unresolvedTransitions!.map((candidate) => candidate.id)).size).toBe(
      1000,
    );
    expect(
      platform.unresolvedTransitions!.every(
        (candidate) =>
          candidate.source === platform.nodes[0].id &&
          candidate.transition.destination.kind === "route" &&
          candidate.transition.destination.value === "/missing.html",
      ),
    ).toBe(true);
    expect(platform.unresolvedTransitions![0].transition.unknowns).toContain(
      "Omitted unresolved declarations from the bounded scan: 1 (storage limit: 1000).",
    );

    const exact = assertPageMapPlatform(
      discoverSourcePageMap([
        file("index.html", '<a href="missing.html">Missing</a>'.repeat(1000)),
      ]),
    );
    expect(exact.unresolvedTransitions).toHaveLength(1000);
    expect(
      exact
        .unresolvedTransitions!.flatMap((candidate) => candidate.transition.unknowns ?? [])
        .some(
          (value) =>
            value.startsWith("Omitted ") || value.startsWith("Source transition scan reached"),
        ),
    ).toBe(false);
  });

  it("enforces independent storage budgets and retains matched edges after unresolved overflow", () => {
    const result = discoverSourcePageMap([
      file(
        "index.html",
        '<a href="missing.html">Missing</a>'.repeat(1001) +
          '<a href="done.html">Done</a>'.repeat(2001),
      ),
      file("done.html", "<title>Done</title>"),
    ]);
    const platform = assertPageMapPlatform(result);
    expect(platform.edges).toHaveLength(2000);
    expect(platform.unresolvedTransitions).toHaveLength(1000);
    expect(new Set(records(platform).map((candidate) => candidate.id)).size).toBe(3000);
    expect(platform.unresolvedTransitions![0].transition.unknowns).toEqual(
      expect.arrayContaining([
        "Omitted page-edge declarations from the bounded scan: 1 (storage limit: 2000).",
        "Omitted unresolved declarations from the bounded scan: 1 (storage limit: 1000).",
      ]),
    );
  });

  it("distinguishes counted storage omissions from possible omissions beyond the bounded scan", () => {
    const result = discoverSourcePageMap([
      file("index.html", '<a href="missing.html">Missing</a>'.repeat(6001)),
    ]);
    const platform = assertPageMapPlatform(result);
    expect(platform.unresolvedTransitions).toHaveLength(1000);
    const unknowns = platform.unresolvedTransitions![0].transition.unknowns!;
    expect(unknowns).toContain(
      "Omitted unresolved declarations from the bounded scan: 5000 (storage limit: 1000).",
    );
    expect(unknowns).toContain(
      "Source transition scan reached 6000 declarations; additional declarations may be omitted.",
    );
    expect(unknowns.join(" ")).not.toContain("5001");
  });

  it("caps resolved edge storage and rejects invalid evidence paths", () => {
    const result = discoverSourcePageMap([
      file("index.html", '<a href="done.html">Next</a>'.repeat(2005)),
      file("done.html", "<title>Done</title>"),
    ]);
    expect(records(result)).toHaveLength(2000);
    expect(new Set(records(result).map((candidate) => candidate.id)).size).toBe(2000);
    const invalid = discoverSourcePageMap([
      file("bad:name.html", '<a href="/next">Next</a>'),
      file("bad//name.html", '<a href="/next">Next</a>'),
      file("bad/./name.html", '<a href="/next">Next</a>'),
      file("../name.html", '<a href="/next">Next</a>'),
    ]);
    expect(invalid.nodes).toEqual([]);
    expect(records(invalid)).toEqual([]);
  });
});
