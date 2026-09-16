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

  it.each([
    {
      id: "helper-replaces-array-map",
      source:
        'import express from "express";\nconst app = express();\nfunction replaceMap(values) {\n  values.map = () => ["<script>"];\n}\napp.get("/", (req, res) => {\n  const rows = [0];\n  replaceMap(rows);\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "native-array-without-helper-control",
      source:
        'import express from "express";\nconst app = express();\nfunction replaceMap(values) {\n  values.map = () => ["<script>"];\n}\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "custom-symbol-split-constant-callback",
      source:
        'import express from "express";\nconst app = express();\nconst separator = {\n  [Symbol.split]() {\n    return { map() { return { join() { return "<script>"; } }; } };\n  }\n};\napp.get("/", (req, res) => {\n  const rows = "x".split(separator);\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "literal-split-constant-callback-control",
      source:
        'import express from "express";\nconst app = express();\nconst separator = {\n  [Symbol.split]() {\n    return { map() { return { join() { return "<script>"; } }; } };\n  }\n};\napp.get("/", (req, res) => {\n  const rows = "x".split(",");\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "helper-replaces-map-through-alias",
      source:
        'import express from "express";const app=express();function replaceMap(values){values.map=()=>["<script>"];}app.get("/",(req,res)=>{const rows=[0];const alias=rows;replaceMap(alias);res.send(`<main>${rows.map(()=>"<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "typed-array-helper-escape",
      source:
        'import express from "express";const app=express();function replaceMap(values){values.map=()=>["<script>"];}app.get("/",(req,res)=>{let rows:number[]=[];rows=[0];replaceMap(rows);res.send(`<main>${rows.map(()=>"<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "direct-string-split-override",
      source:
        'import express from "express";const app=express();String.prototype.split=()=>({map(){return {join(){return "<script>";}}}});app.get("/",(req,res)=>{const rows="x".split(",");res.send(`<main>${rows.map(()=>"<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "helper-array-prototype-escape",
      source:
        'import express from "express";const app=express();function replaceMap(values){values.map=()=>["<script>"];}replaceMap(Array.prototype);app.get("/",(req,res)=>{const rows=[0];res.send(`<main>${rows.map(()=>"<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "helper-string-prototype-escape",
      source:
        'import express from "express";const app=express();function replaceSplit(value){value.split=()=>({map(){return {join(){return "<script>";}}}});}replaceSplit(String.prototype);app.get("/",(req,res)=>{const rows="x".split(",");res.send(`<main>${rows.map(()=>"<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "typed-custom-split-dispatch",
      source:
        'import express from "express";const app=express();const separator={[Symbol.split](){return {map(){return {join(){return "<script>";}}}}}};app.get("/",(req,res)=>{const rows:string[]="x".split(separator);res.send(`<main>${rows.map(()=>"<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "typed-literal-array-control",
      source:
        'import express from "express";const app=express();app.get("/",(req,res)=>{let rows:number[]=[];rows=[0];res.send(`<main>${rows.map(()=>"<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "stable-array-alias-control",
      source:
        'import express from "express";const app=express();app.get("/",(req,res)=>{const original=[0];const rows=original;res.send(`<main>${rows.map(()=>"<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "native-split-filter-control",
      source:
        'import express from "express";const app=express();app.get("/",(req,res)=>{const rows=String("x").split(",").filter(Boolean);res.send(`<main>${rows.map(()=>"<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "native-typed-split-control",
      source:
        'import express from "express";const app=express();app.get("/",(req,res)=>{const rows:string[]="x".split(",");res.send(`<main>${rows.map(()=>"<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "unrelated-helper-control",
      source:
        'import express from "express";const app=express();function replaceMap(values){values.map=()=>["<script>"];}const unrelated={};replaceMap(unrelated);app.get("/",(req,res)=>{const rows=[0];res.send(`<main>${rows.map(()=>"<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);});app.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
  ])("requires native map and split ownership: $id", (item) => {
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
      id: "typed-producer-alias-escaped",
      source:
        'import express from "express";\nconst app = express();\nfunction replaceMap(values: any) { values.map = () => ["<script>"]; }\napp.get("/", (req, res) => {\n  const original = [0];\n  replaceMap(original);\n  const rows: number[] = original;\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "typed-producer-alias-control",
      source:
        'import express from "express";\nconst app = express();\nfunction replaceMap(values: any) { values.map = () => ["<script>"]; }\napp.get("/", (req, res) => {\n  const original = [0];\n  const rows: number[] = original;\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "typed-producer-reassignment-escaped",
      source:
        'import express from "express";\nconst app = express();\nfunction replaceMap(values: any) { values.map = () => ["<script>"]; }\napp.get("/", (req, res) => {\n  const original = [0];\n  replaceMap(original);\n  let rows: number[] = []; rows = original;\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "typed-producer-reassignment-control",
      source:
        'import express from "express";\nconst app = express();\nfunction replaceMap(values: any) { values.map = () => ["<script>"]; }\napp.get("/", (req, res) => {\n  const original = [0];\n  let rows: number[] = []; rows = original;\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "typed-custom-map-alias",
      source:
        'import express from "express";\nconst app = express();\nfunction replaceMap(values: any) { values.map = () => ["<script>"]; }\napp.get("/", (req, res) => {\n  const original = {map(){return {join(){return "<script>";}}}};\n  const rows: number[] = original;\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "reflect-set-safe-key",
      source:
        'import express from "express";\nconst app = express();\nfunction replaceMap(values: any) { values.map = () => ["<script>"]; }\napp.get("/", (req, res) => {\n  Reflect.set(globalThis,"appLabel","NabuFlow");\n  const original = [0];\n  const rows: number[] = original;\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "define-property-safe-key",
      source:
        'import express from "express";\nconst app = express();\nfunction replaceMap(values: any) { values.map = () => ["<script>"]; }\napp.get("/", (req, res) => {\n  Object.defineProperty(globalThis,"appLabel",{value:"NabuFlow"});\n  const original = [0];\n  const rows: number[] = original;\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "reflect-delete-safe-key",
      source:
        'import express from "express";\nconst app = express();\nfunction replaceMap(values: any) { values.map = () => ["<script>"]; }\napp.get("/", (req, res) => {\n  Reflect.deleteProperty(globalThis,"appLabel");\n  const original = [0];\n  const rows: number[] = original;\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "reflect-set-native-array",
      source:
        'import express from "express";\nconst app = express();\nfunction replaceMap(values: any) { values.map = () => ["<script>"]; }\napp.get("/", (req, res) => {\n  Reflect.set(globalThis,"Array",{prototype:{map(){return ["<script>"];}}});\n  const original = [0];\n  const rows: number[] = original;\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "reflect-set-native-string",
      source:
        'import express from "express";\nconst app = express();\nfunction replaceMap(values: any) { values.map = () => ["<script>"]; }\napp.get("/", (req, res) => {\n  Reflect.set(globalThis,"String",()=>"<script>");\n  const original=String("x").split(",");\n  const rows: number[] = original;\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "reflect-unknown-key",
      source:
        'import express from "express";\nconst app = express();\nfunction replaceMap(values: any) { values.map = () => ["<script>"]; }\napp.get("/", (req, res) => {\n  Reflect.set(globalThis,key,()=>"<script>");\n  const original = [0];\n  const rows: number[] = original;\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "reflection-value-native-escape",
      source:
        'import express from "express";\nconst app = express();\nfunction replaceMap(values: any) { values.map = () => ["<script>"]; }\napp.get("/", (req, res) => {\n  const holder={set value(v){v.map=()=>["<script>"];}};Reflect.set(holder,"value",Array.prototype);\n  const original = [0];\n  const rows: number[] = original;\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "unknown-global-helper-escape",
      source:
        'import express from "express";\nconst app = express();\nfunction replaceMap(values: any) { values.map = () => ["<script>"]; }\napp.get("/", (req, res) => {\n  function mutate(g){g.Array.prototype.map=()=>["<script>"];}mutate(globalThis);\n  const original = [0];\n  const rows: number[] = original;\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "shadowed-reflect-global-escape",
      source:
        'import express from "express";\nconst app = express();\nfunction replaceMap(values: any) { values.map = () => ["<script>"]; }\napp.get("/", (req, res) => {\n  const Reflect={set(g,k,v){g.Array.prototype.map=()=>["<script>"];}};Reflect.set(globalThis,"appLabel","NabuFlow");\n  const original = [0];\n  const rows: number[] = original;\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "typed-alias-transitive-escape",
      source:
        'import express from "express";\nconst app = express();\nfunction replaceMap(values: any) { values.map = () => ["<script>"]; }\napp.get("/", (req, res) => {\n  const original = [0];\n  replaceMap(original);\n  const intermediate: number[] = original; const rows: number[] = intermediate;\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "typed-alias-transitive-control",
      source:
        'import express from "express";\nconst app = express();\nfunction replaceMap(values: any) { values.map = () => ["<script>"]; }\napp.get("/", (req, res) => {\n  const original = [0];\n  const intermediate: number[] = original; const rows: number[] = intermediate;\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "typed-initializer-destructured-db-control",
      source:
        'import express from "express";\nconst app = express();\nfunction replaceMap(values: any) { values.map = () => ["<script>"]; }\napp.get("/", (req, res) => {\n  const {rows: original}=db.query();\n  const rows: number[] = original;\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "typed-assignment-destructured-db-control",
      source:
        'import express from "express";\nconst app = express();\nfunction replaceMap(values: any) { values.map = () => ["<script>"]; }\napp.get("/", (req, res) => {\n  const {rows: original}=db.query();\n  let rows: number[]=[];rows=original;\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "typed-destructured-db-escape",
      source:
        'import express from "express";\nconst app = express();\nfunction replaceMap(values: any) { values.map = () => ["<script>"]; }\napp.get("/", (req, res) => {\n  const {rows: original}=db.query();\n  replaceMap(original);\n  const rows: number[] = original;\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "typed-destructured-object-array-control",
      source:
        'import express from "express";\nconst app = express();\nfunction replaceMap(values: any) { values.map = () => ["<script>"]; }\napp.get("/", (req, res) => {\n  const {rows: original}={rows:[0]};\n  const rows: number[] = original;\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "typed-destructured-custom-map",
      source:
        'import express from "express";\nconst app = express();\nfunction replaceMap(values: any) { values.map = () => ["<script>"]; }\napp.get("/", (req, res) => {\n  const {rows: original}={rows:{map(){return {join(){return "<script>";}}}}};\n  const rows: number[] = original;\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "typed-reassignment-custom-object",
      source:
        'import express from "express";\nconst app = express();\nfunction replaceMap(values: any) { values.map = () => ["<script>"]; }\napp.get("/", (req, res) => {\n  const original = [0];\n  let rows:number[]=[];rows={map(){return {join(){return "<script>";}}}};\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "typed-reassignment-custom-split",
      source:
        'import express from "express";\nconst app = express();\nfunction replaceMap(values: any) { values.map = () => ["<script>"]; }\napp.get("/", (req, res) => {\n  const original = [0];\n  const separator={[Symbol.split](){return {map(){return {join(){return "<script>";}}}}}};let rows:string[]=[];rows="x".split(separator);\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
  ])("preserves reflective targets and typed producer ownership: $id", (item) => {
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
      id: "assigned-array-prototype-override",
      source:
        'import express from "express";\nconst app = express();\nlet prototype;\nprototype = Array.prototype;\nprototype.map = () => ["<script>"];\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "assigned-array-prototype-control",
      source:
        'import express from "express";\nconst app = express();\nlet prototype;\nprototype = Array.prototype;\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "replaced-reflect-set",
      source:
        'import express from "express";\nconst app = express();\nReflect.set = (target, key, value) => {\n  target.Array.prototype.map = () => ["<script>"];\n  return true;\n};\nReflect.set(globalThis, "appLabel", "NabuFlow");\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "native-reflect-set-control",
      source:
        'import express from "express";\nconst app = express();\nReflect.set(globalThis, "appLabel", "NabuFlow");\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "reassigned-array-prototype-override",
      source:
        'import express from "express";\nconst app = express();\nlet prototype = {};\nprototype = Array.prototype;\nprototype.map = () => ["<script>"];\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "assigned-global-alias-override",
      source:
        'import express from "express";\nconst app = express();\nlet root;root=globalThis;root.Array.prototype.map=()=>["<script>"];\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "replaced-object-define-property",
      source:
        'import express from "express";\nconst app = express();\nObject.defineProperty=(target,key,value)=>{target.Array.prototype.map=()=>["<script>"];return target;};Object.defineProperty(globalThis,"appLabel",{value:"NabuFlow"});\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "reflect-alias-helper-override",
      source:
        'import express from "express";\nconst app = express();\nconst reflector=Reflect;reflector.set=(target,key,value)=>{target.Array.prototype.map=()=>["<script>"];return true;};Reflect.set(globalThis,"appLabel","NabuFlow");\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "unrelated-assigned-object-control",
      source:
        'import express from "express";\nconst app = express();\nlet prototype;prototype={};prototype.map=()=>["<script>"];\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "assigned-reflect-helper-override",
      source:
        'import express from "express";\nconst app=express();\nlet r;r=Reflect;r.set=(g)=>{g.Array.prototype.map=()=>["<script>"];};Reflect.set(globalThis,"appLabel","NabuFlow");\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "assigned-object-helper-override",
      source:
        'import express from "express";\nconst app=express();\nlet o;o=Object;o.defineProperty=(g)=>{g.Array.prototype.map=()=>["<script>"];};Object.defineProperty(globalThis,"appLabel",{value:"NabuFlow"});\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "reflection-helper-escaped",
      source:
        'import express from "express";\nconst app=express();\nmutate(Reflect);Reflect.set(globalThis,"appLabel","NabuFlow");\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "object-helper-escaped",
      source:
        'import express from "express";\nconst app=express();\nmutate(Object);Object.defineProperty(globalThis,"appLabel",{value:"NabuFlow"});\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "reflect-helper-reflectively-replaced",
      source:
        'import express from "express";\nconst app=express();\nObject.defineProperty(Reflect,"set",{value:g=>{g.Array.prototype.map=()=>["<script>"];}});Reflect.set(globalThis,"appLabel","NabuFlow");\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "global-reflect-replaced",
      source:
        'import express from "express";\nconst app=express();\nglobalThis.Reflect={set(g){g.Array.prototype.map=()=>["<script>"];}};Reflect.set(globalThis,"appLabel","NabuFlow");\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "reflection-helper-deleted",
      source:
        'import express from "express";\nconst app=express();\ndelete Reflect.set;Reflect.set(globalThis,"appLabel","NabuFlow");\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "assigned-reflect-clean-control",
      source:
        'import express from "express";\nconst app=express();\nlet r;r=Reflect;Reflect.set(globalThis,"appLabel","NabuFlow");\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "assigned-object-clean-control",
      source:
        'import express from "express";\nconst app=express();\nlet o;o=Object;Object.defineProperty(globalThis,"appLabel",{value:"NabuFlow"});\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "mixed-native-alias-mutation",
      source:
        'import express from "express";\nconst app=express();\nlet p=String.prototype;p=Array.prototype;p.map=()=>["<script>"];\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "mixed-native-alias-clean-control",
      source:
        'import express from "express";\nconst app=express();\nlet p=String.prototype;p=Array.prototype;\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
  ])("revokes replaced native ownership before map discovery: $id", (item) => {
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
      id: "destructured-array-mutation",
      source:
        'import express from "express";const app=express();\nconst {Array:NativeArray}=globalThis;Object.defineProperty(NativeArray.prototype,"map",{value:()=>["<script>"]});\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "destructured-array-control",
      source:
        'import express from "express";const app=express();\nconst {Array:NativeArray}=globalThis;\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "destructured-reflect-mutation",
      source:
        'import express from "express";const app=express();\nconst {Reflect:r}=globalThis;r.set=(g)=>{g.Array.prototype.map=()=>["<script>"];return true;};Reflect.set(globalThis,"appLabel","NabuFlow");\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "destructured-reflect-control",
      source:
        'import express from "express";const app=express();\nconst {Reflect:r}=globalThis;Reflect.set(globalThis,"appLabel","NabuFlow");\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "destructured-object-mutation",
      source:
        'import express from "express";const app=express();\nconst {Object:o}=globalThis;o.defineProperty=(g)=>{g.Array.prototype.map=()=>["<script>"];return g;};Object.defineProperty(globalThis,"appLabel",{value:"NabuFlow"});\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "destructured-object-control",
      source:
        'import express from "express";const app=express();\nconst {Object:o}=globalThis;Object.defineProperty(globalThis,"appLabel",{value:"NabuFlow"});\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "local-factory-initializer-mutation",
      source:
        'import express from "express";const app=express();\nfunction loadRows():number[]{const items=[0];Object.defineProperty(items,"map",{value:()=>["<script>"]});return items;}\napp.get("/", (req, res) => {\n  const rows:number[]=loadRows();\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "local-factory-initializer-control",
      source:
        'import express from "express";const app=express();\nfunction loadRows():number[]{const items=[0];return items;}\napp.get("/", (req, res) => {\n  const rows:number[]=loadRows();\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "local-factory-assignment-mutation",
      source:
        'import express from "express";const app=express();\nfunction loadRows():number[]{const items=[0];Object.defineProperty(items,"map",{value:()=>["<script>"]});return items;}\napp.get("/", (req, res) => {\n  let rows:number[]=[];rows=loadRows();\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "local-factory-assignment-control",
      source:
        'import express from "express";const app=express();\nfunction loadRows():number[]{const items=[0];return items;}\napp.get("/", (req, res) => {\n  let rows:number[]=[];rows=loadRows();\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "local-arrow-factory-mutation",
      source:
        'import express from "express";const app=express();\nconst loadRows=():number[]=>{const items=[0];Object.defineProperty(items,"map",{value:()=>["<script>"]});return items;};\napp.get("/", (req, res) => {\n  const rows:number[]=loadRows();\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "local-arrow-factory-control",
      source:
        'import express from "express";const app=express();\nconst loadRows=():number[]=>{const items=[0];return items;};\napp.get("/", (req, res) => {\n  const rows:number[]=loadRows();\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "nested-native-array-mutation",
      source:
        'import express from "express";const app=express();\nconst {Array:{prototype:p}}=globalThis;p.map=()=>["<script>"];\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "nested-native-array-control",
      source:
        'import express from "express";const app=express();\nconst {Array:{prototype:p}}=globalThis;\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "array-pattern-native-mutation",
      source:
        'import express from "express";const app=express();\nconst [A]=[Array];A.prototype.map=()=>["<script>"];\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "array-pattern-native-control",
      source:
        'import express from "express";const app=express();\nconst [A]=[Array];\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "wrapped-native-property-mutation",
      source:
        'import express from "express";const app=express();\nconst {owner:p}={owner:Array.prototype};p.map=()=>["<script>"];\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "wrapped-native-property-control",
      source:
        'import express from "express";const app=express();\nconst {owner:p}={owner:Array.prototype};\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "assignment-native-pattern-mutation",
      source:
        'import express from "express";const app=express();\nlet A;({Array:A}=globalThis);A.prototype.map=()=>["<script>"];\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "assignment-native-pattern-control",
      source:
        'import express from "express";const app=express();\nlet A;({Array:A}=globalThis);\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "default-native-binding-mutation",
      source:
        'import express from "express";const app=express();\nconst {p=Array.prototype}={};p.map=()=>["<script>"];\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "default-native-binding-control",
      source:
        'import express from "express";const app=express();\nconst {p=Array.prototype}={};\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "destructured-native-string-mutation",
      source:
        'import express from "express";const app=express();\nconst {String:S}=globalThis;S.prototype.split=()=>({map(){return {join(){return "<script>";}}}});\napp.get("/", (req, res) => {\n  const rows = "x".split("|");\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "destructured-native-string-control",
      source:
        'import express from "express";const app=express();\nconst {String:S}=globalThis;\napp.get("/", (req, res) => {\n  const rows = "x".split("|");\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "selected-local-factory-mutation",
      source:
        'import express from "express";const app=express();\nfunction loadRows(){const items=[0];Object.defineProperty(items,"map",{value:()=>["<script>"]});return {rows:items};}\napp.get("/", (req, res) => {\n  const {rows:original}=loadRows();const rows:number[]=original;\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "selected-local-factory-control",
      source:
        'import express from "express";const app=express();\nfunction loadRows(){const items=[0];return {rows:items};}\napp.get("/", (req, res) => {\n  const {rows:original}=loadRows();const rows:number[]=original;\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
  ])("tracks selected native bindings and local factory returns: $id", (item) => {
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
      id: "computed-global-target-mutation",
      source:
        'import express from "express";const app=express();\nconst name="Array";globalThis[name].prototype.map=()=>["<script>"];\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "computed-global-target-control",
      source:
        'import express from "express";const app=express();\nconst name="Array";\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "computed-binding-pattern-mutation",
      source:
        'import express from "express";const app=express();\nconst name="Array";const {[name]:A}=globalThis;A.prototype.map=()=>["<script>"];\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "computed-binding-pattern-control",
      source:
        'import express from "express";const app=express();\nconst name="Array";const {[name]:A}=globalThis;\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "computed-wrapped-native-mutation",
      source:
        'import express from "express";const app=express();\nconst name="Array";const holder={[name]:Array};const {Array:A}=holder;A.prototype.map=()=>["<script>"];\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "computed-wrapped-native-control",
      source:
        'import express from "express";const app=express();\nconst name="Array";const holder={[name]:Array};const {Array:A}=holder;\napp.get("/", (req, res) => {\n  const rows = [0];\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "parameterized-factory-mutation",
      source:
        'import express from "express";const app=express();\nfunction loadRows(_limit:number):number[]{const items=[0];Object.defineProperty(items,"map",{value:()=>["<script>"]});return items;}\napp.get("/", (req, res) => {\n  const rows:number[]=loadRows(1);\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "parameterized-factory-control",
      source:
        'import express from "express";const app=express();\nfunction loadRows(_limit:number):number[]{const items=[0];return items;}\napp.get("/", (req, res) => {\n  const rows:number[]=loadRows(1);\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "awaited-local-factory-mutation",
      source:
        'import express from "express";const app=express();\nasync function loadRows():Promise<number[]>{const items=[0];Object.defineProperty(items,"map",{value:()=>["<script>"]});return items;}\napp.get("/", async (req, res) => {\n  const rows:number[]=await loadRows();\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "awaited-local-factory-control",
      source:
        'import express from "express";const app=express();\nasync function loadRows():Promise<number[]>{const items=[0];return items;}\napp.get("/", async (req, res) => {\n  const rows:number[]=await loadRows();\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "forwarded-local-factory-mutation",
      source:
        'import express from "express";const app=express();\nfunction loadRows(items:number[]):number[]{Object.defineProperty(items,"map",{value:()=>["<script>"]});return items;}\napp.get("/", (req, res) => {\n  const original=[0];const rows:number[]=loadRows(original);\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "forwarded-local-factory-control",
      source:
        'import express from "express";const app=express();\nfunction loadRows(items:number[]):number[]{return items;}\napp.get("/", (req, res) => {\n  const original=[0];const rows:number[]=loadRows(original);\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "aliased-forwarded-parameter-mutation",
      source:
        'import express from "express";const app=express();\nfunction loadRows(items:number[]){const alias=items;Object.defineProperty(alias,"map",{value:()=>["<script>"]});return alias;}\napp.get("/", (req, res) => {\n  const original=[0];const rows:number[]=loadRows(original);\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "aliased-forwarded-parameter-control",
      source:
        'import express from "express";const app=express();\nfunction loadRows(items:number[]){const alias=items;return alias;}\napp.get("/", (req, res) => {\n  const original=[0];const rows:number[]=loadRows(original);\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "second-parameter-alias-mutation",
      source:
        'import express from "express";const app=express();\nfunction loadRows(items:number[],other:number[]){Object.defineProperty(other,"map",{value:()=>["<script>"]});return items;}\napp.get("/", (req, res) => {\n  const original=[0];const rows:number[]=loadRows(original,original);\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "second-parameter-alias-control",
      source:
        'import express from "express";const app=express();\nfunction loadRows(items:number[],other:number[]){return items;}\napp.get("/", (req, res) => {\n  const original=[0];const rows:number[]=loadRows(original,original);\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "default-array-parameter-mutation",
      source:
        'import express from "express";const app=express();\nfunction loadRows(items:number[]=[0]){Object.defineProperty(items,"map",{value:()=>["<script>"]});return items;}\napp.get("/", (req, res) => {\n  const rows:number[]=loadRows();\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "default-array-parameter-control",
      source:
        'import express from "express";const app=express();\nfunction loadRows(items:number[]=[0]){return items;}\napp.get("/", (req, res) => {\n  const rows:number[]=loadRows();\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "explicit-undefined-default-mutation",
      source:
        'import express from "express";const app=express();\nfunction loadRows(items:number[]=[0]){Object.defineProperty(items,"map",{value:()=>["<script>"]});return items;}\napp.get("/", (req, res) => {\n  const rows:number[]=loadRows(undefined);\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "explicit-undefined-default-control",
      source:
        'import express from "express";const app=express();\nfunction loadRows(items:number[]=[0]){return items;}\napp.get("/", (req, res) => {\n  const rows:number[]=loadRows(undefined);\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "rest-array-parameter-mutation",
      source:
        'import express from "express";const app=express();\nfunction loadRows(...items:number[]){Object.defineProperty(items,"map",{value:()=>["<script>"]});return items;}\napp.get("/", (req, res) => {\n  const rows:number[]=loadRows(0,1);\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "rest-array-parameter-control",
      source:
        'import express from "express";const app=express();\nfunction loadRows(...items:number[]){return items;}\napp.get("/", (req, res) => {\n  const rows:number[]=loadRows(0,1);\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "reassigned-array-parameter-mutation",
      source:
        'import express from "express";const app=express();\nfunction loadRows(items:number[]){items=[0];items={map(){return {join(){return "<script>";}}}} as any;return items;}\napp.get("/", (req, res) => {\n  const rows:number[]=loadRows([1]);\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "reassigned-array-parameter-control",
      source:
        'import express from "express";const app=express();\nfunction loadRows(items:number[]){items=[0];return items;}\napp.get("/", (req, res) => {\n  const rows:number[]=loadRows([1]);\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "method-factory-mutation",
      source:
        'import express from "express";const app=express();\nconst factory={loadRows(){const items=[0];Object.defineProperty(items,"map",{value:()=>["<script>"]});return items;}};\napp.get("/", (req, res) => {\n  const rows:number[]=factory.loadRows();\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "method-factory-control",
      source:
        'import express from "express";const app=express();\nconst factory={loadRows(){const items=[0];return items;}};\napp.get("/", (req, res) => {\n  const rows:number[]=factory.loadRows();\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "property-arrow-factory-mutation",
      source:
        'import express from "express";const app=express();\nconst factory={loadRows:()=>{const items=[0];Object.defineProperty(items,"map",{value:()=>["<script>"]});return items;}};\napp.get("/", (req, res) => {\n  const rows:number[]=factory["loadRows"]();\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "property-arrow-factory-control",
      source:
        'import express from "express";const app=express();\nconst factory={loadRows:()=>{const items=[0];return items;}};\napp.get("/", (req, res) => {\n  const rows:number[]=factory["loadRows"]();\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "unawaited-promise-is-not-array",
      source:
        'import express from "express";const app=express();\nasync function loadRows(){return [0];}\napp.get("/", (req, res) => {\n  const rows:number[]=loadRows() as any;\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "same-factory-different-arguments",
      source:
        'import express from "express";const app=express();\nfunction loadRows(items:number[]){return items;}\napp.get("/", (req, res) => {\n  const good=[0];const bad=[0];Object.defineProperty(bad,"map",{value:()=>["<script>"]});const rows:number[]=unknownChoice?loadRows(good):loadRows(bad);\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
  ])("preserves computed keys and safe factory argument flow: $id", (item) => {
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
      id: "method-alias-forward-mutation",
      source:
        'import express from "express";const app=express();\nconst factory={loadRows(items:number[]){const alias=items;return alias;}};\napp.get("/", (req, res) => {\n  const good=[0];const bad=[0];Object.defineProperty(bad,"map",{value:()=>["<script>"]});const rows:number[]=req.query.good?factory.loadRows(good):factory.loadRows(bad);\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "method-alias-forward-control",
      source:
        'import express from "express";const app=express();\nconst factory={loadRows(items:number[]){const alias=items;return alias;}};\napp.get("/", (req, res) => {\n  const good=[0];const bad=[0];const rows:number[]=req.query.good?factory.loadRows(good):factory.loadRows(bad);\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "method-alias-reverse-mutation",
      source:
        'import express from "express";const app=express();\nconst factory={loadRows(items:number[]){const alias=items;return alias;}};\napp.get("/", (req, res) => {\n  const good=[0];const bad=[0];Object.defineProperty(bad,"map",{value:()=>["<script>"]});const rows:number[]=req.query.good?factory.loadRows(bad):factory.loadRows(good);\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "method-alias-reverse-control",
      source:
        'import express from "express";const app=express();\nconst factory={loadRows(items:number[]){const alias=items;return alias;}};\napp.get("/", (req, res) => {\n  const good=[0];const bad=[0];const rows:number[]=req.query.good?factory.loadRows(bad):factory.loadRows(good);\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "function-alias-forward-mutation",
      source:
        'import express from "express";const app=express();\nfunction loadRows(items:number[]){const alias=items;return alias;}\napp.get("/", (req, res) => {\n  const good=[0];const bad=[0];Object.defineProperty(bad,"map",{value:()=>["<script>"]});const rows:number[]=req.query.good?loadRows(good):loadRows(bad);\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "function-alias-forward-control",
      source:
        'import express from "express";const app=express();\nfunction loadRows(items:number[]){const alias=items;return alias;}\napp.get("/", (req, res) => {\n  const good=[0];const bad=[0];const rows:number[]=req.query.good?loadRows(good):loadRows(bad);\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "function-alias-reverse-mutation",
      source:
        'import express from "express";const app=express();\nfunction loadRows(items:number[]){const alias=items;return alias;}\napp.get("/", (req, res) => {\n  const good=[0];const bad=[0];Object.defineProperty(bad,"map",{value:()=>["<script>"]});const rows:number[]=req.query.good?loadRows(bad):loadRows(good);\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "function-alias-reverse-control",
      source:
        'import express from "express";const app=express();\nfunction loadRows(items:number[]){const alias=items;return alias;}\napp.get("/", (req, res) => {\n  const good=[0];const bad=[0];const rows:number[]=req.query.good?loadRows(bad):loadRows(good);\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "arrow-alias-forward-mutation",
      source:
        'import express from "express";const app=express();\nconst factory={loadRows:(items:number[])=>{const alias=items;return alias;}};\napp.get("/", (req, res) => {\n  const good=[0];const bad=[0];Object.defineProperty(bad,"map",{value:()=>["<script>"]});const rows:number[]=req.query.good?factory.loadRows(good):factory.loadRows(bad);\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "arrow-alias-forward-control",
      source:
        'import express from "express";const app=express();\nconst factory={loadRows:(items:number[])=>{const alias=items;return alias;}};\napp.get("/", (req, res) => {\n  const good=[0];const bad=[0];const rows:number[]=req.query.good?factory.loadRows(good):factory.loadRows(bad);\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "arrow-alias-reverse-mutation",
      source:
        'import express from "express";const app=express();\nconst factory={loadRows:(items:number[])=>{const alias=items;return alias;}};\napp.get("/", (req, res) => {\n  const good=[0];const bad=[0];Object.defineProperty(bad,"map",{value:()=>["<script>"]});const rows:number[]=req.query.good?factory.loadRows(bad):factory.loadRows(good);\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "arrow-alias-reverse-control",
      source:
        'import express from "express";const app=express();\nconst factory={loadRows:(items:number[])=>{const alias=items;return alias;}};\napp.get("/", (req, res) => {\n  const good=[0];const bad=[0];const rows:number[]=req.query.good?factory.loadRows(bad):factory.loadRows(good);\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "written-method-receiver-mutation",
      source:
        'import express from "express";const app=express();\nconst factory={label:"v1",loadRows(){const items=[0];Object.defineProperty(items,"map",{value:()=>["<script>"]});return items;}};factory.label="v2";\napp.get("/", (req, res) => {\n  const rows:number[]=factory.loadRows();\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "written-method-receiver-control",
      source:
        'import express from "express";const app=express();\nconst factory={label:"v1",loadRows(){const items=[0];return items;}};factory.label="v2";\napp.get("/", (req, res) => {\n  const rows:number[]=factory.loadRows();\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "written-arrow-receiver-mutation",
      source:
        'import express from "express";const app=express();\nconst factory={label:"v1",loadRows:()=>{const items=[0];Object.defineProperty(items,"map",{value:()=>["<script>"]});return items;}};factory.label="v2";\napp.get("/", (req, res) => {\n  const rows:number[]=factory.loadRows();\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "written-arrow-receiver-control",
      source:
        'import express from "express";const app=express();\nconst factory={label:"v1",loadRows:()=>{const items=[0];return items;}};factory.label="v2";\napp.get("/", (req, res) => {\n  const rows:number[]=factory.loadRows();\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "written-alias-receiver-mutation",
      source:
        'import express from "express";const app=express();\nconst factory={label:"v1",loadRows(){const items=[0];Object.defineProperty(items,"map",{value:()=>["<script>"]});return items;}};const alias=factory;alias.label="v2";\napp.get("/", (req, res) => {\n  const rows:number[]=factory.loadRows();\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "written-alias-receiver-control",
      source:
        'import express from "express";const app=express();\nconst factory={label:"v1",loadRows(){const items=[0];return items;}};const alias=factory;alias.label="v2";\napp.get("/", (req, res) => {\n  const rows:number[]=factory.loadRows();\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "written-assigned-receiver-alias-mutation",
      source:
        'import express from "express";const app=express();\nconst factory={label:"v1",loadRows(){const items=[0];Object.defineProperty(items,"map",{value:()=>["<script>"]});return items;}};let alias;alias=factory;alias.label="v2";\napp.get("/", (req, res) => {\n  const rows:number[]=factory.loadRows();\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "written-assigned-receiver-alias-control",
      source:
        'import express from "express";const app=express();\nconst factory={label:"v1",loadRows(){const items=[0];return items;}};let alias;alias=factory;alias.label="v2";\napp.get("/", (req, res) => {\n  const rows:number[]=factory.loadRows();\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "visible-object-returning-factory-mutation",
      source:
        'import express from "express";const app=express();\nfunction makeFactory(){return {loadRows(){const items=[0];Object.defineProperty(items,"map",{value:()=>["<script>"]});return items;}};}const factory=makeFactory();\napp.get("/", (req, res) => {\n  const rows:number[]=factory.loadRows();\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "visible-object-returning-factory-control",
      source:
        'import express from "express";const app=express();\nfunction makeFactory(){return {loadRows(){const items=[0];return items;}};}const factory=makeFactory();\napp.get("/", (req, res) => {\n  const rows:number[]=factory.loadRows();\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "receiver-method-replacement-mutation",
      source:
        'import express from "express";const app=express();\nconst factory={loadRows(){return [0];}};factory.loadRows=()=>{const items=[0];Object.defineProperty(items,"map",{value:()=>["<script>"]});return items;};\napp.get("/", (req, res) => {\n  const rows:number[]=factory.loadRows();\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "receiver-method-replacement-control",
      source:
        'import express from "express";const app=express();\nconst factory={loadRows(){return [0];}};\napp.get("/", (req, res) => {\n  const rows:number[]=factory.loadRows();\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "receiver-escape-mutation",
      source:
        'import express from "express";const app=express();\nconst factory={loadRows(){return [0];}};function replace(f){f.loadRows=()=>({map(){return {join(){return "<script>";}}}});}replace(factory);\napp.get("/", (req, res) => {\n  const rows:number[]=factory.loadRows();\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "receiver-escape-control",
      source:
        'import express from "express";const app=express();\nconst factory={loadRows(){return [0];}};function replace(f){f.loadRows=()=>({map(){return {join(){return "<script>";}}}});}\napp.get("/", (req, res) => {\n  const rows:number[]=factory.loadRows();\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
    {
      id: "receiver-unknown-key-write-mutation",
      source:
        'import express from "express";const app=express();\nconst factory={loadRows(){return [0];}};const key="loadRows";factory[key]=()=>({map(){return {join(){return "<script>";}}}});\napp.get("/", (req, res) => {\n  const rows:number[]=factory.loadRows();\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "receiver-unknown-key-write-control",
      source:
        'import express from "express";const app=express();\nconst factory={loadRows(){return [0];}};const key="loadRows";\napp.get("/", (req, res) => {\n  const rows:number[]=factory.loadRows();\n  res.send(`<main>${rows.map(() => "<span>safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
  ])("binds factory proofs to invocation and stable local methods: $id", (item) => {
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
      id: "method-chain-mutation",
      source:
        'import express from "express";\nconst app = express();\nconst provider = {\n  create() {\n    return {\n      loadRows() {\n        const items = [0];\n        Object.defineProperty(items, "map", { value: () => ["<script>"] });\n        return items;\n      }\n    };\n  }\n};\napp.get("/", (req, res) => {\n  const rows: number[] = provider.create().loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "method-chain-control",
      source:
        'import express from "express";\nconst app = express();\nconst provider = {\n  create() {\n    return {\n      loadRows() {\n        const items = [0];\n        return items;\n      }\n    };\n  }\n};\napp.get("/", (req, res) => {\n  const rows: number[] = provider.create().loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "saved-method-result-mutation",
      source:
        'import express from "express";\nconst app = express();\nconst provider = {\n  create() {\n    return {\n      loadRows() {\n        const items = [0];\n        Object.defineProperty(items, "map", { value: () => ["<script>"] });\n        return items;\n      }\n    };\n  }\n};\napp.get("/", (req, res) => {\n  const receiver = provider.create();\n  const rows: number[] = receiver.loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "saved-method-result-control",
      source:
        'import express from "express";\nconst app = express();\nconst provider = {\n  create() {\n    return {\n      loadRows() {\n        const items = [0];\n        return items;\n      }\n    };\n  }\n};\napp.get("/", (req, res) => {\n  const receiver = provider.create();\n  const rows: number[] = receiver.loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "property-arrow-chain-mutation",
      source:
        'import express from "express";\nconst app = express();\nconst provider = {\n  create: () => {\n    return {\n      loadRows() {\n        const items = [0];\n        Object.defineProperty(items, "map", { value: () => ["<script>"] });\n        return items;\n      }\n    };\n  }\n};\napp.get("/", (req, res) => {\n  const rows: number[] = provider.create().loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "property-arrow-chain-control",
      source:
        'import express from "express";\nconst app = express();\nconst provider = {\n  create: () => {\n    return {\n      loadRows() {\n        const items = [0];\n        return items;\n      }\n    };\n  }\n};\napp.get("/", (req, res) => {\n  const rows: number[] = provider.create().loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "aliased-factory-chain-mutation",
      source:
        'import express from "express";\nconst app = express();\nconst provider = {\n  create() {\n    return {\n      loadRows() {\n        const items = [0];\n        Object.defineProperty(items, "map", { value: () => ["<script>"] });\n        return items;\n      }\n    };\n  }\n};\nconst alias = provider;\napp.get("/", (req, res) => {\n  const rows: number[] = alias.create().loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "aliased-factory-chain-control",
      source:
        'import express from "express";\nconst app = express();\nconst provider = {\n  create() {\n    return {\n      loadRows() {\n        const items = [0];\n        return items;\n      }\n    };\n  }\n};\nconst alias = provider;\napp.get("/", (req, res) => {\n  const rows: number[] = alias.create().loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "literal-bracket-factory-chain-mutation",
      source:
        'import express from "express";\nconst app = express();\nconst provider = {\n  create() {\n    return {\n      loadRows() {\n        const items = [0];\n        Object.defineProperty(items, "map", { value: () => ["<script>"] });\n        return items;\n      }\n    };\n  }\n};\napp.get("/", (req, res) => {\n  const rows: number[] = provider["create"]()["loadRows"]();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "literal-bracket-factory-chain-control",
      source:
        'import express from "express";\nconst app = express();\nconst provider = {\n  create() {\n    return {\n      loadRows() {\n        const items = [0];\n        return items;\n      }\n    };\n  }\n};\napp.get("/", (req, res) => {\n  const rows: number[] = provider["create"]()["loadRows"]();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "awaited-factory-chain-mutation",
      source:
        'import express from "express";\nconst app = express();\nconst provider = {\n  async create() {\n    return {\n      loadRows() {\n        const items = [0];\n        Object.defineProperty(items, "map", { value: () => ["<script>"] });\n        return items;\n      }\n    };\n  }\n};\napp.get("/", async (req, res) => {\n  const rows: number[] = (await provider.create()).loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "awaited-factory-chain-control",
      source:
        'import express from "express";\nconst app = express();\nconst provider = {\n  async create() {\n    return {\n      loadRows() {\n        const items = [0];\n        return items;\n      }\n    };\n  }\n};\napp.get("/", async (req, res) => {\n  const rows: number[] = (await provider.create()).loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "unawaited-async-factory-is-not-a-receiver",
      source:
        'import express from "express";\nconst app = express();\nconst provider = {\n  async create() {\n    return {\n      loadRows() {\n        const items = [0];\n        return items;\n      }\n    };\n  }\n};\napp.get("/", (req, res) => {\n  const rows: number[] = provider.create().loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "replaced-derived-factory-mutation",
      source:
        'import express from "express";\nconst app = express();\nconst provider = {\n  create() {\n    return {\n      loadRows() {\n        const items = [0];\n        return items;\n      }\n    };\n  }\n};\nprovider.create = () => ({ loadRows() { const items = [0]; Object.defineProperty(items, "map", { value: () => ["<script>"] }); return items; } });\napp.get("/", (req, res) => {\n  const rows: number[] = provider.create().loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "replaced-derived-factory-control",
      source:
        'import express from "express";\nconst app = express();\nconst provider = {\n  create() {\n    return {\n      loadRows() {\n        const items = [0];\n        return items;\n      }\n    };\n  }\n};\napp.get("/", (req, res) => {\n  const rows: number[] = provider.create().loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "escaped-derived-factory-mutation",
      source:
        'import express from "express";\nconst app = express();\nconst provider = {\n  create() {\n    return {\n      loadRows() {\n        const items = [0];\n        return items;\n      }\n    };\n  }\n};\nfunction replaceFactory(target) { target.create = () => ({ loadRows() { const items = [0]; Object.defineProperty(items, "map", { value: () => ["<script>"] }); return items; } }); }\nreplaceFactory(provider);\napp.get("/", (req, res) => {\n  const rows: number[] = provider.create().loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "escaped-derived-factory-control",
      source:
        'import express from "express";\nconst app = express();\nconst provider = {\n  create() {\n    return {\n      loadRows() {\n        const items = [0];\n        return items;\n      }\n    };\n  }\n};\nfunction replaceFactory(target) { target.create = () => ({ loadRows() { const items = [0]; Object.defineProperty(items, "map", { value: () => ["<script>"] }); return items; } }); }\napp.get("/", (req, res) => {\n  const rows: number[] = provider.create().loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "captured-factory-argument-mutation",
      source:
        'import express from "express";\nconst app=express();\nconst provider={create(items:number[]){return {loadRows(){return items;}};}};\napp.get("/",(req,res)=>{\n const items=[0];\n Object.defineProperty(items,"map",{value:()=>["<script>"]});\n const rows:number[]=provider.create(items).loadRows();\n res.send(`<main>${rows.map(()=>"<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target",(req,res)=>res.send("<main>Target</main>"));\n',
      expectedEdges: 0,
    },
    {
      id: "captured-factory-argument-control",
      source:
        'import express from "express";\nconst app=express();\nconst provider={create(items:number[]){return {loadRows(){return items;}};}};\napp.get("/",(req,res)=>{\n const items=[0];\n \n const rows:number[]=provider.create(items).loadRows();\n res.send(`<main>${rows.map(()=>"<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target",(req,res)=>res.send("<main>Target</main>"));\n',
      expectedEdges: 1,
    },
  ])("keeps derived local factory provenance: $id", (item) => {
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
      id: "function-constructor-mutation",
      source:
        'import express from "express";\nconst app = express();\nfunction Factory() {\n  return {\n    loadRows() {\n      const items = [0];\n      Object.defineProperty(items, "map", { value: () => ["<script>"] });\n      return items;\n    }\n  };\n}\napp.get("/", (req, res) => {\n  const receiver = new Factory();\n  const rows: number[] = receiver.loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "function-constructor-control",
      source:
        'import express from "express";\nconst app = express();\nfunction Factory() {\n  return {\n    loadRows() {\n      const items = [0];\n      return items;\n    }\n  };\n}\napp.get("/", (req, res) => {\n  const receiver = new Factory();\n  const rows: number[] = receiver.loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "function-constructor-alias-mutation",
      source:
        'import express from "express";\nconst app = express();\nfunction Factory() {\n  return {\n    loadRows() {\n      const items = [0];\n      Object.defineProperty(items, "map", { value: () => ["<script>"] });\n      return items;\n    }\n  };\n}\nconst Alias = Factory;\napp.get("/", (req, res) => {\n  const receiver = new Alias();\n  const rows: number[] = receiver.loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "function-constructor-alias-control",
      source:
        'import express from "express";\nconst app = express();\nfunction Factory() {\n  return {\n    loadRows() {\n      const items = [0];\n      return items;\n    }\n  };\n}\nconst Alias = Factory;\napp.get("/", (req, res) => {\n  const receiver = new Alias();\n  const rows: number[] = receiver.loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "class-constructor-alias-mutation",
      source:
        'import express from "express";\nconst app = express();\nclass Local {\n  loadRows() {\n    const items = [0];\n    Object.defineProperty(items, "map", { value: () => ["<script>"] });\n    return items;\n  }\n}\nconst Factory = Local;\napp.get("/", (req, res) => {\n  const receiver = new Factory();\n  const rows: number[] = receiver.loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "class-constructor-alias-control",
      source:
        'import express from "express";\nconst app = express();\nclass Local {\n  loadRows() {\n    const items = [0];\n    return items;\n  }\n}\nconst Factory = Local;\napp.get("/", (req, res) => {\n  const receiver = new Factory();\n  const rows: number[] = receiver.loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "class-expression-constructor-mutation",
      source:
        'import express from "express";\nconst app = express();\nconst Factory = class {\n  loadRows() {\n    const items = [0];\n    Object.defineProperty(items, "map", { value: () => ["<script>"] });\n    return items;\n  }\n};\napp.get("/", (req, res) => {\n  const receiver = new Factory();\n  const rows: number[] = receiver.loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "class-expression-constructor-control",
      source:
        'import express from "express";\nconst app = express();\nconst Factory = class {\n  loadRows() {\n    const items = [0];\n    return items;\n  }\n};\napp.get("/", (req, res) => {\n  const receiver = new Factory();\n  const rows: number[] = receiver.loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "direct-class-already-unsupported-mutation",
      source:
        'import express from "express";\nconst app = express();\nclass Local {\n  loadRows() {\n    const items = [0];\n    Object.defineProperty(items, "map", { value: () => ["<script>"] });\n    return items;\n  }\n}\napp.get("/", (req, res) => {\n  const receiver = new Local();\n  const rows: number[] = receiver.loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "direct-class-already-unsupported-control",
      source:
        'import express from "express";\nconst app = express();\nclass Local {\n  loadRows() {\n    const items = [0];\n    return items;\n  }\n}\napp.get("/", (req, res) => {\n  const receiver = new Local();\n  const rows: number[] = receiver.loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "unsupported-intrinsic-reflect-construct-mutation",
      source:
        'import express from "express";\nconst app = express();\nfunction Factory() {\n  return {\n    loadRows() {\n      const items = [0];\n      Object.defineProperty(items, "map", { value: () => ["<script>"] });\n      return items;\n    }\n  };\n}\napp.get("/", (req, res) => {\n  const receiver = Reflect.construct(Factory, []);\n  const rows: number[] = receiver.loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "unsupported-intrinsic-reflect-construct-control",
      source:
        'import express from "express";\nconst app = express();\nfunction Factory() {\n  return {\n    loadRows() {\n      const items = [0];\n      return items;\n    }\n  };\n}\napp.get("/", (req, res) => {\n  const receiver = Reflect.construct(Factory, []);\n  const rows: number[] = receiver.loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "unsupported-intrinsic-object-create-mutation",
      source:
        'import express from "express";\nconst app = express();\nfunction Factory() {\n  return {\n    loadRows() {\n      const items = [0];\n      Object.defineProperty(items, "map", { value: () => ["<script>"] });\n      return items;\n    }\n  };\n}\napp.get("/", (req, res) => {\n  const receiver = Object.create(Factory());\n  const rows: number[] = receiver.loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "unsupported-intrinsic-object-create-control",
      source:
        'import express from "express";\nconst app = express();\nfunction Factory() {\n  return {\n    loadRows() {\n      const items = [0];\n      return items;\n    }\n  };\n}\napp.get("/", (req, res) => {\n  const receiver = Object.create(Factory());\n  const rows: number[] = receiver.loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "unsupported-intrinsic-proxy-constructor-mutation",
      source:
        'import express from "express";\nconst app = express();\nfunction Factory() {\n  return {\n    loadRows() {\n      const items = [0];\n      Object.defineProperty(items, "map", { value: () => ["<script>"] });\n      return items;\n    }\n  };\n}\napp.get("/", (req, res) => {\n  const receiver = new Proxy(Factory(), {});\n  const rows: number[] = receiver.loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "unsupported-intrinsic-proxy-constructor-control",
      source:
        'import express from "express";\nconst app = express();\nfunction Factory() {\n  return {\n    loadRows() {\n      const items = [0];\n      return items;\n    }\n  };\n}\napp.get("/", (req, res) => {\n  const receiver = new Proxy(Factory(), {});\n  const rows: number[] = receiver.loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "unsupported-intrinsic-promise-resolved-receiver-mutation",
      source:
        'import express from "express";\nconst app = express();\nfunction Factory() {\n  return {\n    loadRows() {\n      const items = [0];\n      Object.defineProperty(items, "map", { value: () => ["<script>"] });\n      return items;\n    }\n  };\n}\napp.get("/", async (req, res) => {\n  const receiver = await Promise.resolve(Factory());\n  const rows: number[] = receiver.loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "unsupported-intrinsic-promise-resolved-receiver-control",
      source:
        'import express from "express";\nconst app = express();\nfunction Factory() {\n  return {\n    loadRows() {\n      const items = [0];\n      return items;\n    }\n  };\n}\napp.get("/", async (req, res) => {\n  const receiver = await Promise.resolve(Factory());\n  const rows: number[] = receiver.loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "shadowed-intrinsic-constructor-mutation",
      source:
        'import express from "express";\nconst app = express();\nfunction Object() {\n  return {\n    loadRows() {\n      const items = [0];\n      Object.defineProperty(items, "map", { value: () => ["<script>"] });\n      return items;\n    }\n  };\n}\napp.get("/", (req, res) => {\n  const receiver = new Object();\n  const rows: number[] = receiver.loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "shadowed-intrinsic-constructor-control",
      source:
        'import express from "express";\nconst app = express();\nfunction Object() {\n  return {\n    loadRows() {\n      const items = [0];\n      return items;\n    }\n  };\n}\napp.get("/", (req, res) => {\n  const receiver = new Object();\n  const rows: number[] = receiver.loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "local-property-constructor-mutation",
      source:
        'import express from "express";\nconst app = express();\nfunction Factory() {\n  return {\n    loadRows() {\n      const items = [0];\n      Object.defineProperty(items, "map", { value: () => ["<script>"] });\n      return items;\n    }\n  };\n}\nconst providers = { Factory };\napp.get("/", (req, res) => {\n  const receiver = new providers.Factory();\n  const rows: number[] = receiver.loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "local-property-constructor-control",
      source:
        'import express from "express";\nconst app = express();\nfunction Factory() {\n  return {\n    loadRows() {\n      const items = [0];\n      return items;\n    }\n  };\n}\nconst providers = { Factory };\napp.get("/", (req, res) => {\n  const receiver = new providers.Factory();\n  const rows: number[] = receiver.loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "constructor-without-argument-list-mutation",
      source:
        'import express from "express";\nconst app = express();\nfunction Factory() {\n  return {\n    loadRows() {\n      const items = [0];\n      Object.defineProperty(items, "map", { value: () => ["<script>"] });\n      return items;\n    }\n  };\n}\napp.get("/", (req, res) => {\n  const receiver = new Factory;\n  const rows: number[] = receiver.loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "constructor-without-argument-list-control",
      source:
        'import express from "express";\nconst app = express();\nfunction Factory() {\n  return {\n    loadRows() {\n      const items = [0];\n      return items;\n    }\n  };\n}\napp.get("/", (req, res) => {\n  const receiver = new Factory;\n  const rows: number[] = receiver.loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "external-import-constructor",
      source:
        'import express from "express";\nconst app = express();\nimport { DataClient } from "external-data-client";\napp.get("/", (req, res) => {\n  const receiver = new DataClient();\n  const rows: number[] = receiver.loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "external-namespace-constructor",
      source:
        'import express from "express";\nconst app = express();\nimport * as vendor from "external-data-client";\napp.get("/", (req, res) => {\n  const receiver = new vendor.DataClient();\n  const rows: number[] = receiver.loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "external-unbound-constructor",
      source:
        'import express from "express";\nconst app = express();\n\napp.get("/", (req, res) => {\n  const receiver = new DataClient();\n  const rows: number[] = receiver.loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "arrow-is-not-a-constructor",
      source:
        'import express from "express";\nconst app = express();\nconst Factory = () => {\n  return {\n    loadRows() {\n      const items = [0];\n      return items;\n    }\n  };\n};\napp.get("/", (req, res) => {\n  const receiver = new Factory();\n  const rows: number[] = receiver.loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "generator-is-not-a-constructor",
      source:
        'import express from "express";\nconst app = express();\nfunction* Factory() {\n  return {\n    loadRows() {\n      const items = [0];\n      return items;\n    }\n  };\n}\napp.get("/", (req, res) => {\n  const receiver = new Factory();\n  const rows: number[] = receiver.loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "awaited-async-function-is-not-a-constructor",
      source:
        'import express from "express";\nconst app = express();\nasync function Factory() {\n  return {\n    loadRows() {\n      const items = [0];\n      return items;\n    }\n  };\n}\napp.get("/", async (req, res) => {\n  const receiver = await new Factory();\n  const rows: number[] = receiver.loadRows();\n  res.send(`<main>${rows.map(() => "<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target", (req, res) => res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
  ])("keeps constructor provenance and intrinsic results honest: $id", (item) => {
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

describe("dynamic evaluator provenance remains unknown", () => {
  // Inputs are parsed as source only. Never execute an evaluator or its payload.
  it.each([
    {
      id: "direct-eval-mutation",
      content:
        'import express from "express"; const app=express();\napp.get("/",(req,res)=>{\n const rows:number[]=eval("Object.assign([0], {map: () => [\'<script>\']})");\n res.send(`<main>${rows.map(()=>"<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "direct-eval-control",
      content:
        'import express from "express"; const app=express();\napp.get("/",(req,res)=>{\n const rows:number[]=eval("[0]");\n res.send(`<main>${rows.map(()=>"<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "indirect-eval-mutation",
      content:
        'import express from "express"; const app=express();\napp.get("/",(req,res)=>{\n const rows:number[]=(0, eval)("Object.assign([0], {map: () => [\'<script>\']})");\n res.send(`<main>${rows.map(()=>"<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "indirect-eval-control",
      content:
        'import express from "express"; const app=express();\napp.get("/",(req,res)=>{\n const rows:number[]=(0, eval)("[0]");\n res.send(`<main>${rows.map(()=>"<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "aliased-eval-mutation",
      content:
        'import express from "express"; const app=express();const run=eval;\napp.get("/",(req,res)=>{\n const rows:number[]=run("Object.assign([0], {map: () => [\'<script>\']})");\n res.send(`<main>${rows.map(()=>"<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "aliased-eval-control",
      content:
        'import express from "express"; const app=express();const run=eval;\napp.get("/",(req,res)=>{\n const rows:number[]=run("[0]");\n res.send(`<main>${rows.map(()=>"<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "direct-eval-define-property-review-reproduction",
      content:
        'import express from "express"; const app=express();\napp.get("/",(req,res)=>{\n const rows:number[]=eval("Object.defineProperty([0], \'map\', {value: () => [\'<script>\']})");\n res.send(`<main>${rows.map(()=>"<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 0,
    },
    {
      id: "plain-array-retains-source-edge",
      content:
        'import express from "express"; const app=express();\napp.get("/",(req,res)=>{\n const rows:number[]=[0];\n res.send(`<main>${rows.map(()=>"<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "local-factory-retains-source-edge",
      content:
        'import express from "express"; const app=express(); function loadRows() { return [0]; }\napp.get("/",(req,res)=>{\n const rows:number[]=loadRows();\n res.send(`<main>${rows.map(()=>"<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
    {
      id: "external-query-retains-declared-contract",
      content:
        'import express from "express"; const app=express(); import { loadRows } from "external-data-client";\napp.get("/",(req,res)=>{\n const rows:number[]=loadRows();\n res.send(`<main>${rows.map(()=>"<span>Safe</span>").join("")}<a href="/target">Go</a></script></main>`);\n});\napp.get("/target",(req,res)=>res.send("<main>Target</main>"));',
      expectedEdges: 1,
    },
  ])("$id", (item) => {
    const graph = discoverSourcePageMap([file("index.ts", item.content)]);
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
