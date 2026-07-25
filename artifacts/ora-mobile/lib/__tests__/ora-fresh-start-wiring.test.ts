import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  IDLE_RESET_MS,
  ORA_HOME_RECENT_LIMIT,
  shouldResumeOraConversation,
  sortOraHomeRecentConversations,
} from "@workspace/ora-contracts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (relativePath: string) =>
  readFileSync(path.join(__dirname, relativePath), "utf8").replace(/\r\n/g, "\n");

describe("Ora mobile fresh-start shared rule", () => {
  it("keeps a conversation through five minutes and resets immediately after", () => {
    const now = Date.UTC(2026, 6, 24, 12);

    expect(shouldResumeOraConversation(now - IDLE_RESET_MS, now)).toBe(true);
    expect(shouldResumeOraConversation(now - IDLE_RESET_MS - 1, now)).toBe(false);
    expect(shouldResumeOraConversation(null, now)).toBe(false);
  });

  it("sorts recents newest-first without deleting history", () => {
    const conversations = Array.from({ length: 7 }, (_, index) => ({
      id: index + 1,
      title: `Conversation ${index + 1}`,
      projectId: null,
      lastMessageAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      archivedAt: null,
    }));

    const allRecent = sortOraHomeRecentConversations(conversations, null);
    expect(allRecent).toHaveLength(7);
    expect(allRecent.slice(0, ORA_HOME_RECENT_LIMIT).map((item) => item.id)).toEqual([
      7, 6, 5, 4, 3,
    ]);
  });
});

describe("Ora mobile fresh-start lifecycle wiring", () => {
  const screen = read("../../app/(home)/index.tsx");
  const idleStore = read("../ora-idle-reset.ts");
  const recents = read("../../components/ora/OraHomeRecents.tsx");

  it("persists background activity and resets only after a stale background return", () => {
    expect(screen).toContain('if (next === "background")');
    expect(screen).toContain("void markOraActive(backgroundedAt);");
    expect(screen).toContain('if (next !== "active" || previous !== "background") return;');
    expect(screen).toContain("if (!shouldResumeOraConversation(lastActiveAt))");
    expect(screen).toContain("resetToFreshHomeAfterIdle();");
  });

  it("gates full-launch server restore and still loads the home recents", () => {
    expect(screen).toContain("refreshChatLists(),");
    expect(screen).toContain("readOraLastActiveAt(),");
    expect(screen).toContain("getOraUserSettings().catch(() => null)");
    expect(screen).toContain("if (!shouldResumeOraConversation(lastActiveAt))");
    expect(screen).toContain("void loadConversation(settings.lastConversationId);");
  });

  it("uses one shared timeout and durable AsyncStorage instead of a mobile literal", () => {
    expect(screen).toContain("ORA_ACTIVE_HEARTBEAT_MS");
    expect(screen).toContain("shouldResumeOraConversation");
    expect(screen).not.toContain("5 * 60 * 1000");
    expect(idleStore).toContain("ORA_LAST_ACTIVE_AT_STORAGE_KEY");
    expect(idleStore).toContain("AsyncStorage.setItem");
  });

  it("renders five recents with a working show-more path on the signed-in home", () => {
    expect(screen).toContain("<OraHomeRecents");
    expect(screen).toContain("onSelect={loadConversation}");
    expect(recents).toContain("allRecent.slice(0, ORA_HOME_RECENT_LIMIT)");
    expect(recents).toContain("setExpanded((current) => !current)");
    expect(recents).toContain('{expanded ? "Show less" : "Show more"}');
  });

  it("leaves signed-out launch behavior and project scope untouched", () => {
    expect(screen).toContain("if (!isLoaded || !isSignedIn) return;");
    expect(screen).toContain("setActiveProjectId(detail.projectId ?? null);");
    expect(screen).toContain("activeProjectId={activeProjectId}");
  });
});
