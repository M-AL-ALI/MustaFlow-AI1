import { describe, expect, it } from "vitest";
import { discoverSourcePageMap, stabilizeSourcePageMap } from "./page-map-source";
import type { BuilderFile } from "./builder";
import type { PageMapPlatform } from "./page-map";

const file = (path: string, content: string): BuilderFile => ({
  path,
  content,
  mimeType: path.endsWith(".html") ? "text/html" : "text/plain",
});

function routeNode(map: PageMapPlatform, route: string) {
  const node = map.nodes.find((entry) => entry.notes.split("\n")[0] === "Route: " + route);
  if (!node) throw new Error("Missing route: " + route);
  return node;
}

function destinations(map: PageMapPlatform, sourceRoute: string) {
  const source = routeNode(map, sourceRoute);
  return map.edges
    .filter((edge) => edge.source === source.id)
    .map((edge) => {
      const target = map.nodes.find((node) => node.id === edge.target);
      return target?.notes.split("\n")[0].replace(/^Route: /, "");
    })
    .sort();
}

function accountFiles(content: string): BuilderFile[] {
  return [
    file(
      "src/App.tsx",
      [
        'import {Route} from "react-router-dom";',
        'import Account from "./Account"; import RootSettings from "./RootSettings"; import AccountSettings from "./AccountSettings";',
        'export const App=()=> <><Route path="/account" element={<Account/>}/><Route path="/settings" element={<RootSettings/>}/><Route path="/account/settings" element={<AccountSettings/>}/></>;',
      ].join("\n"),
    ),
    file("src/Account.tsx", content),
    file("src/RootSettings.tsx", "export default function RootSettings(){return null;}"),
    file("src/AccountSettings.tsx", "export default function AccountSettings(){return null;}"),
  ];
}

describe("collision-safe source identities", () => {
  it.each([false, true])(
    "preserves an inherited ID when its old route is reused, reversed=%s",
    (reversed) => {
      const prior = discoverSourcePageMap([
        file(
          "src/App.tsx",
          'import {Route} from "react-router-dom"; import Account from "./Account"; const App=()=> <Route path="/account" element={<Account/>}/>;',
        ),
        file("src/Account.tsx", "export default function Account(){return null;}"),
      ]);
      const routes = [
        '<Route path="/profile" element={<Account/>}/>',
        '<Route path="/account" element={<NewAccount/>}/>',
      ];
      if (reversed) routes.reverse();
      const discovered = discoverSourcePageMap([
        file(
          "src/App.tsx",
          'import {Route} from "react-router-dom"; import Account from "./Account"; import NewAccount from "./NewAccount"; const App=()=> <>' +
            routes.join("") +
            "</>;",
        ),
        file(
          "src/Account.tsx",
          'export default function Account(){return <a href="/account">New account</a>;}',
        ),
        file(
          "src/NewAccount.tsx",
          'export default function NewAccount(){return <a href="/profile">Profile</a>;}',
        ),
      ]);
      const originalIds = discovered.nodes.map((node) => node.id);
      const result = stabilizeSourcePageMap(discovered, prior);
      expect(routeNode(result, "/profile").id).toBe(routeNode(prior, "/account").id);
      expect(routeNode(result, "/account").id).not.toBe(routeNode(prior, "/account").id);
      expect(new Set(result.nodes.map((node) => node.id)).size).toBe(2);
      expect(destinations(result, "/profile")).toEqual(["/account"]);
      expect(destinations(result, "/account")).toEqual(["/profile"]);
      expect(result.edges.every((edge) => edge.source !== edge.target)).toBe(true);
      expect(stabilizeSourcePageMap(discovered, result)).toEqual(result);
      expect(discovered.nodes.map((node) => node.id)).toEqual(originalIds);
    },
  );

  it("does not give a newly discovered page an identity reserved by a manual page", () => {
    const discovered = discoverSourcePageMap(
      accountFiles('export default function Account(){return <a href="/settings">Settings</a>;}'),
    );
    const manual = {
      ...routeNode(discovered, "/account"),
      aiGenerated: false,
      filePath: "src/Manual.tsx",
    };
    const result = stabilizeSourcePageMap(discovered, { nodes: [manual], edges: [] });
    expect(result.nodes.some((node) => node.id === manual.id)).toBe(false);
    expect(destinations(result, "/account")).toEqual(["/settings"]);
    expect(new Set(result.nodes.map((node) => node.id)).size).toBe(result.nodes.length);
  });
});

describe("index-page component precedence", () => {
  it("uses the index page file and its links instead of the parent layout", () => {
    const map = discoverSourcePageMap([
      file(
        "src/App.tsx",
        [
          'import {Route} from "react-router-dom"; import Layout from "./Layout"; import Dashboard from "./Dashboard"; import Settings from "./Settings";',
          'const App=()=> <Route path="/dashboard" element={<Layout/>}><Route index element={<Dashboard/>}/><Route path="settings" element={<Settings/>}/></Route>;',
        ].join("\n"),
      ),
      file(
        "src/Layout.tsx",
        'export default function Layout(){return <a href="/dashboard/settings">Shared navigation</a>;}',
      ),
      file(
        "src/Dashboard.tsx",
        'import {Link} from "react-router-dom"; export default function Dashboard(){return <Link to="settings">Settings</Link>;}',
      ),
      file("src/Settings.tsx", "export default function Settings(){return null;}"),
    ]);
    expect(map.nodes).toHaveLength(2);
    expect(routeNode(map, "/dashboard").filePath).toBe("src/Dashboard.tsx");
    expect(destinations(map, "/dashboard")).toEqual(["/dashboard/settings"]);
    expect(map.nodes.some((node) => node.filePath === "src/Layout.tsx")).toBe(false);
  });

  it("does not turn a prefix-only parent Route into a page", () => {
    const map = discoverSourcePageMap([
      file(
        "src/App.tsx",
        'import {Route} from "react-router-dom"; import Child from "./Child"; const App=()=> <Route path="/prefix"><Route path="child" element={<Child/>}/></Route>;',
      ),
      file("src/Child.tsx", "export default function Child(){return null;}"),
    ]);
    expect(map.nodes).toHaveLength(1);
    expect(routeNode(map, "/prefix/child").filePath).toBe("src/Child.tsx");
  });
});

describe("router-relative and browser-relative navigation", () => {
  it.each([
    {
      name: "Link",
      source:
        'import {Link} from "react-router-dom"; export default function Account(){return <Link to="settings">Settings</Link>;}',
      target: "/account/settings",
      kind: "nav",
    },
    {
      name: "aliased NavLink",
      source:
        'import {NavLink as Go} from "react-router"; export default function Account(){return <Go to="./settings">Settings</Go>;}',
      target: "/account/settings",
      kind: "nav",
    },
    {
      name: "Navigate",
      source:
        'import {Navigate} from "react-router-dom"; export default function Account(){return <Navigate to="settings"/>;}',
      target: "/account/settings",
      kind: "redirect",
    },
    {
      name: "useNavigate",
      source:
        'import {useNavigate} from "react-router-dom"; export default function Account(){const navigate=useNavigate(); return <button onClick={()=>navigate("settings")}>Settings</button>;}',
      target: "/account/settings",
      kind: "redirect",
    },
    {
      name: "native anchor",
      source: 'export default function Account(){return <a href="settings">Settings</a>;}',
      target: "/settings",
      kind: "nav",
    },
    {
      name: "native form",
      source: 'export default function Account(){return <form action="./settings"/>;}',
      target: "/settings",
      kind: "nav",
    },
  ])("resolves $name using its own navigation semantics", ({ source, target, kind }) => {
    const map = discoverSourcePageMap(accountFiles(source));
    expect(destinations(map, "/account")).toEqual([target]);
    expect(map.edges[0].connectionType).toBe(kind);
  });

  it("retains the document directory when resolving links from an HTML index", () => {
    const map = discoverSourcePageMap([
      file("public/docs/index.html", '<a href="guide.html">Local guide</a>'),
      file("public/docs/guide.html", "<title>Local guide</title>"),
      file("public/guide.html", "<title>Root guide</title>"),
    ]);
    expect(destinations(map, "/docs")).toEqual(["/docs/guide.html"]);
  });

  it.each([
    'import {Link} from "wouter"; export default function Account(){return <><Link href="settings">Unknown base</Link><Link href="/settings">Absolute</Link></>;}',
    'import Link from "next/link"; export default function Account(){return <><Link href="settings">Unknown base</Link><Link href="/settings">Absolute</Link></>;}',
    'import {Link} from "react-router-dom"; export default function Account(){return <><Link to="settings" relative={mode}>Unknown mode</Link><Link to="/settings">Absolute</Link></>;}',
  ])("omits ambiguous relative links but keeps declared absolute links", (source) => {
    const map = discoverSourcePageMap(accountFiles(source));
    expect(destinations(map, "/account")).toEqual(["/settings"]);
  });

  it("does not interpret arbitrary component props as router navigation", () => {
    const map = discoverSourcePageMap(
      accountFiles(
        'export default function Account(){return <CustomControl to="/settings" href="/account/settings"/>;}',
      ),
    );
    expect(map.edges).toEqual([]);
  });

  it("leaves parent-relative router navigation unmapped when ancestry is unresolved", () => {
    const map = discoverSourcePageMap(
      accountFiles(
        'import {Link} from "react-router-dom"; export default function Account(){return <Link to="../settings">Settings</Link>;}',
      ),
    );
    expect(map.edges).toEqual([]);
  });
});

describe("Unicode route canonicalization and unsafe destinations", () => {
  const unicodeRoute = "/" + String.fromCodePoint(0x062d, 0x0633, 0x0627, 0x0628);

  it.each([
    { route: unicodeRoute, href: unicodeRoute },
    { route: unicodeRoute, href: encodeURI(unicodeRoute) },
    { route: encodeURI(unicodeRoute), href: unicodeRoute },
  ])("matches equivalent literal and encoded route paths: %j", ({ route, href }) => {
    const map = discoverSourcePageMap([
      file(
        "src/App.tsx",
        'import {Route} from "react-router-dom"; import Home from "./Home"; import Account from "./Account"; const App=()=> <><Route path="/" element={<Home/>}/><Route path=' +
          JSON.stringify(route) +
          " element={<Account/>}/></>;",
      ),
      file(
        "src/Home.tsx",
        "export default function Home(){return <a href=" + JSON.stringify(href) + ">Account</a>;}",
      ),
      file("src/Account.tsx", "export default function Account(){return null;}"),
    ]);
    expect(routeNode(map, unicodeRoute).filePath).toBe("src/Account.tsx");
    expect(destinations(map, "/")).toEqual([unicodeRoute]);
  });

  it.each([
    "/../settings",
    "/%2e%2e/settings",
    "/%252e%252e/settings",
    "/%2fsettings",
    "/%5csettings",
    "\\settings",
    "/%00settings",
    "/%zz/settings",
    "//page-map.invalid/settings",
    "https://page-map.invalid/settings",
    "  https://page-map.invalid/settings  ",
    "https://outside.example/settings",
    "javascript:/settings",
  ])("does not normalize an unsafe target into a local edge: %s", (href) => {
    const map = discoverSourcePageMap(
      accountFiles(
        "export default function Account(){return <a href=" +
          JSON.stringify(href) +
          ">Settings</a>;}",
      ),
    );
    expect(map.edges).toEqual([]);
  });

  it.each(["/%2e%2e/settings", "/%2fsettings", "/%5csettings", "/%252e%252e/settings"])(
    "does not create a node for an encoded traversal or separator route: %s",
    (route) => {
      const map = discoverSourcePageMap([
        file(
          "src/App.tsx",
          'import {Route} from "react-router-dom"; const App=()=> <Route path=' +
            JSON.stringify(route) +
            " element={<div/>}/>;",
        ),
      ]);
      expect(map.nodes).toEqual([]);
    },
  );
});
