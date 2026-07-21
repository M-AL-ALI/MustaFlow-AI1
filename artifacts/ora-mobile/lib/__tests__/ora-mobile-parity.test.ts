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

  it("listMemories() accepts an optional scope (project id, 'all', or null)", () => {
    // Phase 7: the scope can also be "all" to list every memory across scopes.
    expect(api).toContain('export async function listMemories(scope?: number | "all" | null)');
  });

  it("listMemories(projectId) appends ?oraProjectId= to the URL", () => {
    const fnStart = api.indexOf("export async function listMemories(");
    const fnBody = api.slice(fnStart, fnStart + 300);
    expect(fnBody).toContain("oraProjectId=${scope}");
    expect(fnBody).toContain('typeof scope === "number"');
  });

  it("listMemories() without project id fetches /api/ora/memories (user-level only)", () => {
    const fnStart = api.indexOf("export async function listMemories(");
    const fnBody = api.slice(fnStart, fnStart + 300);
    expect(fnBody).toContain('"/api/ora/memories"');
  });

  it("createMemory() accepts an optional oraProjectId parameter", () => {
    const fnStart = api.indexOf("export function createMemory(");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = api.slice(fnStart, fnStart + 400);
    expect(fnBody).toContain("title: string");
    expect(fnBody).toContain("content: string");
    expect(fnBody).toContain("oraProjectId?: number | null");
  });

  it("createMemory() with oraProjectId spreads it into the request body", () => {
    const fnStart = api.indexOf("export function createMemory(");
    const fnBody = api.slice(fnStart, fnStart + 350);
    expect(fnBody).toContain("oraProjectId != null ? { oraProjectId } : {}");
  });

  it("saveOraMemory() accepts an optional oraProjectId parameter", () => {
    expect(api).toContain("export async function saveOraMemory(");
    const fnStart = api.indexOf("export async function saveOraMemory(");
    const fnSig = api.slice(fnStart, fnStart + 120);
    expect(fnSig).toContain("fact: string");
    expect(fnSig).toContain("oraProjectId?: number | null");
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

  it("memory screen fetches memories, usage, and project names in parallel on mount", () => {
    // Phase 7: MemoriesTab loads ALL scopes plus project names for badges;
    // the project fetch is non-fatal so a failure degrades to badge-less view.
    const tabStart = screen.indexOf("function MemoriesTab(");
    const tabBody = screen.slice(tabStart, tabStart + 3000);
    expect(tabBody).toContain('listMemories("all")');
    expect(tabBody).toContain("getMemoryUsage()");
    expect(tabBody).toContain("listProjects(true).catch(() => [] as OraProjectSummary[])");
  });
});

// ── Chat integration ────────────────────────────────────────────────────────

describe("Ora mobile parity — chat sends oraProjectId for project memory injection", () => {
  const index = read("../../app/(home)/index.tsx");

  it("index.tsx imports useActiveProject from context", () => {
    expect(index).toContain('import { useActiveProject } from "@/context/ActiveProjectContext"');
  });

  it("index.tsx uses useActiveProject to get activeProjectId (not local useState)", () => {
    expect(index).toContain("const { activeProjectId, setActiveProjectId } = useActiveProject();");
    // Must NOT have local useState for activeProjectId
    expect(index).not.toContain("const [activeProjectId, setActiveProjectId] = useState");
  });

  it("index.tsx chatReq (non-streaming path) includes oraProjectId from the active project ref", () => {
    const chatReqStart = index.indexOf("const chatReq: ChatRequest = {");
    expect(chatReqStart).toBeGreaterThan(-1);
    // Use closing }; as the end marker rather than a fixed char count so new fields don't break this
    const chatReqEnd = index.indexOf("};", chatReqStart);
    const chatReqBody = index.slice(chatReqStart, chatReqEnd + 2);
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
    const providerBody = layout.slice(
      providerStart,
      layout.indexOf("</ActiveProjectProvider>") + 24,
    );
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
    const chatReqEnd = index.indexOf("};", chatReqStart);
    const chatReqBody = index.slice(chatReqStart, chatReqEnd + 2);
    // Wired through getReferenceSavedMemories() preference AND isSignedIn AND !temporary
    expect(chatReqBody).toContain("getReferenceSavedMemories()");
    expect(chatReqBody).toContain("!!isSignedIn && !temporary");
  });

  it("temporary flag sets referenceChatHistory to false", () => {
    const chatReqStart = index.indexOf("const chatReq: ChatRequest = {");
    const chatReqEnd = index.indexOf("};", chatReqStart);
    const chatReqBody = index.slice(chatReqStart, chatReqEnd + 2);
    // Wired through getReferenceChatHistory() preference AND isSignedIn AND !temporary
    expect(chatReqBody).toContain("getReferenceChatHistory()");
    expect(chatReqBody).toContain("!!isSignedIn && !temporary");
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

// ── Streaming gate parity ───────────────────────────────────────────────────

describe("Ora mobile parity — streamChatNative gate matches website behaviour", () => {
  const api = read("../api.ts");

  it("streaming gate is opt-out (=== false) not opt-in (!== true)", () => {
    const fnStart = api.indexOf("export async function streamChatNative(");
    expect(fnStart).toBeGreaterThan(-1);
    // Use 3000 chars so the diagnostics init block doesn't push the kill-switch
    // check past the window (the diag struct is ~400 chars before the gate).
    const fnBody = api.slice(fnStart, fnStart + 3000);
    // New gate: kill switch fires only when explicitly "false"
    expect(fnBody).toContain('EXPO_PUBLIC_ORA_STREAMING_ENABLED === "false"');
    // Old opt-in gate must NOT appear
    expect(fnBody).not.toContain('EXPO_PUBLIC_ORA_STREAMING_ENABLED !== "true"');
  });

  it("onToken signature accepts async callbacks (void | Promise<void>)", () => {
    const fnStart = api.indexOf("export async function streamChatNative(");
    const signatureBody = api.slice(fnStart, fnStart + 200);
    expect(signatureBody).toContain("void | Promise<void>");
  });

  it("onToken is awaited via Promise.resolve for async safety", () => {
    expect(api).toContain("await Promise.resolve(onToken(text))");
  });

  it("SSE buffer normalizes CRLF line endings before splitting", () => {
    // The pattern is unique to streamChatNative; search the full file rather
    // than a fixed-size slice so it doesn't break when the function grows.
    expect(api).toContain('.replace(/\\r\\n/g, "\\n").replace(/\\r/g, "\\n")');
    // Must appear inside the function body (after its declaration)
    const fnStart = api.indexOf("export async function streamChatNative(");
    expect(api.indexOf('.replace(/\\r\\n/g, "\\n")', fnStart)).toBeGreaterThan(fnStart);
  });

  it("55ms yield between tokens is present for React Native word-by-word paint", () => {
    expect(api).toContain("setTimeout(resolve, 55)");
    const fnStart = api.indexOf("export async function streamChatNative(");
    expect(api.indexOf("setTimeout(resolve, 55)", fnStart)).toBeGreaterThan(fnStart);
  });

  it("settings STREAMING_ENABLED constant mirrors the opt-out gate", () => {
    const settings = read("../../app/(home)/settings.tsx");
    expect(settings).toContain('EXPO_PUBLIC_ORA_STREAMING_ENABLED !== "false"');
    expect(settings).not.toContain('EXPO_PUBLIC_ORA_STREAMING_ENABLED === "true"');
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

describe("Ora mobile parity — Retry live search (forceSearch)", () => {
  const types = read("../types.ts");
  const index = read("../../app/(home)/index.tsx");

  it("ChatRequest carries the optional forceSearch flag (matches the website body)", () => {
    expect(types).toContain("forceSearch?: boolean;");
  });

  it("sendMessage accepts a forceSearch option alongside truncateTo", () => {
    expect(index).toContain("opts?: { truncateTo?: number; forceSearch?: boolean }");
  });

  it("forceSearch is threaded into the /chat request body", () => {
    expect(index).toContain("...(opts?.forceSearch ? { forceSearch: true } : {})");
  });

  it("forced search skips streaming and POSTs straight to /chat via sendChat", () => {
    // The stream route bounces the search tool back with a streamingFallback
    // signal, so a forced live search must use the non-streaming sendChat path
    // (mirrors use-ora-chat.ts on the website).
    const branchStart = index.indexOf("if (opts?.forceSearch) {");
    expect(branchStart).toBeGreaterThan(-1);
    const branchBody = index.slice(branchStart, branchStart + 700);
    expect(branchBody).toContain("const res = await sendChat(chatReq);");
  });

  it("a retryable 503 (searchRetryable) is detected via ApiRequestError body", () => {
    expect(index).toContain("err instanceof ApiRequestError");
    expect(index).toContain("(err.body as { searchRetryable?: unknown }).searchRetryable === true");
    // The flagged error message must carry searchRetryable so the bubble keeps
    // the Retry affordance instead of showing a dead error banner.
    expect(index).toContain("...(searchRetryable ? { searchRetryable: true } : {})");
  });

  it("handleRetrySearch replays the user turn with forceSearch:true", () => {
    expect(index).toContain("const handleRetrySearch = useCallback(");
    const fnStart = index.indexOf("const handleRetrySearch = useCallback(");
    const fnBody = index.slice(fnStart, fnStart + 700);
    expect(fnBody).toContain("{ truncateTo: userIdx, forceSearch: true }");
  });

  it("the message row wires Retry live search to handleRetrySearch (not plain regenerate)", () => {
    expect(index).toContain("onRetrySearch={handleRetrySearch}");
  });

  it("the error branch renders a Retry live search affordance for retryable failures", () => {
    // Both the success-fallback (searchFallback) and the forced-503 error bubble
    // must expose Retry. The error branch specifically guards on message.error.
    expect(index).toContain("message.searchRetryable && isLatest && (");
    expect(index).toContain('accessibilityLabel="Retry live search"');
  });
});

describe("Ora mobile parity — conversation history v2 completion", () => {
  const api = read("../api.ts");
  const index = read("../../app/(home)/index.tsx");
  const memory = read("../../app/(home)/memory.tsx");

  it("listConversations accepts backend search/pagination/archive query options", () => {
    expect(api).toContain("export interface ListConversationsOptions");
    expect(api).toContain("q?: string;");
    expect(api).toContain("limit?: number;");
    expect(api).toContain("offset?: number;");
    expect(api).toContain("archived?: boolean;");
    expect(api).toContain('params.set("q", q)');
    expect(api).toContain('params.set("limit", String(options.limit))');
    expect(api).toContain('params.set("archived", "true")');
  });

  it("mobile chat drawer search calls the backend instead of only filtering loaded rows", () => {
    expect(index).toContain("onSearchConversations={searchChatLists}");
    expect(index).toContain("listConversations({ q, limit: 100 })");
    expect(index).toContain("const filtered = conversations;");
    expect(index).not.toContain(
      '(cv.preview ?? "").toLowerCase().includes(searchQuery.toLowerCase())',
    );
  });

  it("mobile restores the server-synced last active conversation on clean launch", () => {
    expect(index).toContain("lastActiveRestoreAttemptedRef");
    expect(index).toContain("getOraUserSettings()");
    expect(index).toContain("settings.lastConversationId");
    expect(index).toContain("void loadConversation(settings.lastConversationId)");
  });

  it("mobile History exposes archived conversations with restore and permanent delete", () => {
    expect(memory).toContain("listArchivedConversations({ q, limit: 100 })");
    expect(memory).toContain("restoreConversation(id)");
    expect(memory).toContain("permanentDeleteConversation(id)");
    expect(memory).toContain("Show archived");
    expect(memory).toContain("Delete forever");
  });

  it("mobile data controls use archive wording for the soft-delete all endpoint", () => {
    expect(memory).toContain("Archive all conversations");
    expect(memory).toContain("All conversations archived.");
    expect(memory).not.toContain("Permanently delete all your Ora conversations and messages");
  });
});

describe("Ora mobile parity - explicit Back to Ora escape paths", () => {
  const screenHeader = read("../../components/ScreenHeader.tsx");
  const settings = read("../../app/(home)/settings.tsx");
  const memory = read("../../app/(home)/memory.tsx");
  const library = read("../../app/(home)/library.tsx");
  const help = read("../../app/(home)/help.tsx");
  const orax = read("../../app/(home)/orax.tsx");

  it("shared secondary-screen header keeps the menu and adds a direct Back to Ora action", () => {
    expect(screenHeader).toContain("showBackToOra?: boolean;");
    expect(screenHeader).toContain('accessibilityLabel="Open Ora menu"');
    expect(screenHeader).toContain('accessibilityLabel="Back to Ora"');
    expect(screenHeader).toContain('router.replace("/(home)")');
  });

  it("Settings, Memory, Library, and Help opt into the Back to Ora action", () => {
    for (const source of [settings, memory, library, help]) {
      expect(source).toContain("showBackToOra");
    }
  });

  it("mobile Orax always exposes Back to Ora separately from its thread/menu button", () => {
    expect(orax).toContain("const router = useRouter();");
    expect(orax).toContain('accessibilityLabel="Back to Ora"');
    expect(orax).toContain('router.replace("/(home)")');
    expect(orax).toContain("setWorkspaceMenuOpen(true)");
    expect(orax).toContain("setThreadOpen(false)");
  });
});
