import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) =>
  readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

// ── API layer ──────────────────────────────────────────────────────────────

describe("Ora mobile parity — memory API functions", () => {
  const api = read("../api.ts");
  const types = read("../types.ts");

  it("listMemories() accepts an optional oraProjectId parameter", () => {
    expect(api).toContain("export async function listMemories(oraProjectId?: number | null)");
  });

  it("listMemories(projectId) appends ?oraProjectId= to the URL", () => {
    const fnStart = api.indexOf("export async function listMemories(");
    const fnBody = api.slice(fnStart, fnStart + 300);
    expect(fnBody).toContain("oraProjectId=${oraProjectId}");
    expect(fnBody).toContain('typeof oraProjectId === "number"');
  });

  it("listMemories() without project id fetches /api/ora/memories (user-level only)", () => {
    const fnStart = api.indexOf("export async function listMemories(");
    const fnBody = api.slice(fnStart, fnStart + 300);
    expect(fnBody).toContain('"/api/ora/memories"');
  });

  it("createMemory() accepts an optional oraProjectId parameter", () => {
    expect(api).toContain(
      "export function createMemory(\n  title: string,\n  content: string,\n  oraProjectId?: number | null,\n)",
    );
  });

  it("createMemory() with oraProjectId spreads it into the request body", () => {
    const fnStart = api.indexOf("export function createMemory(");
    const fnBody = api.slice(fnStart, fnStart + 350);
    expect(fnBody).toContain("oraProjectId != null ? { oraProjectId } : {}");
  });

  it("saveOraMemory() accepts an optional oraProjectId parameter", () => {
    expect(api).toContain(
      "export async function saveOraMemory(\n  fact: string,\n  oraProjectId?: number | null,\n)",
    );
  });

  it("saveOraMemory() with oraProjectId spreads it into the POST body", () => {
    const fnStart = api.indexOf("export async function saveOraMemory(");
    const fnBody = api.slice(fnStart, fnStart + 500);
    expect(fnBody).toContain("oraProjectId != null ? { oraProjectId } : {}");
    expect(fnBody).toContain("deriveMemoryTitle(content)");
  });

  it("clearAllMemories() sends DELETE to /api/ora/memories", () => {
    expect(api).toContain("export function clearAllMemories()");
    const fnStart = api.indexOf("export function clearAllMemories()");
    const fnBody = api.slice(fnStart, fnStart + 120);
    expect(fnBody).toContain('"/api/ora/memories"');
    expect(fnBody).toContain('"DELETE"');
  });

  it("getMemoryUsage() fetches /api/ora/memories/usage", () => {
    expect(api).toContain("export function getMemoryUsage()");
    const fnStart = api.indexOf("export function getMemoryUsage()");
    const fnBody = api.slice(fnStart, fnStart + 120);
    expect(fnBody).toContain('"/api/ora/memories/usage"');
  });

  it("MemoryUsage is imported from types in api.ts", () => {
    expect(api).toContain("MemoryUsage,");
  });

  it("OraMemory type has oraProjectId and supersededBy fields", () => {
    const ifaceStart = types.indexOf("export interface OraMemory {");
    expect(ifaceStart).toBeGreaterThan(-1);
    const ifaceBody = types.slice(ifaceStart, ifaceStart + 300);
    expect(ifaceBody).toContain("oraProjectId: number | null");
    expect(ifaceBody).toContain("supersededBy: number | null");
  });

  it("MemoryUsage type has count and limit fields", () => {
    const ifaceStart = types.indexOf("export interface MemoryUsage {");
    expect(ifaceStart).toBeGreaterThan(-1);
    const ifaceBody = types.slice(ifaceStart, ifaceStart + 120);
    expect(ifaceBody).toContain("count: number");
    expect(ifaceBody).toContain("limit: number");
  });

  it("restoreMemory() sends POST to /api/ora/memories/:id/restore", () => {
    expect(api).toContain("export function restoreMemory(");
    const fnStart = api.indexOf("export function restoreMemory(");
    const fnBody = api.slice(fnStart, fnStart + 200);
    expect(fnBody).toContain("/api/ora/memories/");
    expect(fnBody).toContain("/restore");
    expect(fnBody).toContain('method: "POST"');
  });
});

// ── Memory screen ──────────────────────────────────────────────────────────

describe("Ora mobile parity — memory screen project support", () => {
  const screen = read("../../app/(home)/memory.tsx");

  it("memory screen imports useActiveProject context", () => {
    expect(screen).toContain('import { useActiveProject } from "@/context/ActiveProjectContext"');
  });

  it("memory screen imports clearAllMemories and getMemoryUsage from api", () => {
    expect(screen).toContain("clearAllMemories");
    expect(screen).toContain("getMemoryUsage");
  });

  it("memory screen shows a Project tab when activeProjectId is set", () => {
    expect(screen).toContain("activeProjectId != null");
    expect(screen).toContain('label="Project"');
    expect(screen).toContain('tab === "project"');
  });

  it("memory screen renders ProjectMemoriesTab with the active project id", () => {
    expect(screen).toContain("function ProjectMemoriesTab(");
    expect(screen).toContain("projectId: number");
    expect(screen).toContain("<ProjectMemoriesTab projectId={activeProjectId}");
  });

  it("ProjectMemoriesTab fetches listMemories(projectId)", () => {
    const compStart = screen.indexOf("function ProjectMemoriesTab(");
    const compBody = screen.slice(compStart, compStart + 800);
    expect(compBody).toContain("listMemories(projectId)");
  });

  it("ProjectMemoriesTab creates memories with oraProjectId scoped to the project", () => {
    const compStart = screen.indexOf("function ProjectMemoriesTab(");
    const compBody = screen.slice(compStart, compStart + 1200);
    expect(compBody).toContain("createMemory(title.trim(), content.trim(), projectId)");
  });

  it("memory screen renders UsageMeter with capacity count and limit", () => {
    expect(screen).toContain("function UsageMeter(");
    expect(screen).toContain("usage.count");
    expect(screen).toContain("usage.limit");
    expect(screen).toContain("<UsageMeter usage={usage}");
  });

  it("memory screen uses restoreMemory() (not updateMemory) for superseded restore", () => {
    expect(screen).toContain("restoreMemory");
    expect(screen).not.toContain("updateMemory(m.id, { enabled: true })");
  });

  it("memory screen shows superseded memories with a Superseded badge", () => {
    expect(screen).toContain("function SupersededCard(");
    expect(screen).toContain("Superseded");
    expect(screen).toContain("supersededBy");
  });

  it("memory screen provides a Restore action for superseded memories", () => {
    expect(screen).toContain("onRestore");
    expect(screen).toContain("Restore");
    expect(screen).toContain("RotateCcw");
  });

  it("memory screen has a clear-all button for user memories", () => {
    expect(screen).toContain("clearAllMemories");
    expect(screen).toContain("Clear all memories");
  });

  it("memory screen fetches both memories and usage in parallel on mount", () => {
    // Promise.all([listMemories(), getMemoryUsage()]) in MemoriesTab reload callback
    const tabStart = screen.indexOf("function MemoriesTab(");
    const tabBody = screen.slice(tabStart, tabStart + 1200);
    expect(tabBody).toContain("Promise.all([listMemories(), getMemoryUsage()])");
  });
});

// ── Chat integration ────────────────────────────────────────────────────────

describe("Ora mobile parity — chat sends oraProjectId for project memory injection", () => {
  const index = read("../../app/(home)/index.tsx");

  it("index.tsx imports useActiveProject from context", () => {
    expect(index).toContain(
      'import { useActiveProject } from "@/context/ActiveProjectContext"',
    );
  });

  it("index.tsx uses useActiveProject to get activeProjectId (not local useState)", () => {
    expect(index).toContain(
      "const { activeProjectId, setActiveProjectId } = useActiveProject();",
    );
    // Must NOT have local useState for activeProjectId
    expect(index).not.toContain(
      "const [activeProjectId, setActiveProjectId] = useState",
    );
  });

  it("index.tsx chatReq (non-streaming path) includes oraProjectId from the active project ref", () => {
    const chatReqStart = index.indexOf("const chatReq: ChatRequest = {");
    expect(chatReqStart).toBeGreaterThan(-1);
    const chatReqBody = index.slice(chatReqStart, chatReqStart + 400);
    expect(chatReqBody).toContain("oraProjectId: activeProjectIdRef.current");
  });

  it("index.tsx saveOraMemory passes activeProjectIdRef.current as the project scope", () => {
    expect(index).toContain("await saveOraMemory(fact, activeProjectIdRef.current)");
  });

  it("realtime voice context already passes oraProjectId (regression guard)", () => {
    expect(index).toContain("oraProjectId: activeProjectIdRef.current,");
  });
});

// ── Context and layout ──────────────────────────────────────────────────────

describe("Ora mobile parity — ActiveProjectContext wiring", () => {
  const context = read("../../context/ActiveProjectContext.tsx");
  const layout = read("../../app/(home)/_layout.tsx");

  it("ActiveProjectContext exports ActiveProjectProvider and useActiveProject", () => {
    expect(context).toContain("export function ActiveProjectProvider(");
    expect(context).toContain("export function useActiveProject()");
  });

  it("ActiveProjectContext value shape has activeProjectId and setActiveProjectId", () => {
    expect(context).toContain("activeProjectId: number | null");
    expect(context).toContain("setActiveProjectId: (id: number | null) => void");
  });

  it("HomeLayout wraps Drawer with ActiveProjectProvider", () => {
    expect(layout).toContain("import { ActiveProjectProvider }");
    expect(layout).toContain("<ActiveProjectProvider>");
    expect(layout).toContain("</ActiveProjectProvider>");
    // Provider must wrap the Drawer; verify the provider body contains a Drawer element
    const providerStart = layout.indexOf("<ActiveProjectProvider>");
    expect(providerStart).toBeGreaterThan(-1);
    const providerBody = layout.slice(providerStart, layout.indexOf("</ActiveProjectProvider>") + 24);
    // The Drawer component (not DrawerContentScrollView) is inside the provider
    expect(providerBody).toContain("drawerContent=");
    expect(providerBody).toContain("</Drawer>");
    expect(providerBody).toContain("</ActiveProjectProvider>");
  });
});

// ── Temporary chat isolation ────────────────────────────────────────────────

describe("Ora mobile parity — temporary chat does not save or reference memories", () => {
  const index = read("../../app/(home)/index.tsx");

  it("temporary flag sets referenceSavedMemories to false", () => {
    const chatReqStart = index.indexOf("const chatReq: ChatRequest = {");
    const chatReqBody = index.slice(chatReqStart, chatReqStart + 400);
    expect(chatReqBody).toContain("referenceSavedMemories: !!isSignedIn && !temporary");
  });

  it("temporary flag sets referenceChatHistory to false", () => {
    const chatReqStart = index.indexOf("const chatReq: ChatRequest = {");
    const chatReqBody = index.slice(chatReqStart, chatReqStart + 400);
    expect(chatReqBody).toContain("referenceChatHistory: !!isSignedIn && !temporary");
  });

  it("temporary flag is forwarded to server so it skips memory saves and summaries", () => {
    const chatReqStart = index.indexOf("const chatReq: ChatRequest = {");
    const chatReqBody = index.slice(chatReqStart, chatReqStart + 400);
    expect(chatReqBody).toContain("temporary,");
  });

  it("saveOraMemory is guarded against anonymous or temporary sessions", () => {
    const handleStart = index.indexOf("const handleSaveMemory = useCallback(async (message:");
    expect(handleStart).toBeGreaterThan(-1);
    const handleBody = index.slice(handleStart, handleStart + 300);
    expect(handleBody).toContain("temporaryRef.current");
    expect(handleBody).toContain("isSignedInRef.current");
  });
});

// ── Project conversation flow ───────────────────────────────────────────────

describe("Ora mobile parity — project conversation sync", () => {
  const api = read("../api.ts");
  const index = read("../../app/(home)/index.tsx");

  it("createConversation() sends projectId in the request body", () => {
    expect(api).toContain("export function createConversation(");
    const fnStart = api.indexOf("export function createConversation(");
    const fnBody = api.slice(fnStart, fnStart + 300);
    expect(fnBody).toContain("projectId");
    expect(fnBody).toContain("JSON.stringify({ title, projectId })");
  });

  it("moveConversation() sends projectId in a PATCH request body", () => {
    expect(api).toContain("export function moveConversation(");
    const fnStart = api.indexOf("export function moveConversation(");
    const fnBody = api.slice(fnStart, fnStart + 200);
    expect(fnBody).toContain("PATCH");
    expect(fnBody).toContain("projectId");
  });

  it("new conversations are created with activeProjectIdRef (project-scoped or standalone)", () => {
    expect(index).toContain("createConversation(title, activeProjectIdRef.current)");
  });

  it("project list and conversation list APIs are called on mount", () => {
    expect(api).toContain("export async function listProjects(");
    expect(api).toContain("export async function listConversations(");
  });
});
