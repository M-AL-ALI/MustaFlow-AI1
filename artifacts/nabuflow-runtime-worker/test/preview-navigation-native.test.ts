import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Native workerd, using dependencies already shipped with installed Wrangler.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare } = wranglerRequire("miniflare");
const { build } = wranglerRequire("esbuild");

interface NativeResult {
  nativeParser: boolean;
  cancellationCount: number;
  cancellationsBeforeConsumption: number;
  origin: string;
  scope: string;
  status: number;
  html: string;
  elements: Record<string, Record<string, string>>;
  headers: Record<string, string>;
  setCookies: string[];
  upstream: Array<{
    url: string;
    method: string;
    body: string;
    port: number;
    redirect: string;
    headers: Record<string, string>;
  }>;
  followed?: { status: number; body: string };
  redemption: { status: number; cookie: string };
  replayStatus: number;
}

describe.sequential("native scoped preview navigation", () => {
  let mf: InstanceType<typeof Miniflare>;
  let base: string;
  beforeAll(async () => {
    const bundle = await build({
      entryPoints: [
        fileURLToPath(new URL("./fixtures/preview-navigation-native-worker.mjs", import.meta.url)),
      ],
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      external: ["cloudflare:*", "node:*"],
      plugins: [
        {
          name: "injected-preview-sandbox-only",
          setup(build: {
            onResolve: (
              options: { filter: RegExp },
              callback: (args: { importer: string }) => unknown,
            ) => void;
            onLoad: (
              options: { filter: RegExp; namespace: string },
              callback: () => unknown,
            ) => void;
          }) {
            // The handler receives an injected fake tenant transport. Neither the
            // handler nor HTMLRewriter is mocked; unexpected adapter use fails.
            build.onResolve({ filter: /^\.\/runtime-backend$/ }, (args) =>
              args.importer.endsWith("preview-data-plane.ts")
                ? { path: "injected-backend", namespace: "preview-fixture" }
                : undefined,
            );
            build.onLoad({ filter: /.*/, namespace: "preview-fixture" }, () => ({
              loader: "js",
              contents:
                "export function runtimeSandboxStub(){throw new Error('unexpected raw sandbox');}" +
                "export function runtimeSandboxWebSocketConnect(){throw new Error('unexpected raw websocket');}",
            }));
          },
        },
      ],
    });
    mf = new Miniflare({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-08-04",
      compatibilityFlags: ["nodejs_compat"],
    });
    base = (await mf.ready).origin;
  }, 30000);
  afterAll(async () => {
    await mf?.dispose();
  }, 30000);

  async function run(input: Record<string, unknown> = {}): Promise<NativeResult> {
    const response = await fetch(base + "/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as NativeResult;
    expect(result.nativeParser).toBe(true);
    return result;
  }

  it("rewrites parsed links, forms and assets; preserves external URLs and fragments", async () => {
    const result = await run({
      chunkBytes: 7,
      html:
        "<!doctype html><html><body>" +
        '<a id="notes" href="/notes?q=1&amp;x=2#part">caf\u00e9</a>' +
        '<a id="fragment" href="#part">section</a>' +
        '<a id="external" href="https://example.net/notes">outside</a>' +
        '<a id="network" href="//example.net/notes">outside</a>' +
        '<a id="mail" href="mailto:hello@example.net">mail</a>' +
        '<a id="scoped" href="{{scope}}/already">already</a>' +
        '<form id="form" action="/save"><button id="button" formaction="/alternate">save</button>' +
        '<input id="input" type="image" src="/send.png" formaction="/send"></form>' +
        '<script id="script" src="/app.js"></script><link id="css" rel="stylesheet" href="/app.css">' +
        '<img id="image" src="/photo.png" srcset="/small.png 1x, /large.png 2x">' +
        '<source id="source" srcset="data:image/png;base64,AAAA 1x, /retina.png 2x">' +
        '<video id="video" src="/movie.mp4" poster="/poster.png"></video>' +
        '<svg><use id="use" href="/sprite.svg#icon"></use></svg>' +
        '<script>window.example="/leave";</script><style>.x{background:url(/raw.png)}</style>' +
        "</body></html>",
      follow: { id: "notes", attribute: "href" },
    });
    const scoped = result.origin + result.scope;
    expect(result.status).toBe(200);
    expect(result.elements.notes.href).toBe(scoped + "/notes?q=1&x=2#part");
    expect(result.elements.fragment.href).toBe("#part");
    expect(result.elements.external.href).toBe("https://example.net/notes");
    expect(result.elements.network.href).toBe("//example.net/notes");
    expect(result.elements.mail.href).toBe("mailto:hello@example.net");
    expect(result.elements.scoped.href).toBe(scoped + "/already");
    expect(result.elements.form.action).toBe(scoped + "/save");
    expect(result.elements.button.formaction).toBe(scoped + "/alternate");
    expect(result.elements.input.formaction).toBe(scoped + "/send");
    expect(result.elements.input.src).toBe(scoped + "/send.png");
    expect(result.elements.script.src).toBe(scoped + "/app.js");
    expect(result.elements.css.href).toBe(scoped + "/app.css");
    expect(result.elements.image.src).toBe(scoped + "/photo.png");
    expect(result.elements.image.srcset).toBe(
      scoped + "/small.png 1x, " + scoped + "/large.png 2x",
    );
    expect(result.elements.source.srcset).toBe(
      "data:image/png;base64,AAAA 1x, " + scoped + "/retina.png 2x",
    );
    expect(result.elements.video.poster).toBe(scoped + "/poster.png");
    expect(result.elements.use.href).toBe(scoped + "/sprite.svg#icon");
    expect(result.html).toContain('window.example="/leave"');
    expect(result.html).toContain("url(/raw.png)");
    expect(result.html).toContain("caf\u00e9");
    expect(result.headers["x-nabuflow-preview-bridge"]).toBe("visual-edit-v1");
    expect(result.html.indexOf("window.__MFM_VISUAL__")).toBeLessThan(
      result.html.indexOf("</body>"),
    );
    expect(result.followed?.status).toBe(200);
    expect(result.upstream[1].url).toBe("https://tenant.preview.invalid/notes?q=1&x=2");
  });

  it("keeps POST HTML and its submitted form under the same authenticated runtime", async () => {
    const result = await run({
      method: "POST",
      body: "original-body",
      html: '<form id="form" action="/save?mode=1"><button>save</button></form>',
      follow: { id: "form", attribute: "action", method: "POST", body: "name=alice" },
    });
    expect(result.upstream[0].body).toBe("original-body");
    expect(result.followed?.status).toBe(200);
    expect(result.upstream[1]).toMatchObject({
      url: "https://tenant.preview.invalid/save?mode=1",
      method: "POST",
      body: "name=alice",
      port: 8080,
      redirect: "manual",
    });
    const errorPage = await run({
      method: "POST",
      status: 422,
      html: '<form id="retry" action="/save">retry</form>',
    });
    expect(errorPage.status).toBe(422);
    expect(errorPage.elements.retry.action).toBe(errorPage.origin + errorPage.scope + "/save");
    expect(errorPage.headers["x-nabuflow-preview-bridge"]).toBeUndefined();
  });

  it("uses the first base href even after earlier links; ignores later base href values", async () => {
    for (const href of ["/assets/", "assets/", ""]) {
      const result = await run({
        html:
          '<html><head><a id="early" href="next">early</a>' +
          '<base target="_self"><base id="base" href="' +
          href +
          '">' +
          '<base href="https://ignored.example/"></head><body>' +
          '<a id="late" href="../notes">late</a><a id="hash" href="#part">hash</a>' +
          '<form id="empty" action=""></form></body></html>',
      });
      const originalBase = new URL(href, "https://tenant.preview.invalid/nested/page");
      const early = new URL("next", originalBase);
      const late = new URL("../notes", originalBase);
      expect(result.elements.early.href).toBe(result.origin + result.scope + early.pathname);
      expect(result.elements.late.href).toBe(result.origin + result.scope + late.pathname);
      expect(result.elements.hash.href).toBe("#part");
      expect(result.elements.empty.action).toBe("");
    }
  });

  it("preserves external base semantics while scoping explicit same-app destinations", async () => {
    const result = await run({
      html:
        '<base id="base" href="https://cdn.example/assets/">' +
        '<a id="external" href="/help">external</a><img id="relative" src="picture.png">' +
        '<a id="app" href="https://runtime-staging.example.workers.dev/notes">app</a>' +
        '<a id="fragment" href="#part">part</a>',
    });
    expect(result.elements.base.href).toBe("https://cdn.example/assets/");
    expect(result.elements.external.href).toBe("/help");
    expect(new URL(result.elements.external.href, result.elements.base.href).href).toBe(
      "https://cdn.example/help",
    );
    expect(result.elements.relative.src).toBe("picture.png");
    expect(result.elements.fragment.href).toBe("#part");
    expect(result.elements.app.href).toBe(result.origin + result.scope + "/notes");
  });

  it("respects blocked base URLs without relaxing the tenant CSP", async () => {
    for (const policy of ["base-uri 'none'", "base-uri 'self'"]) {
      const result = await run({
        responseHeaders: { "content-security-policy": policy },
        html: '<base href="https://external.example/assets/"><a id="next" href="next">next</a>',
      });
      expect(result.elements.next.href).toBe(result.origin + result.scope + "/nested/next");
      expect(result.headers["content-security-policy"]).toContain(policy);
    }
  });

  it("rewrites Location for all redirect statuses without changing method semantics", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const result = await run({
        method: "POST",
        status,
        responseHeaders: { location: "../notes?q=1#part", "content-type": "text/plain" },
        follow: { location: true, method: status === 307 || status === 308 ? "POST" : "GET" },
      });
      expect(result.status).toBe(status);
      expect(result.headers.location).toBe(result.origin + result.scope + "/notes?q=1#part");
      expect(result.upstream[0].redirect).toBe("manual");
      expect(result.followed?.status).toBe(200);
      expect(result.upstream[1].method).toBe(status === 307 || status === 308 ? "POST" : "GET");
    }
    for (const location of ["https://example.net/next", "//example.net/next", "#part"]) {
      const result = await run({
        status: 302,
        responseHeaders: { location, "content-type": "text/plain" },
      });
      expect(result.headers.location).toBe(location);
    }
  });

  it.each([
    ["&#47;notes", "/notes"],
    ["&#47notes", "/notes"],
    ["&#x2f;notes", "/notes"],
    ["&sol;notes", "/notes"],
    ["&period;&period;&sol;&period;&period;&sol;notes", "/notes"],
    ["/notes?q=1&amp;x=2", "/notes?q=1&x=2"],
    ["/notes?q=1&not=2", "/notes?q=1&not=2"],
    ["/notes?q=&amp;copy;", "/notes?q=&copy;"],
    ["&Tab;&sol;notes", "/notes"],
  ])(
    "decodes an HTML attribute once before scoping and following it: %s",
    async (encoded, expected) => {
      const result = await run({
        html: '<a id="next" href="' + encoded + '">next</a>',
        follow: { id: "next", attribute: "href" },
      });
      expect(result.status).toBe(200);
      expect(result.elements.next.href).toBe(result.origin + result.scope + expected);
      expect(result.followed?.status).toBe(200);
      const followed = new URL(result.upstream[1].url);
      expect(followed.pathname + followed.search).toBe(expected);
    },
  );

  it.each([
    ['<a href="', '">go</a>'],
    ['<form action="', '"><button>go</button></form>'],
    ['<button formaction="', '">go</button>'],
    ['<img src="', '">'],
    ['<img srcset="', ' 1x, /safe.png 2x">'],
    ['<link imagesrcset="', ' 1x, /safe.png 2x">'],
    ['<base href="', '"><a href="notes">go</a>'],
  ])("rejects entity-encoded forbidden targets in %s", async (before, after) => {
    for (const encoded of [
      "&#47;_nabuflow&#47;control&#47;v1",
      "&sol;_nabuflow&sol;preview&sol;v1&sol;other-runtime&sol;notes",
      "{{scope}}&sol;&period;&period;&sol;other-runtime&sol;notes",
      "{{scope}}&#47;&#37;2e&#37;2e&#47;other-runtime&#47;notes",

      "&bsol;_nabuflow&bsol;control&bsol;v1",
    ]) {
      const result = await run({ html: before + encoded + after });
      expect(result.status).toBe(502);
      expect(JSON.parse(result.html).code).toBe("preview_navigation_scope_invalid");
      expect(result.upstream).toHaveLength(1);
      expect(result.html).not.toContain("<a");
      expect(result.html).not.toContain("<form");
    }
  });

  it.each([
    ['<a href="', '">go</a>'],
    ['<form action="', '"><button>go</button></form>'],
    ['<button formaction="', '">go</button>'],
    ['<img src="', '">'],
    ['<base href="', '"><a href="notes">go</a>'],
  ])("normalizes a tab inside a scalar URL in %s", async (before, after) => {
    const result = await run({
      html: before + "&#47;_nabu&Tab;flow&#47;control&#47;v1" + after,
    });
    expect(result.status).toBe(502);
    expect(JSON.parse(result.html).code).toBe("preview_navigation_scope_invalid");
    expect(result.upstream).toHaveLength(1);
  });

  it.each([
    ["img", "srcset"],
    ["source", "srcset"],
    ["link", "imagesrcset"],
  ])("retains an encoded tab as a descriptor separator in %s %s", async (tag, attribute) => {
    const result = await run({
      html:
        "<" +
        tag +
        ' id="image" ' +
        attribute +
        '="&#47;_nabu&Tab;flow&#47;control&#47;v1 1x, /safe.png 2x">',
    });
    const scoped = result.origin + result.scope;
    expect(result.status).toBe(200);
    // The invalid descriptor is retained, not reinterpreted as a scalar URL.
    expect(result.elements.image[attribute]).toBe(
      scoped + "/_nabu\tflow/control/v1 1x, " + scoped + "/safe.png 2x",
    );
  });

  it.each([
    ["img", "srcset"],
    ["source", "srcset"],
    ["link", "imagesrcset"],
  ])(
    "rejects a forbidden second candidate after an encoded comma in %s %s",
    async (tag, attribute) => {
      const result = await run({
        html:
          "<" +
          tag +
          " " +
          attribute +
          '="/safe.png 1x&comma; &#47;_nabuflow&#47;control&#47;v1 2x">',
      });
      expect(result.status).toBe(502);
      expect(JSON.parse(result.html).code).toBe("preview_navigation_scope_invalid");
      expect(result.upstream).toHaveLength(1);
    },
  );

  it.each(["&nbsp;", "&#160;", "&#xA0;", "&emsp;", "&#65279;"])(
    "does not misclassify Unicode-prefixed traversal as an external URL: %s",
    async (space) => {
      const result = await run({
        html:
          '<a href="' +
          space +
          "https://example.net/" +
          "../".repeat(16) +
          '_nabuflow/control/v1">go</a>',
      });
      expect(result.status).toBe(502);
      expect(JSON.parse(result.html).code).toBe("preview_navigation_scope_invalid");
      expect(result.upstream).toHaveLength(1);
    },
  );

  it.each([
    ["&nbsp;notes", "/nested/%C2%A0notes"],
    ["&#160;notes", "/nested/%C2%A0notes"],
    ["/notes&nbsp;", "/notes%C2%A0"],
    ["&emsp;notes", "/nested/%E2%80%83notes"],
    ["&Tab; /notes&#10;", "/notes"],
  ])("preserves URL-standard whitespace semantics for %s", async (href, path) => {
    const result = await run({
      html: '<a id="next" href="' + href + '">go</a>',
      follow: { id: "next", attribute: "href" },
    });
    expect(result.status).toBe(200);
    expect(result.elements.next.href).toBe(result.origin + result.scope + path);
    expect(result.followed?.status).toBe(200);
    expect(new URL(result.upstream[1].url).pathname).toBe(path);
  });

  it("applies the same Unicode URL semantics to a Location header", async () => {
    const result = await run({
      status: 302,
      responseHeaders: {
        location: "\u00a0https://example.net/" + "../".repeat(16) + "_nabuflow/control/v1",
        "content-type": "text/plain",
      },
    });
    expect(result.status).toBe(502);
    expect(JSON.parse(result.html).code).toBe("preview_navigation_scope_invalid");
  });

  it.each([
    '<template><base href="https://cdn.example/"></template>',
    '<template><template><base href="https://cdn.example/"></template></template>',
    '<template/><base href="https://cdn.example/"></template>',
  ])("ignores an inert template base for live navigation: %s", async (template) => {
    const result = await run({
      html:
        "<html><head>" +
        template +
        "</head><body>" +
        '<a id="next" href="/notes">go</a></body></html>',
      follow: { id: "next", attribute: "href" },
    });
    expect(result.status).toBe(200);
    expect(result.elements.next.href).toBe(result.origin + result.scope + "/notes");
    expect(result.followed?.status).toBe(200);
    const rejected = await run({
      html:
        "<html><head>" +
        template +
        "</head><body>" +
        '<a href="&#47;_nabuflow/control/v1">go</a></body></html>',
    });
    expect(rejected.status).toBe(502);
    expect(JSON.parse(rejected.html).code).toBe("preview_navigation_scope_invalid");
  });

  it("does not let inert or href-less bases consume the active first-base slot", async () => {
    const result = await run({
      html:
        '<head><template><base id="inert" href="/inert/"></template>' +
        '<base target="_blank"><base id="base" href="/assets/">' +
        '<base href="/ignored/"></head><a id="next" href="notes">go</a>',
    });
    expect(result.status).toBe(200);
    expect(result.elements.inert.href).toBe("/inert/");
    expect(result.elements.base.href).toBe(result.origin + result.scope + "/assets/");
    expect(result.elements.next.href).toBe(result.origin + result.scope + "/assets/notes");
  });

  it("does not apply inert template CSP to the active base", async () => {
    const result = await run({
      html:
        '<head><template><meta http-equiv="content-security-policy" ' +
        'content="base-uri &#39;none&#39;"></template><base id="base" href="/assets/">' +
        '</head><a id="next" href="notes">go</a>',
    });
    expect(result.status).toBe(200);
    expect(result.elements.base.href).toBe(result.origin + result.scope + "/assets/");
    expect(result.elements.next.href).toBe(result.origin + result.scope + "/assets/notes");
  });

  it("preserves a real external base following an inert base", async () => {
    const result = await run({
      html:
        '<head><template><base href="/inert/"></template>' +
        '<base id="base" href="https://cdn.example/assets/"></head>' +
        '<a id="next" href="notes">go</a>',
    });
    expect(result.status).toBe(200);
    expect(result.elements.base.href).toBe("https://cdn.example/assets/");
    expect(result.elements.next.href).toBe("notes");
  });

  it.each([
    '<svg><base href="https://cdn.example/"></base></svg>',
    '<svg><template><base href="https://cdn.example/"></base></template></svg>',
    '<svg><foreignObject><template><base href="https://cdn.example/">' +
      "</template></foreignObject></svg>",
  ])("does not give a foreign or inert base document semantics: %s", async (foreign) => {
    const result = await run({
      html: foreign + '<base id="base" href="/assets/"><a id="next" href="notes">go</a>',
    });
    expect(result.status).toBe(200);
    expect(result.elements.base.href).toBe(result.origin + result.scope + "/assets/");
    expect(result.elements.next.href).toBe(result.origin + result.scope + "/assets/notes");
  });

  it.each([
    "&#47;_nabuflow/control/v1",
    "/_nabuflow/preview/v1/other-runtime/notes",
    "{{scope}}/%2e%2e/other-runtime/notes",
  ])("rejects the active SVG xlink destination %s", async (href) => {
    const result = await run({
      html:
        '<svg xmlns:xlink="http://www.w3.org/1999/xlink">' +
        '<a xlink:href="' +
        href +
        '"><text>go</text></a></svg>',
    });
    expect(result.status).toBe(502);
    expect(JSON.parse(result.html).code).toBe("preview_navigation_scope_invalid");
    expect(result.upstream).toHaveLength(1);
  });

  it("scopes and follows a legitimate legacy SVG anchor", async () => {
    const result = await run({
      html:
        '<svg xmlns:xlink="http://www.w3.org/1999/xlink">' +
        '<a id="next" xlink:href="&#47;notes?q=1&amp;x=2"><text>go</text></a></svg>',
      follow: { id: "next", attribute: "xlink:href" },
    });
    expect(result.status).toBe(200);
    expect(result.elements.next["xlink:href"]).toBe(
      result.origin + result.scope + "/notes?q=1&x=2",
    );
    expect(result.followed?.status).toBe(200);
    const followed = new URL(result.upstream[1].url);
    expect(followed.pathname + followed.search).toBe("/notes?q=1&x=2");
  });

  it.each(["/notes", "#part", ""])(
    "honors a primary SVG href over a shadowed xlink:href: %s",
    async (href) => {
      const result = await run({
        html:
          '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><a id="next" href="' +
          href +
          '" xlink:href="/_nabuflow/control/v1"><text>go</text></a></svg>',
      });
      expect(result.status).toBe(200);
      expect(result.elements.next.href).toBe(
        href === "/notes" ? result.origin + result.scope + href : href,
      );
      expect(result.elements.next["xlink:href"]).toBe("/_nabuflow/control/v1");
    },
  );

  it("does not activate xlink:href on an HTML anchor", async () => {
    const result = await run({
      html: '<a id="next" href="/notes" xlink:href="/_nabuflow/control/v1">go</a>',
    });
    expect(result.status).toBe(200);
    expect(result.elements.next.href).toBe(result.origin + result.scope + "/notes");
    expect(result.elements.next["xlink:href"]).toBe("/_nabuflow/control/v1");
  });

  it.each(["constructor", "toString", "valueOf", "custom-panel"])(
    "ignores inherited attribute-table properties for an unknown %s element",
    async (tag) => {
      const result = await run({
        html: "<" + tag + ">content</" + tag + '><a id="next" href="/notes">go</a>',
        follow: { id: "next", attribute: "href" },
      });
      expect(result.status).toBe(200);
      expect(result.elements.next.href).toBe(result.origin + result.scope + "/notes");
      expect(result.followed?.status).toBe(200);
    },
  );

  it.each([
    ["explicit head", "<head>", "</head><body>", true],
    ["implicit head", "", "", true],
    ["after head", "<head></head>", "<body>", true],
    ["explicit body", "<body>", "", false],
    ["text before", "hello", "", false],
    ["orphan end body", "</body>", "", false],
    ["implicit head close", "<head><div></div>", "", false],
    ["template", "<head><template>", "</template></head><body>", false],
    ["noscript", "<head><noscript>", "</noscript></head><body>", false],
    ["foreign meta", "<svg>", "</svg>", false],
  ])("applies only document-head CSP in %s", async (_name, before, after, applies) => {
    const meta = '<meta http-equiv="content-security-policy" content="base-uri &#39;none&#39;">';
    const result = await run({
      html:
        before + meta + after + '<base id="base" href="/assets/"><a id="next" href="notes">go</a>',
    });
    expect(result.status).toBe(200);
    expect(result.elements.next.href).toBe(
      result.origin + result.scope + (applies ? "/nested/notes" : "/assets/notes"),
    );
    const forbidden = await run({
      html: before + meta + after + '<base href="/_nabuflow/control/v1"><a href="#x">go</a>',
    });
    expect(forbidden.status).toBe(applies ? 200 : 502);
    if (!applies) expect(JSON.parse(forbidden.html).code).toBe("preview_navigation_scope_invalid");
  });

  it("does not retroactively apply a later head policy to the first base", async () => {
    const result = await run({
      html:
        '<head><base href="/_nabuflow/control/v1">' +
        '<meta http-equiv="content-security-policy" content="base-uri &#39;none&#39;"></head>',
    });
    expect(result.status).toBe(502);
    expect(JSON.parse(result.html).code).toBe("preview_navigation_scope_invalid");
  });

  it("retains document source and only rewrites the selected base attribute", async () => {
    const result = await run({
      html:
        '<!DOCTYPE html><HEAD><BASE data-note="a>b" HREF=/assets/ target=_blank>' +
        '<base href="/_nabuflow/control/v1"></HEAD><a id="next" href="notes">go</a>',
    });
    expect(result.status).toBe(200);
    expect(result.html).toContain(
      '<!DOCTYPE html><HEAD><BASE data-note="a>b" href="' +
        result.origin +
        result.scope +
        '/assets/" target=_blank>',
    );
    expect(result.html).toContain('<base href="/_nabuflow/control/v1">');
    expect(result.elements.next.href).toBe(result.origin + result.scope + "/assets/notes");
  });

  it("bounds metadata parser structure without limiting ordinary large text", async () => {
    const crowded = await run({ html: "<div></div>".repeat(16_385) });
    expect(crowded.status).toBe(502);
    expect(JSON.parse(crowded.html).code).toBe("preview_html_structure_too_large");
    const ordinary = await run({
      html: "<p>" + "x".repeat(256 * 1024) + '</p><a id="next" href="/notes">go</a>',
    });
    expect(ordinary.status).toBe(200);
    expect(ordinary.elements.next.href).toBe(ordinary.origin + ordinary.scope + "/notes");
  });

  it.each([
    ["img", "srcset"],
    ["source", "srcset"],
    ["link", "imagesrcset"],
  ])(
    "does not hide later candidates behind nested parentheses in %s %s",
    async (tag, attribute) => {
      for (const destination of [
        "/_nabuflow/control/v1",
        "&#47;_nabuflow/preview/v1/other-runtime/notes",
      ]) {
        const result = await run({
          html: "<" + tag + " " + attribute + '="/safe.png bad((x), ' + destination + ' 2x">',
        });
        expect(result.status).toBe(502);
        expect(JSON.parse(result.html).code).toBe("preview_navigation_scope_invalid");
      }
      const safe = await run({
        html:
          "<" +
          tag +
          ' id="image" ' +
          attribute +
          '="data:image/png;base64,AAAA bad((x), /safe.png 2x, /retina.png 3x">',
      });
      expect(safe.status).toBe(200);
      expect(safe.elements.image[attribute]).toBe(
        "data:image/png;base64,AAAA bad((x), " +
          safe.origin +
          safe.scope +
          "/safe.png 2x, " +
          safe.origin +
          safe.scope +
          "/retina.png 3x",
      );
    },
  );

  it.each(["image", "use"])("honors active SVG href precedence on %s", async (tag) => {
    for (const href of ["/notes", "#part", ""]) {
      const result = await run({
        html:
          '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><' +
          tag +
          ' id="next" href="' +
          href +
          '" xlink:href="/_nabuflow/control/v1"></' +
          tag +
          "></svg>",
      });
      expect(result.status).toBe(200);
      expect(result.elements.next.href).toBe(
        href === "/notes" ? result.origin + result.scope + href : href,
      );
      expect(result.elements.next["xlink:href"]).toBe("/_nabuflow/control/v1");
    }
    const legacy = await run({
      html:
        '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><' +
        tag +
        ' id="next" xlink:href="/notes"></' +
        tag +
        "></svg>",
    });
    expect(legacy.status).toBe(200);
    expect(legacy.elements.next["xlink:href"]).toBe(legacy.origin + legacy.scope + "/notes");
    const forbidden = await run({
      html:
        '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><' +
        tag +
        ' xlink:href="/_nabuflow/control/v1"></' +
        tag +
        "></svg>",
    });
    expect(forbidden.status).toBe(502);
    expect(JSON.parse(forbidden.html).code).toBe("preview_navigation_scope_invalid");
  });

  it.each(["normal", "reject", "pending"])(
    "cancels a rejected Location body without masking failure: %s",
    async (cancelMode) => {
      const result = await run({
        status: 302,
        openStream: true,
        cancelMode,
        responseHeaders: { location: "/_nabuflow/control/v1", "content-type": "text/plain" },
      });
      expect(result.status).toBe(502);
      expect(JSON.parse(result.html).code).toBe("preview_navigation_scope_invalid");
      expect(result.cancellationCount).toBe(1);
    },
  );

  it("retains successful streaming until its consumer cancels", async () => {
    const result = await run({
      status: 302,
      openStream: true,
      html: "still streaming",
      responseHeaders: { location: "/notes", "content-type": "text/plain" },
    });
    expect(result.status).toBe(302);
    expect(result.html).toBe("still streaming");
    expect(result.cancellationsBeforeConsumption).toBe(0);
    expect(result.cancellationCount).toBe(1);
  });

  it.each([
    ["head", "/.//assets/", "//assets/"],
    ["head", "/x/..//assets/", "//assets/"],
    ["head", "/x/%2e%2e//assets/", "//assets/"],
    ["head", "/.///assets/", "///assets/"],
    ["header", "/.//assets/", "//assets/"],
    ["header", "/x/..//assets/", "//assets/"],
    ["header", "/x/%2e%2e//assets/", "//assets/"],
    ["header", "/.///assets/", "///assets/"],
    ["body", "/.//assets/", "//assets/"],
    ["body", "/x/..//assets/", "//assets/"],
    ["body", "/x/%2e%2e//assets/", "//assets/"],
    ["body", "/.///assets/", "///assets/"],
    ["none", "/.//assets/", "//assets/"],
    ["none", "/x/..//assets/", "//assets/"],
    ["none", "/x/%2e%2e//assets/", "//assets/"],
    ["none", "/.///assets/", "///assets/"],
  ])(
    "preserves the runtime path through %s CSP, base %s and a followed link",
    async (carrier, href, path) => {
      const meta = '<meta http-equiv="content-security-policy" content="base-uri &#39;self&#39;">';
      const result = await run({
        responseHeaders:
          carrier === "header" ? { "content-security-policy": "base-uri 'self'" } : {},
        html:
          (carrier === "head" ? "<head>" + meta : carrier === "body" ? "<body>" + meta : "") +
          '<base id="base" href="' +
          href +
          '">' +
          (carrier === "head" ? "</head>" : "") +
          '<a id="next" href="notes?q=1&amp;x=2#part">go</a>',
        follow: { id: "next", attribute: "href" },
      });
      expect(result.status).toBe(200);
      expect(result.elements.base.href).toBe(result.origin + result.scope + path);
      expect(result.elements.next.href).toBe(
        result.origin + result.scope + path + "notes?q=1&x=2#part",
      );
      expect(result.followed?.status).toBe(200);
      const forwarded = new URL(result.upstream[1].url);
      expect(forwarded.origin).toBe("https://tenant.preview.invalid");
      expect(forwarded.pathname).toBe(path + "notes");
      expect(forwarded.search).toBe("?q=1&x=2");
      expect(result.upstream[1].port).toBe(8080);
    },
  );

  it("forwards an admitted double-slash POST path without changing its authority or body", async () => {
    const result = await run({
      path: "//assets/save?filter=x%2Fy&mode=2",
      method: "POST",
      body: "note=kept",
      responseHeaders: { "content-type": "application/json" },
      html: '{"ok":true}',
    });
    expect(result.status).toBe(200);
    expect(result.upstream[0].url).toBe(
      "https://tenant.preview.invalid//assets/save?filter=x%2Fy&mode=2",
    );
    expect(result.upstream[0].method).toBe("POST");
    expect(result.upstream[0].body).toBe("note=kept");
    expect(result.upstream[0].headers.cookie).toBe("theme=dark");
  });

  it("does not turn an external network-path base into a same-origin base under self CSP", async () => {
    const result = await run({
      html:
        '<head><meta http-equiv="content-security-policy" content="base-uri &#39;self&#39;">' +
        '<base id="base" href="//cdn.example/assets/"></head><a id="next" href="notes">go</a>',
      follow: { id: "next", attribute: "href" },
    });
    expect(result.status).toBe(200);
    expect(result.elements.base.href).toBe("//cdn.example/assets/");
    expect(result.elements.next.href).toBe(result.origin + result.scope + "/nested/notes");
    expect(result.followed?.status).toBe(200);
    expect(new URL(result.upstream[1].url).origin).toBe("https://tenant.preview.invalid");
  });

  it("decodes a late first base before resolving earlier attributes", async () => {
    const result = await run({
      html: '<a id="next" href="notes">next</a><base id="base" href="&#47;assets&#47;">',
    });
    expect(result.status).toBe(200);
    expect(result.elements.base.href).toBe(result.origin + result.scope + "/assets/");
    expect(result.elements.next.href).toBe(result.origin + result.scope + "/assets/notes");
  });

  it("decodes CSP meta attributes before applying an encoded base", async () => {
    const result = await run({
      html:
        '<meta http-equiv="content-security-polic&#121;" content="base-uri &#39;none&#39;">' +
        '<base href="&#47;assets&#47;"><a id="next" href="notes">next</a>',
    });
    expect(result.status).toBe(200);
    expect(result.elements.next.href).toBe(result.origin + result.scope + "/nested/notes");
  });

  it("decodes srcset separators and preserves one level of external URL entities", async () => {
    const result = await run({
      html:
        '<img id="image" srcset="&#47;small.png&Tab;1x&comma; &sol;large.png 2x">' +
        '<a id="external" href="https&colon;//example.net/notes?q=1&amp;x=2">external</a>',
    });
    const scoped = result.origin + result.scope;
    expect(result.status).toBe(200);
    expect(result.elements.image.srcset).toBe(
      scoped + "/small.png\t1x, " + scoped + "/large.png 2x",
    );
    expect(result.elements.external.href).toBe("https://example.net/notes?q=1&x=2");
  });

  it("does not entity-decode HTTP Location headers", async () => {
    const result = await run({
      status: 302,
      responseHeaders: { location: "/notes?q=&amp;x=2", "content-type": "text/plain" },
    });
    expect(result.status).toBe(302);
    expect(result.headers.location).toBe(result.origin + result.scope + "/notes?q=&amp;x=2");
  });

  it("rejects other-runtime and control destinations before releasing rewritten content", async () => {
    for (const destination of [
      "/_nabuflow/preview/v1/other-runtime/notes",
      "/_nabuflow/control/v1",
      "{{scope}}/../other-runtime/notes",
      "{{scope}}/%2e%2e/other-runtime/notes",
      "{{scope}}-other/notes",
    ]) {
      const result = await run({
        html: '<form action="' + destination + '"><button>go</button></form>',
      });
      expect(result.status).toBe(502);
      expect(JSON.parse(result.html).code).toBe("preview_navigation_scope_invalid");
      expect(result.upstream).toHaveLength(1);
    }
    const redirect = await run({
      status: 302,
      responseHeaders: { location: "/_nabuflow/control/v1", "content-type": "text/plain" },
    });
    expect(redirect.status).toBe(502);
  });

  it("normalizes app-relative traversal and encoded dots inside the active scope", async () => {
    for (const path of ["../../notes", "/a/%2e%2e/notes", "/a/../notes"]) {
      const result = await run({ html: '<a id="next" href="' + path + '">next</a>' });
      expect(result.elements.next.href).toBe(result.origin + result.scope + "/notes");
    }
  });

  it("preserves signed admission, tenant CSP and existing cookie/header filtering", async () => {
    const policy = "default-src 'self'; script-src 'none'; form-action 'self'";
    const result = await run({
      responseHeaders: [
        ["content-security-policy", policy],
        ["etag", "original"],
        ["content-length", "999"],
        ["content-encoding", "gzip"],
        ["set-cookie", "bad=secret; Domain=.mustaflow.com; Path=/"],
        ["set-cookie", "tenant_session=app; Path=/"],
      ],
    });
    expect(result.status).toBe(200);
    expect(result.redemption.status).toBe(302);
    expect(result.redemption.cookie).toContain("HttpOnly; Secure; SameSite=None;");
    expect(result.redemption.cookie).toMatch(/Path=\/$/);
    expect(result.replayStatus).toBe(409);
    expect(result.upstream[0].headers.cookie).toBe("theme=dark");
    expect(result.headers["content-security-policy"]).toContain(policy);
    expect(result.headers["content-security-policy"]).toContain(
      "frame-ancestors https://mustaflow.com https://*.mustaflow.com",
    );
    expect(result.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(result.headers["cross-origin-embedder-policy"]).toBe("require-corp");
    expect(result.headers["content-length"]).toBeUndefined();
    expect(result.headers["content-encoding"]).toBeUndefined();
    expect(result.headers.etag).toBeUndefined();
    expect(result.setCookies).toEqual(["tenant_session=app; Path=/"]);
    for (const admission of ["missing", "unredeemed", "wrong-audience", "other-runtime"]) {
      const denied = await run({ admission });
      expect(denied.status).toBe(401);
      expect(denied.upstream).toHaveLength(0);
    }
  });

  it("leaves HEAD, partial HTML, non-HTML streams and WebSocket dispatch outside HTML rewriting", async () => {
    const head = await run({
      method: "HEAD",
      status: 302,
      responseHeaders: { location: "/notes", "content-length": "123" },
    });
    expect(head.html).toBe("");
    expect(head.headers.location).toBe(head.origin + head.scope + "/notes");
    expect(head.headers["content-length"]).toBe("123");
    const partial = await run({
      status: 206,
      html: '<a href="/raw">raw</a>',
      responseHeaders: { "content-range": "bytes 0-21/100", etag: "partial" },
    });
    expect(partial.html).toBe('<a href="/raw">raw</a>');
    expect(partial.headers.etag).toBe("partial");
    const stream = await run({
      openStream: true,
      html: "data: first\n\n",
      responseHeaders: { "content-type": "text/event-stream" },
    });
    expect(stream.html).toBe("data: first\n\n");
    const ws = await run({ requestHeaders: { upgrade: "websocket", connection: "Upgrade" } });
    expect(ws.headers["x-test-websocket"]).toBe("connected");
    expect(ws.upstream).toHaveLength(0);
  });

  it("fails closed for oversized HTML instead of returning unscoped links", async () => {
    const result = await run({ oversized: true });
    expect(result.status).toBe(502);
    expect(JSON.parse(result.html).code).toBe("preview_html_too_large");
  });
});
