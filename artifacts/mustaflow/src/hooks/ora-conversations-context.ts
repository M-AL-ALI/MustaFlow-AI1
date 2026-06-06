import { createContext, useContext } from "react";

export interface OraConversationSummary {
  id: number;
  title: string | null;
  projectId: number | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  /** Short snippet of the last message, for the History list. */
  preview?: string | null;
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
  loading: boolean;
  refresh: () => Promise<void>;
  selectConversation: (id: number | null) => void;
  /** Reset to a blank chat. Optionally target a project for the next message. */
  newConversation: (projectId?: number | null) => void;
  /** Create the current conversation if one doesn't exist yet (first message). */
  ensureConversation: (title: string) => Promise<number | null>;
  /** Called by the chat hook after messages persist, to re-sort the list. */
  notifyPersisted: () => void;
  renameConversation: (id: number, title: string) => Promise<void>;
  deleteConversation: (id: number) => Promise<void>;
  moveConversation: (id: number, projectId: number | null) => Promise<void>;
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
