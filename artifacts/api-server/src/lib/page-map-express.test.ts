import { describe, expect, it, vi } from "vitest";
import { discoverSourcePageMap } from "./page-map-source";
import { discoverExpressPages } from "./page-map-express";
import { assertPageMapPlatform, PageMapAnalysisValidationError } from "./page-map-validation";
import type { BuilderFile } from "./builder";
vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: { chat: { completions: { create: vi.fn() } } },
}));
import { extractPageMapForFiles } from "./page-map";
const file = (path: string, content: string): BuilderFile => ({
  path,
  content,
  mimeType: "text/plain",
});
const fixture = () => [
  file(
    "src/index.ts",
    `import express from 'express'; import home from './home.js'; import notes from './notes.js'; import settings from './settings.js'; const app=express(); app.use('/',home); app.use('/notes',notes); app.use('/settings',settings); app.get('/healthz',(_req,res)=>res.send('ok')); app.get('/api',(_req,res)=>res.json({ok:true}));`,
  ),
  file(
    "src/html.ts",
    'export function shell(body:string){return `<!DOCTYPE html><html><body><a href="/">Home</a>${body}</body></html>`;}',
  ),
  file(
    "src/home.ts",
    'import {Router} from "express"; import {shell} from "./html.js"; const router=Router(); router.get("/",(req,res)=>{const body=`<main><a href="/notes">Notes</a><a href="/settings">Settings</a></main>`;res.send(shell(body));});export default router;',
  ),
  file(
    "src/notes.ts",
    'import {Router} from "express";import {shell} from "./html.js";const router=Router();router.get("/",(req,res)=>res.send(shell(`<main><a href="/notes/new">New</a></main>`)));router.get("/new",(req,res)=>res.send(form()));router.get("/:id",(req,res)=>res.send(shell(`<main>Note</main>`)));router.get("/:id/edit",(req,res)=>res.status(200).send(form()));router.post("/",(req,res)=>res.redirect("/notes"));function form(){const body=`<form action="/notes"><input name="title"></form>`;return shell(body);}export default router;',
  ),
  file(
    "src/settings.ts",
    'import {Router as R} from "express";import {shell} from "./html.js";const router=R();router.get("/",(req,res)=>res.send(shell(`<main>Settings</main>`)));export {router as default};',
  ),
];
const paths = (files: BuilderFile[]) =>
  discoverExpressPages(files)
    .map((page) => page.route)
    .sort();
describe("server-rendered Express Page Map", () => {
  it("discovers mounted HTML pages with TypeScript ESM .js imports, not health/API/POST endpoints", () => {
    expect(paths(fixture())).toEqual([
      "/",
      "/notes",
      "/notes/:id",
      "/notes/:id/edit",
      "/notes/new",
      "/settings",
    ]);
  });
  it("binds controls to the correct route when multiple pages share a router file", () => {
    const graph = discoverSourcePageMap(fixture());
    expect(() => assertPageMapPlatform(graph)).not.toThrow();
    const byId = new Map(graph.nodes.map((node) => [node.id, node.notes.split("\n")[0]]));
    expect(
      graph.edges.some(
        (edge) =>
          byId.get(edge.source) === "Route: /notes" &&
          byId.get(edge.target) === "Route: /notes/new",
      ),
    ).toBe(true);
    expect(
      graph.edges.some(
        (edge) =>
          byId.get(edge.source) === "Route: /notes/new" &&
          byId.get(edge.target) === "Route: /notes",
      ),
    ).toBe(true);
    expect(new Set(graph.edges.map((edge) => edge.id)).size).toBe(graph.edges.length);
  });
  it("replaces an obsolete generated SPA map while preserving manual pages, positions and notes", async () => {
    const generated = discoverSourcePageMap(fixture());
    const home = generated.nodes.find((node) => node.notes.startsWith("Route: /\n"))!;
    const manual = {
      ...home,
      id: "manual-page",
      aiGenerated: false,
      filePath: "planned.html",
      notes: "Keep this",
      planned: true,
      label: "Manual",
    };
    const existing = {
      nodes: [
        { ...home, position: { x: 123, y: 456 }, notes: "Route: /\nOwner notes" },
        { ...home, id: "obsolete-index", filePath: "index.html" },
        manual,
      ],
      edges: [],
    };
    const before = JSON.stringify(existing);
    const result = await extractPageMapForFiles(fixture(), "web", existing);
    expect(result.nodes).toHaveLength(7);
    expect(result.nodes.some((node) => node.id === "obsolete-index")).toBe(false);
    expect(result.nodes.find((node) => node.id === home.id)).toMatchObject({
      position: { x: 123, y: 456 },
      notes: "Route: /\nOwner notes",
    });
    expect(result.nodes.find((node) => node.id === "manual-page")).toEqual(manual);
    expect(JSON.stringify(existing)).toBe(before);
  });
  it("ignores unrelated Router factories, unattached routers, comments and route-shaped strings", () => {
    expect(
      paths([
        file(
          "a.ts",
          `import {Router} from 'unrelated';const router=Router();router.get('/fake',(req,res)=>res.send('<main>Fake</main>'));`,
        ),
        file(
          "b.ts",
          `import {Router} from 'express';const r=Router();r.get('/unattached',(req,res)=>res.send('<main>Detached</main>'));`,
        ),
        file(
          "c.ts",
          `import express from 'express';const app=express();const example="app.get('/example')";/* app.get('/comment',(req,res)=>res.send('<main>Fake</main>')); */`,
        ),
      ]),
    ).toEqual([]);
  });
  it("rejects computed mounts, computed paths, non-HTML responses and nested lookalike response objects", () => {
    expect(
      paths([
        file(
          "a.ts",
          `import express,{Router} from 'express';const app=express();const r=Router();app.use(getPrefix(),r);r.get('/x',(req,res)=>res.send('<main>X</main>'));app.get(getRoute(),(req,res)=>res.send('<main>X</main>'));app.get('/json',(req,res)=>res.type('json').send('<main>X</main>'));app.get('/unused',(req,res)=>{function unused(){res.send('<main>unused</main>')} res.send('ok');});`,
        ),
      ]),
    ).toEqual([]);
  });
  it("follows nested mounts and bounds mount cycles without executing code", () => {
    const result = paths([
      file(
        "a.ts",
        `import express,{Router} from 'express';const app=express();const a=Router();const b=Router();app.use('/team',a);a.use('/notes',b);b.use('/again',a);b.get('/',(req,res)=>res.send('<main>Notes</main>'));`,
      ),
    ]);
    expect(result).toEqual(["/team/notes"]);
  });
  it("does not turn dynamic template destinations or inert markup into proven navigation", () => {
    const graph = discoverSourcePageMap([
      file(
        "a.ts",
        'import express from "express";const app=express();app.get("/",(req,res)=>res.send(`<main><a href="/notes/${req.params.id}">Dynamic</a><script><a href="/hidden">Hidden</a></script></main>`));app.get("/hidden",(req,res)=>res.send("<main>Hidden</main>"));',
      ),
    ]);
    expect(graph.edges).toEqual([]);
    expect(graph.unresolvedTransitions).toHaveLength(1);
    expect(graph.unresolvedTransitions![0].transition.destination.kind).toBe("unknown");
  });
  it("does not project interpolated HTML out of script, style, attributes or comments", () => {
    const graph = discoverSourcePageMap([
      file(
        "a.ts",
        'import express from "express";const app=express();app.get("/",(req,res)=>{const nested=`<a href="/secret">Secret</a>`;res.send(`<main><script>${nested}</script><div title="${nested}">Safe</div><!-- ${nested} --></main>`);});app.get("/secret",(req,res)=>res.send("<main>Secret</main>"));',
      ),
    ]);
    expect(graph.edges).toEqual([]);
    expect(graph.unresolvedTransitions ?? []).toEqual([]);
  });
  it("returns stable declaration identities across repeat extraction and shared shell use", () => {
    const a = discoverSourcePageMap(fixture());
    const b = discoverSourcePageMap(fixture());
    expect(b).toEqual(a);
    for (const edge of a.edges)
      expect(
        edge.transition?.evidence.some((e) => e.basis === "source" && e.source?.contentSha256),
      ).toBe(true);
  });
  it("resolves variable arguments through imported helpers in the caller's lexical scope", () => {
    const pages = discoverExpressPages([
      file(
        "src/app.ts",
        'import express from "express";import {wrap} from "./html.js";const app=express();const body=`<a href="/wrong-global">Wrong</a>`;app.get("/",(req,res)=>{const body=`<a href="/target">Target</a>`;res.send(wrap(body));});',
      ),
      file(
        "src/html.ts",
        'const body=`<a href="/wrong-module">Wrong</a>`;export function wrap(body:string){return shell(body);}function shell(content:string){return `<main>${content}</main>`;}',
      ),
    ]);
    expect(pages.map((page) => page.route)).toEqual(["/"]);
    expect(pages[0].links.map((link) => link.target)).toEqual(["/target"]);
    expect(pages[0].links[0].file.path).toBe("src/app.ts");
  });
  it("follows default arguments but bounds cyclic defaults and recursive helpers", () => {
    const pages = discoverExpressPages([
      file(
        "a.ts",
        'import express from "express";const app=express();function shell(body=`<a href="/default">Default</a>`){return `<main>${body}</main>`;}function cycle(a=b,b=a){return `<main>${a}</main>`;}function loop(body){return loop(body);}app.get("/default",(req,res)=>res.send(shell()));app.get("/cycle",(req,res)=>res.send(cycle()));app.get("/loop",(req,res)=>res.send(loop(`<a href="/unused">Unused</a>`)));',
      ),
    ]);
    expect(pages.map((page) => page.route)).toEqual(["/default", "/cycle"]);
    expect(pages[0].links.map((link) => link.target)).toEqual(["/default"]);
    expect(pages[1].links).toEqual([]);
  });
  it("does not resolve shadowed or unknown arguments through a same-named global", () => {
    const pages = discoverExpressPages([
      file(
        "a.ts",
        'import express from "express";const app=express();const body=`<a href="/wrong">Wrong</a>`;function shell(body){return `<main>${body}</main>`;}function shadow(body){return shell(body);}app.get("/shadow",(req,res)=>res.send(shadow()));app.get("/unknown",(req,res)=>res.send(shell(unknown)));app.get("/mutable",(req,res)=>{let body=`<a href="/mutable">Mutable</a>`;res.send(shell(body));});',
      ),
    ]);
    expect(pages.map((page) => page.route)).toEqual(["/shadow", "/unknown", "/mutable"]);
    expect(pages.every((page) => page.links.length === 0)).toBe(true);
  });
  it("does not turn unused helper arguments or inert interpolations into rendered controls", () => {
    const pages = discoverExpressPages([
      file(
        "a.ts",
        'import express from "express";const app=express();function unused(body){return `<main>Safe</main>`;}function inert(body){return `<main><script>${body}</script><style>${body}</style><div title="${body}">Safe</div><!-- ${body} --><template>${body}</template></main>`;}app.get("/unused",(req,res)=>{const body=`<a href="/hidden">Hidden</a>`;res.send(unused(body));});app.get("/inert",(req,res)=>{const body=`<a href="/hidden">Hidden</a>`;res.send(inert(body));});',
      ),
    ]);
    expect(pages.map((page) => page.route)).toEqual(["/unused", "/inert"]);
    expect(pages.every((page) => page.links.length === 0)).toBe(true);
  });
  it("ignores missing, dynamic and non-HTML content types without crashing", () => {
    const files = [
      file(
        "a.ts",
        'import express from "express";const app=express();app.get("/missing",(req,res)=>res.type().send("<main>Missing</main>"));app.get("/dynamic",(req,res)=>res.type(getType()).send("<main>Dynamic</main>"));app.get("/json",(req,res)=>res.type("json").send("<main>JSON</main>"));app.get("/html",(req,res)=>res.type("html").send("<main>HTML</main>"));app.get("/mime",(req,res)=>res.status(200).type("text/html").send("<main>MIME</main>"));app.get("/status",(req,res)=>res.status(200).send("<main>Status</main>"));',
      ),
    ];
    expect(() => discoverSourcePageMap(files)).not.toThrow();
    expect(paths(files)).toEqual(["/html", "/mime", "/status"]);
  });

  it("deduplicates repeated acyclic mounts, including graphs with no page output", () => {
    const declarations = Array.from({ length: 15 }, (_, i) => "const r" + i + "=Router();").join(
      "",
    );
    const mounts = Array.from({ length: 14 }, (_, i) =>
      Array.from({ length: 10 }, () => "r" + i + ".use('/',r" + (i + 1) + ");").join(""),
    ).join("");
    expect(
      paths([
        file(
          "a.ts",
          "import express,{Router} from 'express';const app=express();" +
            declarations +
            "app.use('/',r0);" +
            mounts,
        ),
      ]),
    ).toEqual([]);
  });
  it("rejects total mount-work exhaustion without returning a partial replacement map", async () => {
    const declarations = Array.from({ length: 15 }, (_, i) => "const r" + i + "=Router();").join(
      "",
    );
    const mounts = Array.from(
      { length: 14 },
      (_, i) => "r" + i + ".use('/a',r" + (i + 1) + ");r" + i + ".use('/b',r" + (i + 1) + ");",
    ).join("");
    const files = [
      file(
        "a.ts",
        "import express,{Router} from 'express';const app=express();" +
          declarations +
          "app.use('/',r0);" +
          mounts,
      ),
    ];
    const saved = discoverSourcePageMap(fixture());
    const before = JSON.stringify(saved);
    expect(() => discoverSourcePageMap(files)).toThrow(PageMapAnalysisValidationError);
    await expect(extractPageMapForFiles(files, "web", saved)).rejects.toThrow(
      PageMapAnalysisValidationError,
    );
    expect(JSON.stringify(saved)).toBe(before);
  });
  it("keeps module constants in module scope and sibling block bindings out of the caller", () => {
    const pages = discoverExpressPages([
      file(
        "a.ts",
        'import express from "express";const app=express();const target=\'<a href="/right">Right</a>\';const body=target;app.get("/module",(req,res)=>{const target=\'<a href="/wrong">Wrong</a>\';res.send(body);});app.get("/block",(req,res)=>{if(req.query.x){const body=\'<a href="/wrong">Wrong</a>\';}res.send(body);});app.get("/inside",(req,res)=>{if(req.query.x){const body=\'<a href="/inside">Inside</a>\';res.send(body);}});',
      ),
    ]);
    expect(pages.map((page) => page.links.map((link) => link.target))).toEqual([
      ["/right"],
      ["/right"],
      ["/inside"],
    ]);
  });
  it("retains an outer helper closure without substituting a same-named inner local", () => {
    const pages = discoverExpressPages([
      file(
        "a.ts",
        'import express from "express";const app=express();app.get("/",(req,res)=>{const body=\'<a href="/outer">Outer</a>\';function read(){return body;}function nested(){const body=\'<a href="/wrong">Wrong</a>\';return read();}res.send(nested());});',
      ),
    ]);
    expect(pages[0].links.map((link) => link.target)).toEqual(["/outer"]);
  });
  it("applies an interpolated document base to all literal controls", () => {
    const graph = discoverSourcePageMap([
      file(
        "a.ts",
        'import express from "express";const app=express();function shell(body){return `<html><head><base href="https://outside.example/"></head><body>${body}</body></html>`;}app.get("/",(req,res)=>res.send(shell(\'<a href="/target">Target</a>\')));app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      ),
    ]);
    expect(graph.edges).toEqual([]);
    expect(graph.unresolvedTransitions).toHaveLength(1);
    expect(graph.unresolvedTransitions![0].transition.destination.kind).toBe("unknown");
  });
  it("composes static markup before deciding whether a control is inert", () => {
    const graph = discoverSourcePageMap([
      file(
        "a.ts",
        'import express from "express";const app=express();app.get("/",(req,res)=>{const start="<script>";res.send(`<main>${start}<a href="/target">Target</a></script></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      ),
    ]);
    expect(graph.edges).toEqual([]);
    expect(graph.unresolvedTransitions ?? []).toEqual([]);
  });
  it("leaves destinations uncertain when unknown interpolation can change document parsing", () => {
    const graph = discoverSourcePageMap([
      file(
        "a.ts",
        'import express from "express";const app=express();app.get("/",(req,res)=>res.send(`<main>${req.query.markup}<a href="/target">Target</a></main>`));app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      ),
    ]);
    expect(graph.edges).toEqual([]);
    expect(graph.unresolvedTransitions![0].transition.destination.kind).toBe("unknown");
  });
  it("keeps the declared document slash separate from canonical page identity", () => {
    const graph = discoverSourcePageMap([
      file(
        "a.ts",
        'import express from "express";const app=express();app.get("/guide/",(req,res)=>res.send(\'<main><a href="next">Next</a><a href="/next">Absolute</a></main>\'));app.get("/guide/next",(req,res)=>res.send("<main>Next</main>"));app.get("/next",(req,res)=>res.send("<main>Absolute</main>"));',
      ),
    ]);
    const routes = new Map(graph.nodes.map((node) => [node.id, node.notes.split("\n")[0]]));
    expect(graph.edges.map((edge) => [routes.get(edge.source), routes.get(edge.target)])).toEqual([
      ["Route: /guide", "Route: /guide/next"],
      ["Route: /guide", "Route: /next"],
    ]);
  });
  it("rejects explicit non-HTML and bodyless response state outside or inside send chains", () => {
    expect(
      paths([
        file(
          "a.ts",
          'import express from "express";const app=express();app.get("/plain",(req,res)=>{res.type("text/plain");res.send("<main>Text</main>");});app.get("/header",(req,res)=>{res.setHeader("Content-Type","application/json");res.send("<main>JSON</main>");});app.get("/204",(req,res)=>res.status(204).send("<main>Empty</main>"));app.get("/205",(req,res)=>res.status(205).send("<main>Reset</main>"));app.get("/304",(req,res)=>{res.statusCode=304;res.send("<main>Cached</main>");});app.get("/dynamic",(req,res)=>{res.status(getStatus());res.send("<main>Unknown</main>");});app.get("/valid",(req,res)=>{res.type("text/html");res.status(200);res.send("<main>HTML</main>");});app.get("/not-found",(req,res)=>res.status(404).send("<main>Not found</main>"));',
        ),
      ]),
    ).toEqual(["/not-found", "/valid"]);
  });

  it.each([
    {
      id: "finite-label",
      body: "res.send(`<main>${req.query.x ? 'A' : 'B'}<a href=\"/target\">Go</a></main>`);",
      expectedEdges: 1,
      defect: true,
    },
    {
      id: "alternative-duplicate",
      body: "res.send(`<main>${req.query.x ? '<div>A</div>' : '<div>B</div>'}<a href=\"/target\">Go</a></main>`);",
      expectedEdges: 1,
      defect: true,
    },
    {
      id: "bracket-type",
      body: "res['type']('text/plain');res.send('<main><a href=\"/target\">Go</a></main>');",
      expectedEdges: 0,
      defect: true,
    },
    {
      id: "bracket-status",
      body: "res['statusCode']=204;res.send('<main><a href=\"/target\">Go</a></main>');",
      expectedEdges: 0,
      defect: true,
    },
    {
      id: "response-alias",
      body: "const reply=res;reply.type('text/plain');res.send('<main><a href=\"/target\">Go</a></main>');",
      expectedEdges: 0,
      defect: true,
    },
    {
      id: "destructured-string",
      body: "const [body]='<a href=\"/target\">Go</a>';res.send(body);",
      expectedEdges: 0,
      defect: true,
    },
    {
      id: "uncalled-method",
      pre: "function page(){const unused={render(){return '<a href=\"/target\">Ghost</a>';}};return '<main>Safe</main>';}",
      body: "res.send(page());",
      expectedEdges: 0,
      defect: true,
    },
    {
      id: "method-shadow",
      body: "const unused={render(res){return 'unused';}};res.send('<main><a href=\"/target\">Go</a></main>');",
      expectedEdges: 1,
      defect: true,
    },
    {
      id: "parameter-reassigned",
      pre: "function page(body){body='<main>Safe</main>';return body;}",
      body: "res.send(page('<a href=\"/target\">Ghost</a>'));",
      expectedEdges: 0,
      defect: true,
    },
    {
      id: "external-unknown-markup",
      body: 'res.send(`<main>${req.query.markup}<a href="https://outside.example/x">Go</a></main>`);',
      expectedEdges: 0,
      expectedExternal: 0,
      defect: true,
    },
    {
      id: "control-constant-label",
      body: "res.send('<main>A<a href=\"/target\">Go</a></main>');",
      expectedEdges: 1,
      defect: false,
    },
    {
      id: "control-dot-type",
      body: "res.type('text/plain');res.send('<main><a href=\"/target\">Go</a></main>');",
      expectedEdges: 0,
      defect: false,
    },
    {
      id: "control-dot-status",
      body: "res.statusCode=204;res.send('<main><a href=\"/target\">Go</a></main>');",
      expectedEdges: 0,
      defect: false,
    },
    {
      id: "control-html404",
      body: "res.status(404).type('html').send('<main><a href=\"/target\">Go</a></main>');",
      expectedEdges: 1,
      defect: false,
    },
    {
      id: "control-simple-binding",
      body: "const body='<a href=\"/target\">Go</a>';res.send(body);",
      expectedEdges: 1,
      defect: false,
    },
    {
      id: "control-ordinary-function",
      pre: "function page(){function unused(){return '<a href=\"/target\">Ghost</a>';}return '<main>Safe</main>';}",
      body: "res.send(page());",
      expectedEdges: 0,
      defect: false,
    },
    {
      id: "control-unchanged-parameter",
      pre: "function page(body){return body;}",
      body: "res.send(page('<a href=\"/target\">Go</a>'));",
      expectedEdges: 1,
      defect: false,
    },
    {
      id: "control-literal-external",
      body: "res.send('<main><a href=\"https://outside.example/x\">Go</a></main>');",
      expectedEdges: 0,
      expectedExternal: 1,
      defect: false,
    },
  ])("preserves source attribution: $id", (item) => {
    const source =
      'import express from "express";const app=express();' +
      (item.pre ?? "") +
      'app.get("/",(req,res)=>{' +
      item.body +
      '});app.get("/target",(req,res)=>res.send("<main>Target</main>"));';
    const graph = discoverSourcePageMap([file("index.ts", source)]);
    const routes = new Map(
      graph.nodes.map((node) => [node.id, node.notes.split("\n")[0].replace("Route: ", "")]),
    );
    expect(
      graph.edges.filter(
        (edge) => routes.get(edge.source) === "/" && routes.get(edge.target) === "/target",
      ),
    ).toHaveLength(item.expectedEdges);
    if (item.expectedExternal !== undefined)
      expect(
        (graph.unresolvedTransitions ?? []).filter(
          (edge) =>
            edge.source !== undefined &&
            routes.get(edge.source) === "/" &&
            edge.transition.destination.kind === "external",
        ),
      ).toHaveLength(item.expectedExternal);
  });

  it("retains static navigation through a bilingual shell and declared-array rendering", () => {
    const graph = discoverSourcePageMap([
      file(
        "index.ts",
        "import express from \"express\";const app=express();function escapeText(str:string){return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;');}function shell(body,lang){const dir=lang==='ar'?'rtl':'ltr';const active=(p)=>p==='/'?' class=\"active\"':' class=\"nav\"';return `<html lang=\"${lang}\" dir=\"${dir}\"><body><a href=\"/notes\"${active('/notes')}>${escapeText(lang)}</a>${body}</body></html>`;}app.get(\"/\",(req,res)=>{const lang=req.query.lang==='ar'?'ar':'en';let notes:Array<{title:string}>=[];notes=loadRows();const cards=notes.length?notes.map(note=>`<div>${escapeText(String(note.title))}</div>`).join(''):'<p>Empty</p>';res.send(shell(`<main><a href=\"/notes/new\">New</a>${cards}</main>`,lang));});app.get(\"/notes\",(req,res)=>res.send(\"<main>Notes</main>\"));app.get(\"/notes/new\",(req,res)=>res.send(\"<main>New</main>\"));",
      ),
    ]);
    const routes = new Map(graph.nodes.map((node) => [node.id, node.notes.split("\n")[0]]));
    expect(graph.edges.map((edge) => routes.get(edge.target)).sort()).toEqual([
      "Route: /notes",
      "Route: /notes/new",
    ]);
  });

  it.each([
    "function escapeText(str){return str;}",
    "function escapeText(str){return str.replace(/</,'&lt;');}",
    "function escapeText(str){return str.replace(/</g,'&lt;').replace(/&/g,'<');}",
  ])("does not trust an escaping helper by name or incomplete replacements", (helper) => {
    const source =
      'import express from "express";const app=express();' +
      helper +
      'app.get("/",(req,res)=>res.send(`<main>${escapeText(String(req.query.text))}<a href="/target">Go</a></main>`));app.get("/target",(req,res)=>res.send("<main>Target</main>"));';
    const graph = discoverSourcePageMap([file("index.ts", source)]);
    expect(graph.edges).toEqual([]);
    expect(graph.unresolvedTransitions?.[0].transition.destination.kind).toBe("unknown");
  });

  it("does not treat a lookalike map/join object as a declared array", () => {
    const graph = discoverSourcePageMap([
      file(
        "index.ts",
        'import express from "express";const app=express();const rows={map(){return {join(){return "<script>";}}}};app.get("/",(req,res)=>res.send(`<main>${rows.map(x=>"<span>Safe</span>").join("")}<a href="/target">Go</a></main>`));app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      ),
    ]);
    expect(graph.edges).toEqual([]);
  });
  it("does not use escaped text as a dynamic tag name", () => {
    const graph = discoverSourcePageMap([
      file(
        "index.ts",
        "import express from \"express\";const app=express();function escapeText(str:string){return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;');}app.get(\"/\",(req,res)=>res.send(`<${escapeText(String(req.query.tag))}><a href=\"/target\">Go</a></script>`));app.get(\"/target\",(req,res)=>res.send(\"<main>Target</main>\"));",
      ),
    ]);
    expect(graph.edges).toEqual([]);
  });
  it("retains genuinely repeated controls while deduplicating alternative documents", () => {
    const graph = discoverSourcePageMap([
      file(
        "index.ts",
        'import express from "express";const app=express();function control(){return \'<a href="/target">Go</a>\';}app.get("/",(req,res)=>res.send(`<main>${req.query.x?"<div>A</div>":"<div>B</div>"}${control()}${control()}</main>`));app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      ),
    ]);
    expect(graph.edges).toHaveLength(2);
    expect(new Set(graph.edges.map((edge) => edge.id)).size).toBe(2);
  });

  it.each([
    {
      id: "object-replace",
      body: "const value={replace(){return '<script>';}};res.send(`<main>${value.replace(/</g,'&lt;')}<a href=\"/target\">Go</a></script></main>`);",
      expectedEdges: 0,
    },
    {
      id: "array-alias-override",
      body: "const rows=[0];const alias=rows;alias.map=()=>['<script>'];res.send(`<main>${rows.map(()=>'<span>Safe</span>').join('')}<a href=\"/target\">Go</a></script></main>`);",
      expectedEdges: 0,
    },
    {
      id: "map-callback-default",
      body: "const rows=['<script>'];res.send(`<main>${rows.map((s='<span>Safe</span>')=>s).join('')}<a href=\"/target\">Go</a></script></main>`);",
      expectedEdges: 0,
    },
    {
      id: "invoked-response-closure",
      body: '(()=>res.type(\'text/plain\'))();res.send("<main><a href=\\"/target\\">Go</a></main>");',
      expectedEdges: 0,
    },
    {
      id: "unconstructed-instance-field",
      body: 'class Unused{body=res.send("<main><a href=\\"/target\\">Go</a></main>");}res.send(\'ok\');',
      expectedEdges: 0,
    },
    {
      id: "native-string-control",
      body: "res.send(`<main>${'hello'.replace(/</g,'&lt;')}<a href=\"/target\">Go</a></main>`);",
      expectedEdges: 1,
    },
    {
      id: "native-array-control",
      body: "const rows=[0];res.send(`<main>${rows.map(()=>'<span>Safe</span>').join('')}<a href=\"/target\">Go</a></main>`);",
      expectedEdges: 1,
    },
    {
      id: "ignored-map-argument-control",
      body: "const rows=['<script>'];res.send(`<main>${rows.map(()=>'<span>Safe</span>').join('')}<a href=\"/target\">Go</a></main>`);",
      expectedEdges: 1,
    },
    {
      id: "uncalled-closure-control",
      body: 'const ignored=()=>res.type(\'text/plain\');res.send("<main><a href=\\"/target\\">Go</a></main>");',
      expectedEdges: 1,
    },
    {
      id: "static-class-field-control",
      body: 'class Evaluated{static body=res.send("<main><a href=\\"/target\\">Go</a></main>");}res.send(\'ok\');',
      expectedEdges: 1,
    },
    {
      id: "native-string-annotation-does-not-prove-object",
      body: "function safe(str:string){return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;');}const object={replace(){return '<script>';}};res.send(`<main>${safe(object)}<a href=\"/target\">Go</a></script></main>`);",
      expectedEdges: 0,
    },
    {
      id: "unknown-replace-input-not-native-proof",
      body: "function safe(str:string){return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;');}res.send(`<main>${safe(req.query.value)}<a href=\"/target\">Go</a></main>`);",
      expectedEdges: 0,
    },
    {
      id: "coerced-unknown-string-control",
      body: "function safe(str:string){return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;');}res.send(`<main>${safe(String(req.query.value))}<a href=\"/target\">Go</a></main>`);",
      expectedEdges: 1,
    },
    {
      id: "array-method-defineproperty",
      body: "const rows=[0];const alias=rows;Object.defineProperty(alias,'map',{value:()=>['<script>']});res.send(`<main>${rows.map(()=>'<span>Safe</span>').join('')}<a href=\"/target\">Go</a></script></main>`);",
      expectedEdges: 0,
    },
    {
      id: "named-response-closure",
      body: "function change(){res.statusCode=204;}change();res.send('<main><a href=\"/target\">Go</a></main>');",
      expectedEdges: 0,
    },
    {
      id: "html-response-closure-control",
      body: '(()=>res.type("html"))();res.send(\'<main><a href="/target">Go</a></main>\');',
      expectedEdges: 1,
    },
    {
      id: "eight-coerced-safe-choices",
      body: "function safe(str:string){return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;');}res.send(`<main>${safe(String(req.query.text) || 'fallback')}${safe(String(req.query.text) || 'fallback')}${safe(String(req.query.text) || 'fallback')}${safe(String(req.query.text) || 'fallback')}${safe(String(req.query.text) || 'fallback')}${safe(String(req.query.text) || 'fallback')}${safe(String(req.query.text) || 'fallback')}${safe(String(req.query.text) || 'fallback')}<a href=\"/target\">Go</a></main>`);",
      expectedEdges: 1,
    },
    {
      id: "eight-coerced-single-values",
      body: "function safe(str:string){return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;');}res.send(`<main>${safe(String(req.query.text))}${safe(String(req.query.text))}${safe(String(req.query.text))}${safe(String(req.query.text))}${safe(String(req.query.text))}${safe(String(req.query.text))}${safe(String(req.query.text))}${safe(String(req.query.text))}<a href=\"/target\">Go</a></main>`);",
      expectedEdges: 1,
    },
    {
      id: "constant-object-label-control",
      body: "function safe(str:string){return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;');}const t=req.query.ar?{label:\"Arabic\"}:{label:\"English\"};res.send(`<main>${safe(t.label)}<a href=\"/target\">Go</a></main>`);",
      expectedEdges: 1,
    },
    {
      id: "constant-null-conditional-control",
      body: "function safe(str:string){return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;');}function page(error){return `<main>${error?`<div>${safe(error)}</div>`:\"\"}<a href=\"/target\">Go</a></main>`;}res.send(page(null));",
      expectedEdges: 1,
    },
  ])("keeps native dispatch and execution boundaries: $id", (item) => {
    const source =
      'import express from "express";const app=express();app.get("/",(req,res)=>{' +
      item.body +
      '});app.get("/target",(req,res)=>res.send("<main>Target</main>"));';
    const graph = discoverSourcePageMap([file("index.ts", source)]);
    const routes = new Map(
      graph.nodes.map((node) => [node.id, node.notes.split("\n")[0].replace("Route: ", "")]),
    );
    expect(
      graph.edges.filter(
        (edge) => routes.get(edge.source) === "/" && routes.get(edge.target) === "/target",
      ),
    ).toHaveLength(item.expectedEdges);
  });
  it.each([
    {
      id: "constructed-instance-field",
      source:
        'import express from "express";const app=express();app.get("/",(req,res)=>{class Change{body=res.type("text/plain");}new Change();res.send("<main><a href=\\"/target\\">Go</a></main>");});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "constructed-constructor",
      source:
        'import express from "express";const app=express();app.get("/",(req,res)=>{class Change{constructor(){res.type("text/plain");}}new Change();res.send("<main><a href=\\"/target\\">Go</a></main>");});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "unconstructed-field-control",
      source:
        'import express from "express";const app=express();app.get("/",(req,res)=>{class Unused{body=res.type("text/plain");}res.send("<main><a href=\\"/target\\">Go</a></main>");});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "static-field-state-control",
      source:
        'import express from "express";const app=express();app.get("/",(req,res)=>{class Change{static body=res.type("text/plain");}res.send("<main><a href=\\"/target\\">Go</a></main>");});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "single-neutral-attribute-summary",
      source:
        'import express from "express";const app=express();app.get("/",(req,res)=>{function active(){return req.query.x?\' class="active"\':\' class="link"\';}res.send(`<main><a href="/target"${active()}>Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "global-string-method-override",
      source:
        'import express from "express";const app=express();globalThis.String.prototype.replace=()=>\'<script>\';app.get("/",(req,res)=>{res.send(`<main>${"x".replace(/</g,"&lt;")}<a href="/target">Go</a></script></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "global-string-prototype-alias",
      source:
        'import express from "express";const app=express();const prototype=globalThis.String.prototype;prototype.replace=()=>\'<script>\';app.get("/",(req,res)=>{res.send(`<main>${"x".replace(/</g,"&lt;")}<a href="/target">Go</a></script></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "global-array-method-override",
      source:
        'import express from "express";const app=express();globalThis.Array.prototype.map=()=>[\'<script>\'];app.get("/",(req,res)=>{const rows=[0];res.send(`<main>${rows.map(()=>"<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "constructed-class-alias",
      source:
        'import express from "express";const app=express();app.get("/",(req,res)=>{class Change{constructor(){res.type("text/plain");}}const Alias=Change;new Alias();res.send(\'<main><a href="/target">Go</a></main>\');});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "constructed-factory-return",
      source:
        'import express from "express";const app=express();app.get("/",(req,res)=>{class Change{body=res.type("text/plain");}const pick=()=>Change;const Alias=pick();new Alias();res.send(\'<main><a href="/target">Go</a></main>\');});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "constructed-inline-class",
      source:
        'import express from "express";const app=express();app.get("/",(req,res)=>{new(class{constructor(){res.type("text/plain");}})();res.send(\'<main><a href="/target">Go</a></main>\');});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "constructed-helper-capture",
      source:
        'import express from "express";const app=express();app.get("/",(req,res)=>{function change(){res.statusCode=204;}class Change{constructor(){change();}}new Change();res.send(\'<main><a href="/target">Go</a></main>\');});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "unconstructed-constructor-control",
      source:
        'import express from "express";const app=express();app.get("/",(req,res)=>{class Unused{constructor(){res.type("text/plain");}}res.send(\'<main><a href="/target">Go</a></main>\');});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "noncapturing-construction-control",
      source:
        'import express from "express";const app=express();app.get("/",(req,res)=>{class Safe{value=1;constructor(){this.value=2;}}new Safe();res.send(\'<main><a href="/target">Go</a></main>\');});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "global-computed-string",
      source:
        'import express from "express";const app=express();globalThis["String"].prototype.replace=()=>"<script>";app.get("/",(req,res)=>{res.send(`<main>${"x".replace(/</g,"&lt;")}<a href="/target">Go</a></script></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "global-object-alias",
      source:
        'import express from "express";const app=express();const globals=globalThis;globals.String.prototype.replace=()=>"<script>";app.get("/",(req,res)=>{res.send(`<main>${"x".replace(/</g,"&lt;")}<a href="/target">Go</a></script></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "global-array-prototype-alias",
      source:
        'import express from "express";const app=express();const prototype=globalThis.Array.prototype;prototype.map=()=>["<script>"];app.get("/",(req,res)=>{const rows=[0];res.send(`<main>${rows.map(()=>"<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "global-reflective-string-replacement",
      source:
        'import express from "express";const app=express();Reflect.set(globalThis,"String",{prototype:{}});app.get("/",(req,res)=>{res.send(`<main>${"x".replace(/</g,"&lt;")}<a href="/target">Go</a></script></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "global-reflective-prototype-write",
      source:
        'import express from "express";const app=express();Object.defineProperty(globalThis.String.prototype,"replace",{value:()=>"<script>"});app.get("/",(req,res)=>{res.send(`<main>${"x".replace(/</g,"&lt;")}<a href="/target">Go</a></script></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "node-global-string-write",
      source:
        'import express from "express";const app=express();global.String.prototype.replace=()=>"<script>";app.get("/",(req,res)=>{res.send(`<main>${"x".replace(/</g,"&lt;")}<a href="/target">Go</a></script></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "unrelated-global-property-control",
      source:
        'import express from "express";const app=express();globalThis.appLabel="NabuFlow";app.get("/",(req,res)=>{res.send(`<main>${"x".replace(/</g,"&lt;")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "unrelated-reflective-global-control",
      source:
        'import express from "express";const app=express();Reflect.set(globalThis,"appLabel","NabuFlow");app.get("/",(req,res)=>{res.send(`<main>${"x".replace(/</g,"&lt;")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "shadowed-global-constructor-control",
      source:
        'import express from "express";const app=express();const globalThis={String:{prototype:{}}};globalThis.String.prototype.replace=()=>"<script>";app.get("/",(req,res)=>{res.send(`<main>${"x".replace(/</g,"&lt;")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "generator-not-string-return-proof",
      source:
        'import express from "express";const app=express();app.get("/",(req,res)=>{function* value(){return "safe";}res.send(`<main>${value().replace(/</g,"&lt;")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
  ])("preserves summaries and construction/native boundaries: $id", (item) => {
    const graph = discoverSourcePageMap([file("index.ts", item.source)]);
    const routes = new Map(
      graph.nodes.map((node) => [node.id, node.notes.split("\n")[0].replace("Route: ", "")]),
    );
    expect(
      graph.edges.filter(
        (edge) => routes.get(edge.source) === "/" && routes.get(edge.target) === "/target",
      ),
    ).toHaveLength(item.expectedEdges);
  });
  it.each([
    {
      id: "native-literal-split-elements",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags="a,b".split(",");res.send(`<main>${tags.map(tag=>`<span>${escapeText(tag)}</span>`).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "native-string-split-filter-elements",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags=String(req.query.tags||"").split(",").filter(Boolean);res.send(`<main>${tags.map(tag=>`<span>${escapeText(tag)}</span>`).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "coerced-map-item-control",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags=String(req.query.tags||"").split(",").filter(Boolean);res.send(`<main>${tags.map(tag=>`<span>${escapeText(String(tag))}</span>`).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "annotation-alone-negative",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags:string[]=loadRows();res.send(`<main>${tags.map(tag=>`<span>${escapeText(tag)}</span>`).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "split-lookalike-negative",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const source={split(){return [{replace(){return "<script>";}}];}};const tags=source.split(",");res.send(`<main>${tags.map(tag=>`<span>${escapeText(tag)}</span>`).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "mutated-split-elements-negative",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags="a,b".split(",");tags.fill({replace(){return "<script>";}});res.send(`<main>${tags.map(tag=>`<span>${escapeText(tag)}</span>`).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "alias-mutated-elements-negative",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags="a,b".split(",");const alias=tags;alias[0]={replace(){return "<script>";}};res.send(`<main>${tags.map(tag=>`<span>${escapeText(tag)}</span>`).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "shadowed-filter-predicate-negative",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{function Boolean(value,index,all){all[index+1]={replace(){return "<script>";}};return true;}const tags="a,b".split(",").filter(Boolean);res.send(`<main>${tags.map(tag=>`<span>${escapeText(tag)}</span>`).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "overridden-global-filter-predicate-negative",
      source:
        'import express from "express";const app=express();globalThis.Boolean=(value,index,all)=>{all[index+1]={replace(){return "<script>";}};return true;};function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags="a,b".split(",").filter(Boolean);res.send(`<main>${tags.map(tag=>`<span>${escapeText(tag)}</span>`).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "constant-alias-control",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const original="a,b".split(",");const tags=original;res.send(`<main>${tags.map(tag=>`<span>${escapeText(tag)}</span>`).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "item-alias-through-helper-control",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags="a,b".split(",");res.send(`<main>${tags.map(tag=>{const copy=tag;return `<span>${escapeText(copy)}</span>`;}).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "raw-string-item-remains-unknown",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags=String(req.query.tags).split(",");res.send(`<main>${tags.map(tag=>`<span>${tag}</span>`).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "regex-captures-not-supported",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags="a,b".split(/(,)|(x)/);res.send(`<main>${tags.map(tag=>`<span>${escapeText(tag)}</span>`).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "custom-separator-not-supported",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const separator={[Symbol.split](){return [{replace(){return "<script>";}}];}};const tags="a,b".split(separator);res.send(`<main>${tags.map(tag=>`<span>${escapeText(tag)}</span>`).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "callback-item-reassignment",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags="a,b".split(",");res.send(`<main>${tags.map(tag=>{tag={replace(){return "<script>";}};return `<span>${escapeText(tag)}</span>`;}).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "callback-whole-array-mutation",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags="a,b".split(",");res.send(`<main>${tags.map((tag,index,all)=>{all[index+1]={replace(){return "<script>";}};return `<span>${escapeText(tag)}</span>`;}).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "index-not-a-string",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags="a,b".split(",");res.send(`<main>${tags.map((tag,index)=>`<span>${escapeText(index)}</span>`).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "whole-array-not-a-string",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags="a,b".split(",");res.send(`<main>${tags.map((tag,index,all)=>`<span>${escapeText(all)}</span>`).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "supplied-item-does-not-activate-default",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags="a,b".split(",");res.send(`<main>${tags.map((tag="<script>")=>`<span>${escapeText(tag)}</span>`).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "supplied-index-does-not-activate-default",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags="a,b".split(",");res.send(`<main>${tags.map((tag,index="safe")=>`<span>${escapeText(index)}</span>`).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "escaped-array-not-proven",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags="a,b".split(",");mutate(tags);res.send(`<main>${tags.map(tag=>`<span>${escapeText(tag)}</span>`).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "alias-method-mutation-not-proven",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags="a,b".split(",");const alias=tags;alias.fill({replace(){return "<script>";}});res.send(`<main>${tags.map(tag=>`<span>${escapeText(tag)}</span>`).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "native-split-override-not-proven",
      source:
        'import express from "express";const app=express();String.prototype.split=()=>[{replace(){return "<script>";}}];function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags="a,b".split(",");res.send(`<main>${tags.map(tag=>`<span>${escapeText(tag)}</span>`).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "native-filter-override-not-proven",
      source:
        'import express from "express";const app=express();Array.prototype.filter=()=>[{replace(){return "<script>";}}];function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags="a,b".split(",").filter(Boolean);res.send(`<main>${tags.map(tag=>`<span>${escapeText(tag)}</span>`).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "reflective-boolean-override-not-proven",
      source:
        'import express from "express";const app=express();Reflect.set(globalThis,"Boolean",(value,index,all)=>{all[index+1]={replace(){return "<script>";}};return true;});function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags="a,b".split(",").filter(Boolean);res.send(`<main>${tags.map(tag=>`<span>${escapeText(tag)}</span>`).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
  ])("tracks only proven native string elements: $id", (item) => {
    const graph = discoverSourcePageMap([file("index.ts", item.source)]);
    const routes = new Map(
      graph.nodes.map((node) => [node.id, node.notes.split("\n")[0].replace("Route: ", "")]),
    );
    expect(
      graph.edges.filter(
        (edge) => routes.get(edge.source) === "/" && routes.get(edge.target) === "/target",
      ),
    ).toHaveLength(item.expectedEdges);
  });
  it.each([
    {
      id: "property-name-collision",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags=String(req.query.tags||"").split(",").filter(Boolean);res.send(`<main>${tags.map(tag=>`<span>${escapeText(tag)}</span>`).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "bracket-property-control",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags=String(req.query[\'tags\']||"").split(",").filter(Boolean);res.send(`<main>${tags.map(tag=>`<span>${escapeText(tag)}</span>`).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "object-property-name-collision",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags="a,b".split(",");const metadata={tags:"label"};res.send(`<main>${tags.map(tag=>`<span>${escapeText(tag)}</span>`).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "object-method-name-collision",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags="a,b".split(",");const metadata={tags(){return "label";}};res.send(`<main>${tags.map(tag=>`<span>${escapeText(tag)}</span>`).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "object-binding-key-collision",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags="a,b".split(",");const {tags:label}=req.query;res.send(`<main>${tags.map(tag=>`<span>${escapeText(tag)}</span>`).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "real-shorthand-escape-control",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags="a,b".split(",");const metadata={tags};res.send(`<main>${tags.map(tag=>`<span>${escapeText(tag)}</span>`).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "rest-exposes-whole-array",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags="a,b".split(",");res.send(`<main>${tags.map((tag,...rest)=>{rest[1][1]={replace(){return "<script>";}};return `<span>${escapeText(tag)}</span>`;}).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "arguments-exposes-whole-array",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags="a,b".split(",");res.send(`<main>${tags.map(function(tag){arguments[2][1]={replace(){return "<script>";}};return `<span>${escapeText(tag)}</span>`;}).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "unused-rest-control",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags="a,b".split(",");res.send(`<main>${tags.map((tag,...unused)=>`<span>${escapeText(tag)}</span>`).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "nested-arrow-arguments-capture",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags="a,b".split(",");res.send(`<main>${tags.map(function(tag){const mutate=()=>{arguments[2][1]={replace(){return "<script>";}};};mutate();return `<span>${escapeText(tag)}</span>`;}).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "nested-ordinary-arguments-control",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags="a,b".split(",");res.send(`<main>${tags.map(function(tag){function local(){return arguments.length;}local("safe");return `<span>${escapeText(tag)}</span>`;}).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "arguments-property-name-control",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags="a,b".split(",");res.send(`<main>${tags.map(function(tag){const count=req.query.arguments;const metadata={arguments:"label"};return `<span>${escapeText(tag)}</span>`;}).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "arguments-computed-property-capture",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags="a,b".split(",");res.send(`<main>${tags.map(function(tag){const metadata={[arguments[2][1]={replace(){return "<script>";}}]:"label"};return `<span>${escapeText(tag)}</span>`;}).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "non-value-property-write-control",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags="a,b".split(",");const metadata={};metadata.tags="label";res.send(`<main>${tags.map(tag=>`<span>${escapeText(tag)}</span>`).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "non-value-label-control",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags="a,b".split(",");tags:{break tags;}res.send(`<main>${tags.map(tag=>`<span>${escapeText(tag)}</span>`).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "computed-array-property-remains-escape",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags="a,b".split(",");const metadata={[tags]:"label"};res.send(`<main>${tags.map(tag=>`<span>${escapeText(tag)}</span>`).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "getter-name-control",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags="a,b".split(",");const metadata={get tags(){return "label";}};res.send(`<main>${tags.map(tag=>`<span>${escapeText(tag)}</span>`).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "class-property-name-control",
      source:
        'import express from "express";const app=express();function escapeText(str:string){return str.replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\').replace(/\'/g,\'&#39;\');}app.get("/",(req,res)=>{const tags="a,b".split(",");class Metadata{tags="label";}res.send(`<main>${tags.map(tag=>`<span>${escapeText(tag)}</span>`).join("")}<a href="/target">Go</a></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
  ])("separates names and callback array access: $id", (item) => {
    const graph = discoverSourcePageMap([file("index.ts", item.source)]);
    const routes = new Map(
      graph.nodes.map((node) => [node.id, node.notes.split("\n")[0].replace("Route: ", "")]),
    );
    expect(
      graph.edges.filter(
        (edge) => routes.get(edge.source) === "/" && routes.get(edge.target) === "/target",
      ),
    ).toHaveLength(item.expectedEdges);
  });
});
