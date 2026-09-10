import { describe, expect, it } from "vitest";
import { discoverSourcePageMap, stabilizeSourcePageMap } from "./page-map-source";
import { mergePageMapNotes } from "./page-map";
import type { BuilderFile } from "./builder";
const file = (path: string, content: string): BuilderFile => ({
  path,
  content,
  mimeType: path.endsWith(".html") ? "text/html" : "text/plain",
});
const routes = (files: BuilderFile[]) =>
  discoverSourcePageMap(files)
    .nodes.map((node) => node.notes.split("\n")[0])
    .sort();
describe("source-backed Page Map discovery", () => {
  it("maps aliased React routes to their real component files and attributes links", () => {
    const result = discoverSourcePageMap([
      file(
        "src/App.tsx",
        'import { Route as Screen } from "react-router-dom"; import Home from "./Home"; import Account from "./Account"; export const App=()=> <><Screen path="/" element={<Home/>}/><Screen path="/account" element={<Account/>}/></>;',
      ),
      file(
        "src/Home.tsx",
        'export default function Home(){ return <a href="/account">Account</a>; }',
      ),
      file("src/Account.tsx", "export default function Account(){ return <h1>Account</h1>; }"),
      file("index.html", '<div id="root"></div>'),
    ]);
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes.find((node) => node.notes.startsWith("Route: /\n"))?.filePath).toBe(
      "src/Home.tsx",
    );
    expect(result.edges).toHaveLength(1);
    expect(result.nodes.every((node) => node.notes.includes("not been runtime verified"))).toBe(
      true,
    );
  });
  it("resolves nested paths and retains dynamic routes as unresolved patterns", () => {
    expect(
      routes([
        file(
          "src/App.tsx",
          'import {Route} from "react-router-dom"; const App=()=> <Route path="/account" element={<div/>}><Route path="settings" element={<div/>}/><Route path="users/:id" element={<div/>}/></Route>;',
        ),
      ]),
    ).toEqual(["Route: /account", "Route: /account/settings", "Route: /account/users/:id"]);
  });
  it("supports Wouter component routes without needing HTML or an AI call", () => {
    const result = discoverSourcePageMap([
      file(
        "src/App.tsx",
        'import {Route} from "wouter"; import Settings from "./Settings"; const App=()=> <Route path="/settings" component={Settings}/>;',
      ),
      file("src/Settings.tsx", "export default function Settings(){return null;}"),
    ]);
    expect(result.nodes[0]).toMatchObject({ filePath: "src/Settings.tsx", label: "Settings" });
  });
  it("does not mistake comments, strings, computed paths, or unrelated Route components for routes", () => {
    expect(
      routes([
        file(
          "src/App.tsx",
          'import {Route} from "react-router-dom"; const text="<Route path=\\"/fake\\"/>"; /* <Route path="/comment"/> */ const App=()=> <Route path={getPath()} element={<div/>}/>;',
        ),
        file("other.tsx", 'const App=()=> <Route path="/unrelated" element={<div/>}/>;'),
      ]),
    ).toEqual([]);
  });
  it("maps Next pages and route groups, but not API, layout, private or slot files", () => {
    expect(
      routes([
        file("package.json", '{"dependencies":{"next":"16.0.0"}}'),
        file(
          "src/app/(account)/settings/page.tsx",
          "export default function Settings(){return null;}",
        ),
        file("src/app/page.tsx", "export default function Home(){return null;}"),
        file("src/app/homepage.tsx", "export default function NotAPage(){return null;}"),
        file("src/app/layout.tsx", "export default function Layout(){return null;}"),
        file("src/app/@modal/login/page.tsx", "export default function Modal(){return null;}"),
        file("pages/api/users.ts", "export default function api(){}"),
        file("pages/_app.tsx", "export default function App(){return null;}"),
        file("pages/profile/[id].tsx", "export default function Profile(){return null;}"),
      ]),
    ).toEqual(["Route: /", "Route: /profile/[id]", "Route: /settings"]);
  });
  it("requires framework evidence before treating a pages folder as Next routes", () => {
    expect(
      routes([file("src/pages/Unused.tsx", "export default function Unused(){return null;}")]),
    ).toEqual([]);
  });
  it("maps HTML titles and actual links, not commented or external links", () => {
    const result = discoverSourcePageMap([
      file(
        "index.html",
        '<title>Home &amp; help</title><!-- <a href="fake.html">fake</a> --><a href="about.html">About</a><a href="https://outside.test/about.html">External</a>',
      ),
      file("about.html", "<title>About</title>"),
      file("fake.html", "<h1>Unused</h1>"),
    ]);
    expect(result.nodes.find((node) => node.filePath === "index.html")?.label).toBe("Home & help");
    expect(result.edges).toHaveLength(1);
  });
  it("handles literal Unicode routes and excludes traversal file paths", () => {
    const result = routes([
      file(
        "src/App.tsx",
        'import {Route} from "wouter"; const App=()=> <Route path="/\u062d\u0633\u0627\u0628" component={Account}/>;',
      ),
      file("../outside.html", "<h1>Outside</h1>"),
    ]);
    expect(result).toEqual(["Route: /\u062d\u0633\u0627\u0628"]);
  });
  it("does not guess a source when several routes share one file", () => {
    const result = discoverSourcePageMap([
      file(
        "App.tsx",
        'import {Route} from "wouter"; const App=()=> <><Route path="/" component={Home}/><Route path="/account" component={Account}/><a href="/account">Account</a></>;',
      ),
    ]);
    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toEqual([]);
  });
  it("retains stable prior node identities during fallback", () => {
    const discovered = discoverSourcePageMap([file("index.html", "Home")]);
    const existing = { nodes: [{ ...discovered.nodes[0], id: "prior-home" }], edges: [] };
    expect(stabilizeSourcePageMap(discovered, existing).nodes[0].id).toBe("prior-home");
  });
  it("updates the canonical route while preserving user notes", () => {
    expect(mergePageMapNotes("Route: /new\nSource-declared", "Route: /old\nKeep my notes")).toBe(
      "Route: /new\nKeep my notes",
    );
    expect(mergePageMapNotes("Route: /new\nSource-declared", "Keep my notes")).toBe(
      "Route: /new\nKeep my notes",
    );
  });
});
