import { describe, it, expect } from "vitest";
import { normalizePath, extractStaticEdges, type PageMapNode } from "./page-map.js";
import type { BuilderFile } from "./builder.js";

const html = (path: string, content: string): BuilderFile => ({
  path,
  content,
  mimeType: "text/html",
});

const node = (id: string, filePath: string): PageMapNode => ({
  id,
  label: id,
  pageType: "other",
  filePath,
  position: { x: 0, y: 0 },
  isNew: false,
  hasError: false,
  aiGenerated: true,
  notes: "",
});

describe("normalizePath", () => {
  it("strips leading slashes", () => {
    expect(normalizePath("/about.html")).toBe("about.html");
    expect(normalizePath("///deep/nested.html")).toBe("deep/nested.html");
  });

  it("collapses repeated slashes (empty segments)", () => {
    expect(normalizePath("blog//post.html")).toBe("blog/post.html");
  });

  it("removes '.' segments", () => {
    expect(normalizePath("./blog/./post.html")).toBe("blog/post.html");
  });

  it("collapses '..' segments", () => {
    expect(normalizePath("blog/post/../about.html")).toBe("blog/about.html");
    expect(normalizePath("blog/post/../../about.html")).toBe("about.html");
  });

  it("treats extra '..' at root as no-op (no leakage above root)", () => {
    expect(normalizePath("../../about.html")).toBe("about.html");
  });

  it("preserves trailing absence — no trailing slash artifact", () => {
    expect(normalizePath("blog/")).toBe("blog");
  });

  it("returns empty string for root-only input", () => {
    expect(normalizePath("/")).toBe("");
    expect(normalizePath("./")).toBe("");
  });
});

describe("extractStaticEdges — relative path resolution", () => {
  it("resolves '../about.html' from a nested source against source dir", () => {
    const nodes = [node("page-post", "blog/post.html"), node("page-about", "about.html")];
    const files = [html("blog/post.html", `<a href="../about.html">About</a>`)];
    const edges = extractStaticEdges(files, nodes);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: "page-post", target: "page-about" });
  });

  it("resolves absolute '/about.html' the same regardless of source dir", () => {
    const nodes = [node("page-post", "blog/post.html"), node("page-about", "about.html")];
    const files = [html("blog/post.html", `<a href="/about.html">A</a>`)];
    expect(extractStaticEdges(files, nodes)).toHaveLength(1);
  });

  it("resolves sibling links via source-relative path", () => {
    const nodes = [node("page-a", "blog/a.html"), node("page-b", "blog/b.html")];
    const files = [html("blog/a.html", `<a href="b.html">B</a>`)];
    const edges = extractStaticEdges(files, nodes);
    expect(edges).toEqual([expect.objectContaining({ source: "page-a", target: "page-b" })]);
  });
});

describe("extractStaticEdges — basename fallback ambiguity", () => {
  it("uses basename fallback when unique", () => {
    const nodes = [node("page-index", "index.html"), node("page-about", "about.html")];
    const files = [html("index.html", `<a href="about.html">About</a>`)];
    expect(extractStaticEdges(files, nodes)).toHaveLength(1);
  });

  it("disables basename fallback for duplicate basenames", () => {
    // Two nodes both named index.html in different dirs. A reference to
    // 'index.html' from a third page (with no dir) must NOT route to either.
    const nodes = [
      node("page-a-idx", "a/index.html"),
      node("page-b-idx", "b/index.html"),
      node("page-home", "home.html"),
    ];
    const files = [html("home.html", `<a href="index.html">Index</a>`)];
    expect(extractStaticEdges(files, nodes)).toHaveLength(0);
  });

  it("still resolves duplicate-basename targets when the full path matches", () => {
    const nodes = [node("page-a-idx", "a/index.html"), node("page-b-idx", "b/index.html")];
    const files = [html("a/index.html", `<a href="../b/index.html">B</a>`)];
    const edges = extractStaticEdges(files, nodes);
    expect(edges).toEqual([
      expect.objectContaining({ source: "page-a-idx", target: "page-b-idx" }),
    ]);
  });
});

describe("extractStaticEdges — pattern coverage and skipping", () => {
  it("picks up <form action>, inline location.href, history.pushState", () => {
    const nodes = [
      node("page-home", "index.html"),
      node("page-login", "login.html"),
      node("page-dash", "dash.html"),
      node("page-profile", "profile.html"),
    ];
    const files = [
      html(
        "index.html",
        `
        <form action="login.html"></form>
        <script>
          window.location.href = "dash.html";
          history.pushState({}, "", "profile.html");
        </script>
      `,
      ),
    ];
    const targets = extractStaticEdges(files, nodes)
      .map((e) => e.target)
      .sort();
    expect(targets).toEqual(["page-dash", "page-login", "page-profile"]);
  });

  it("skips anchors, mailto, tel, javascript:, http(s), and protocol-relative", () => {
    const nodes = [node("page-home", "index.html"), node("page-about", "about.html")];
    const files = [
      html(
        "index.html",
        `
        <a href="#top">top</a>
        <a href="mailto:a@b.com">mail</a>
        <a href="tel:123">phone</a>
        <a href="javascript:void(0)">js</a>
        <a href="https://example.com/about.html">ext</a>
        <a href="//cdn.com/about.html">proto-rel</a>
      `,
      ),
    ];
    expect(extractStaticEdges(files, nodes)).toHaveLength(0);
  });

  it("strips query/hash before resolution", () => {
    const nodes = [node("page-home", "index.html"), node("page-about", "about.html")];
    const files = [html("index.html", `<a href="about.html?ref=nav#team">A</a>`)];
    expect(extractStaticEdges(files, nodes)).toHaveLength(1);
  });

  it("dedupes same source→target pair within one pass", () => {
    const nodes = [node("page-home", "index.html"), node("page-about", "about.html")];
    const files = [
      html(
        "index.html",
        `<a href="about.html">1</a><a href="./about.html">2</a><a href="about.html#x">3</a>`,
      ),
    ];
    expect(extractStaticEdges(files, nodes)).toHaveLength(1);
  });

  it("does not create self-loop edges", () => {
    const nodes = [node("page-home", "index.html")];
    const files = [html("index.html", `<a href="index.html">self</a>`)];
    expect(extractStaticEdges(files, nodes)).toHaveLength(0);
  });

  it("ignores files whose source is not a mapped node", () => {
    const nodes = [node("page-about", "about.html")];
    const files = [html("unknown.html", `<a href="about.html">A</a>`)];
    expect(extractStaticEdges(files, nodes)).toHaveLength(0);
  });
});
