import { createContext, useContext } from "react";

export interface OraConversationSummary {
  id: number;
  title: string | null;
  titleSource?: "client" | "ai" | "user" | null;
  projectId: number | null;
  pinnedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  archivedAt?: string | null;
  /** Short snippet of the last message, for the History list. */
  preview?: string | null;
  /** Total number of stored messages (computed without loading bodies). */
  messageCount?: number | null;
  /** True if any message in this conversation contains a generated image. */
  metaHasImages?: boolean;
  /** True if any message contains a generated file (doc/sheet/slide/etc.). */
  metaHasGeneratedFiles?: boolean;
  /** True if any message includes web-search citation sources. */
  metaHasSources?: boolean;
  /** True if any message was sent/received via voice. */
  metaHasVoice?: boolean;
  /** Short tag for the last significant activity ('chat'|'image'|'file'|'search'). */
  metaLastActivityType?: string | null;
}

export interface OraProjectSummary {
  id: number;
  name: string;
  description?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OraConversationsContextValue {
  projects: OraProjectSummary[];
  conversations: OraConversationSummary[];
  currentConversationId: number | null;
  /**
   * The project the user is currently inside, derived from the
   * `/ora/projects/:projectId` route (the single source of truth). `null` on
   * the standalone `/ora` view.
   */
  activeProjectId: number | null;
  /** The active project's summary, or `null` when none/not yet loaded. */
  activeProject: OraProjectSummary | null;
  loading: boolean;
  refresh: () => Promise<void>;
  selectConversation: (id: number | null) => void;
  /**
   * Reset to a blank chat for the next message.
   *   - no argument → scope to the active project (route), if any.
   *   - `null`      → an explicit standalone chat (`projectId = null`).
   *   - a number    → that specific project.
   */
  newConversation: (projectId?: number | null) => void;
  /** Create the current conversation if one doesn't exist yet (first message). */
  ensureConversation: (title: string) => Promise<number | null>;
  /** Called by the chat hook after messages persist, to re-sort the list. */
  notifyPersisted: () => void;
  renameConversation: (id: number, title: string) => Promise<void>;
  /** Soft-delete (move to archive). */
  deleteConversation: (id: number) => Promise<void>;
  /** Restore an archived conversation. */
  restoreConversation: (id: number) => Promise<void>;
  /** Permanently hard-delete a conversation (irreversible). */
  permanentDeleteConversation: (id: number) => Promise<void>;
  moveConversation: (id: number, projectId: number | null) => Promise<void>;
  /** Pin (pinned=true) or unpin (pinned=false) a conversation. */
  pinConversation: (id: number, pinned: boolean) => Promise<void>;
  createProject: (name: string) => Promise<OraProjectSummary | null>;
  renameProject: (id: number, name: string) => Promise<void>;
  deleteProject: (id: number) => Promise<void>;
}

export const OraConversationsContext = createContext<OraConversationsContextValue | null>(null);

/** Returns the conversations context, or null when used outside the provider. */
export function useOraConversationsOptional(): OraConversationsContextValue | null {
  return useContext(OraConversationsContext);
}

/** Returns the conversations context; throws when used outside the provider. */
export function useOraConversations(): OraConversationsContextValue {
  const ctx = useContext(OraConversationsContext);
  if (!ctx) {
    throw new Error("useOraConversations must be used within an OraConversationsProvider");
  }
  return ctx;
}
