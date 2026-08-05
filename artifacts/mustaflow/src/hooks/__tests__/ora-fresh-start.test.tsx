import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  IDLE_RESET_MS,
  ORA_HOME_RECENT_LIMIT,
  shouldResumeOraConversation,
} from "@workspace/ora-contracts";
import { OraHomeRecents } from "@/components/ora/ora-home-recents";
import {
  OraConversationsContext,
  type OraConversationSummary,
  type OraConversationsContextValue,
} from "@/hooks/ora-conversations-context";
import { idleGatedOraConversationId, markOraActive } from "@/lib/ora-idle-reset";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (relativePath: string) =>
  readFileSync(path.join(__dirname, relativePath), "utf8").replace(/\r\n/g, "\n");

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function conversation(id: number, projectId: number | null = null): OraConversationSummary {
  const timestamp = new Date(Date.UTC(2026, 0, id)).toISOString();
  return {
    id,
    title: `Conversation ${id}`,
    projectId,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastMessageAt: timestamp,
    preview: `Preview ${id}`,
  };
}

function conversationsContext(
  conversations: OraConversationSummary[],
  selectConversation = vi.fn(),
): OraConversationsContextValue {
  return {
    projects: [],
    conversations,
    currentConversationId: null,
    newConversationTick: 0,
    activeProjectId: null,
    activeProject: null,
    loading: false,
    refresh: vi.fn(async () => {}),
    selectConversation,
    newConversation: vi.fn(),
    ensureConversation: vi.fn(async () => null),
    notifyPersisted: vi.fn(),
    renameConversation: vi.fn(async () => {}),
    deleteConversation: vi.fn(async () => {}),
    restoreConversation: vi.fn(async () => {}),
    permanentDeleteConversation: vi.fn(async () => {}),
    moveConversation: vi.fn(async () => {}),
    pinConversation: vi.fn(async () => {}),
    createProject: vi.fn(async () => null),
    renameProject: vi.fn(async () => {}),
    deleteProject: vi.fn(async () => {}),
    restoreProject: vi.fn(async () => {}),
  };
}

describe("Ora fresh-start shared idle rule", () => {
  it("resumes through the exact five-minute boundary and resets immediately after it", () => {
    const now = Date.UTC(2026, 6, 24, 12);

    expect(shouldResumeOraConversation(now - IDLE_RESET_MS, now)).toBe(true);
    expect(shouldResumeOraConversation(now - IDLE_RESET_MS - 1, now)).toBe(false);
    expect(shouldResumeOraConversation(null, now)).toBe(false);
  });

  it("declines a stale stored id without deleting it from session storage", () => {
    const now = Date.UTC(2026, 6, 24, 12);
    sessionStorage.setItem("ora_current_conversation_id", "42");
    markOraActive(now - IDLE_RESET_MS - 1);

    expect(idleGatedOraConversationId(42, now)).toBeNull();
    expect(sessionStorage.getItem("ora_current_conversation_id")).toBe("42");
  });

  it("resumes a recent stored id", () => {
    const now = Date.UTC(2026, 6, 24, 12);
    markOraActive(now - IDLE_RESET_MS);

    expect(idleGatedOraConversationId(42, now)).toBe(42);
  });
});

describe("Ora fresh-start home recents", () => {
  it("renders exactly five recents, expands to the full list, and opens a selection", () => {
    const selectConversation = vi.fn();
    const value = conversationsContext(
      Array.from({ length: 7 }, (_, index) => conversation(index + 1)),
      selectConversation,
    );
    const view = render(
      <OraConversationsContext.Provider value={value}>
        <OraHomeRecents />
      </OraConversationsContext.Provider>,
    );

    expect(view.getAllByRole("button", { name: /^Open conversation / })).toHaveLength(
      ORA_HOME_RECENT_LIMIT,
    );

    fireEvent.click(view.getByRole("button", { name: "Show more" }));
    expect(view.getAllByRole("button", { name: /^Open conversation / })).toHaveLength(7);

    fireEvent.click(view.getByRole("button", { name: "Open conversation Conversation 7" }));
    expect(selectConversation).toHaveBeenCalledWith(7);
  });

  it("can render recents collapsed so history does not dominate the empty chat", () => {
    const value = conversationsContext(
      Array.from({ length: 7 }, (_, index) => conversation(index + 1)),
    );
    const view = render(
      <OraConversationsContext.Provider value={value}>
        <OraHomeRecents collapsedByDefault />
      </OraConversationsContext.Provider>,
    );

    expect(view.queryAllByRole("button", { name: /^Open conversation / })).toHaveLength(0);

    fireEvent.click(view.getByRole("button", { name: "Show recent conversations" }));
    expect(view.getAllByRole("button", { name: /^Open conversation / })).toHaveLength(
      ORA_HOME_RECENT_LIMIT,
    );
  });
});

describe("Ora fresh-start website wiring", () => {
  const provider = read("../use-ora-conversations.tsx");
  const chat = read("../use-ora-chat.ts");
  const panel = read("../../components/ora-panel.tsx");

  it("gates both local and server restoration while preserving project-route precedence", () => {
    expect(provider).toContain("idleGatedOraConversationId(getStoredCurrentId())");
    expect(provider).toContain("if (!resumeOnMountRef.current) return;");
    expect(provider).toContain("getStoredPendingProjectId() != null");
    expect(provider).toContain("selected.projectId !== activeProjectIdRef.current");
    expect(provider).toContain("savedConversation.projectId === activeProjectIdRef.current");
    expect(provider).not.toContain("storeCurrentId(null);\n      markOraActive();");
  });

  it("records activity on hidden/pagehide, heartbeat, and signed-in sends", () => {
    expect(provider).toContain('document.addEventListener("visibilitychange"');
    expect(provider).toContain('window.addEventListener("pagehide"');
    expect(provider).toContain("ORA_ACTIVE_HEARTBEAT_MS");
    expect(chat).toContain("if (isSignedIn) markOraActive();");
  });

  it("loads the endpoint's maximum page so Show more exposes the available history", () => {
    expect(provider).toContain("/api/ora/conversations?limit=100");
  });

  it("treats every New conversation click as a real reset, even when the id is already null", () => {
    expect(provider).toContain("const [newConversationTick, setNewConversationTick] = useState(0)");
    expect(provider).toContain("setNewConversationTick((tick) => tick + 1)");
    expect(chat).toContain("conv?.newConversationTick");
    expect(chat).toContain("resetVisibleThread(true)");
  });

  it("retires stale async replies when starting or switching conversations", () => {
    expect(chat).toContain("const conversationResetGenRef = useRef(0)");
    expect(chat).toContain("conversationResetGenRef.current += 1");
    expect(chat).toContain("setMessagesForGeneration(turnGeneration");
    expect(chat).toContain("if (!isTurnCurrent()) return;");
  });

  it("puts starter prompts before collapsed recents in the compact home hierarchy", () => {
    const starters = panel.indexOf('aria-label="Start a new chat"');
    const recents = panel.indexOf("<OraHomeRecents collapsedByDefault", starters);

    expect(starters).toBeGreaterThan(-1);
    expect(recents).toBeGreaterThan(starters);
    expect(panel).toContain("What can I help you work through?");
    expect(panel).toContain("Start something new");
    expect(panel).not.toContain("Hi, I&apos;m Ora");
  });
});
