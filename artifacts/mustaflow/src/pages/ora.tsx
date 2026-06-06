import { useParams } from "wouter";
import { FolderOpen, MessageCirclePlus } from "lucide-react";
import { OraSidebar } from "@/components/layout/ora-sidebar";
import { OraPanel } from "@/components/ora-panel";
import { useOraChat } from "@/hooks/use-ora-chat";
import { OraConversationsProvider } from "@/hooks/use-ora-conversations";
import { useOraConversations } from "@/hooks/ora-conversations-context";
import { ThemeToggle } from "@/components/theme-toggle";

/**
 * Header shown at the top of the main Ora view while a project is active.
 * Surfaces the project's name + description and a clear "New chat in this
 * project" action (scoped to the active project via newConversation()).
 */
function OraProjectHeader({ onNewChat }: { onNewChat: () => void }) {
  const { activeProject } = useOraConversations();
  if (!activeProject) return null;

  return (
    <div className="shrink-0 border-b border-border bg-background/60 px-4 py-3 pl-16">
      <div className="mx-auto flex max-w-3xl items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <FolderOpen className="h-4 w-4 shrink-0 text-primary" />
            <h1 className="truncate text-sm font-semibold text-foreground">{activeProject.name}</h1>
          </div>
          {activeProject.description ? (
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
              {activeProject.description}
            </p>
          ) : null}
        </div>
        <button
          onClick={onNewChat}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <MessageCirclePlus className="h-3.5 w-3.5" />
          New chat in this project
        </button>
      </div>
    </div>
  );
}

/**
 * Standalone Ora assistant home.
 *
 * A focused, full-screen chat experience with its own slide-out sidebar
 * (toggled by the logo button top-left). This is the foundation the rest of
 * the Ora product layers onto.
 *
 * Wrapped in OraConversationsProvider so both the chat hook and the sidebar
 * share the same projects/conversations state (per-conversation persistence).
 */
function OraPageInner() {
  const oraChat = useOraChat();

  return (
    <div className="h-[100dvh] bg-background flex flex-col overflow-hidden">
      {/* The global "New conversation" action defaults to the active project
          (route) when inside one — clearConversation() forwards no projectId,
          which newConversation() resolves to the active project. */}
      <OraSidebar onNewConversation={() => void oraChat.clearConversation()} />

      {/* Theme toggle, top-right */}
      <div className="fixed top-3 right-3 z-50">
        <ThemeToggle />
      </div>

      <OraProjectHeader onNewChat={() => void oraChat.clearConversation()} />

      {/* Full-height ChatGPT-style chat. The greeting now lives in OraPanel's
          empty state, so the thread fills from the top and the composer pins to
          the bottom. */}
      <main className="flex-1 flex flex-col min-h-0">
        <OraPanel chat={oraChat} layout="full" />
      </main>
    </div>
  );
}

export default function OraPage() {
  // The route is the single source of truth for the active project. `/ora`
  // renders with no param (standalone); `/ora/projects/:projectId` enters that
  // project and the value survives reloads because it comes from the URL.
  const params = useParams<{ projectId?: string }>();
  const parsed = params.projectId != null ? Number(params.projectId) : null;
  const activeProjectId = parsed != null && Number.isInteger(parsed) ? parsed : null;

  return (
    <OraConversationsProvider activeProjectId={activeProjectId}>
      <OraPageInner />
    </OraConversationsProvider>
  );
}
