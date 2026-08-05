import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, FolderOpen, MessageSquare } from "lucide-react";
import { ORA_HOME_RECENT_LIMIT, sortOraHomeRecentConversations } from "@workspace/ora-contracts";
import { useOraConversationsOptional } from "@/hooks/ora-conversations-context";

export function OraHomeRecents({ collapsedByDefault = false }: { collapsedByDefault?: boolean }) {
  const conversationsContext = useOraConversationsOptional();
  const [listOpen, setListOpen] = useState(!collapsedByDefault);
  const [showAll, setShowAll] = useState(false);
  const activeProjectId = conversationsContext?.activeProjectId ?? null;

  useEffect(() => {
    setListOpen(!collapsedByDefault);
    setShowAll(false);
  }, [activeProjectId, collapsedByDefault]);

  const allRecent = useMemo(
    () =>
      conversationsContext
        ? sortOraHomeRecentConversations(
            conversationsContext.conversations,
            conversationsContext.activeProjectId,
          )
        : [],
    [conversationsContext],
  );

  if (!conversationsContext || conversationsContext.loading || allRecent.length === 0) {
    return null;
  }

  const visible = showAll ? allRecent : allRecent.slice(0, ORA_HOME_RECENT_LIMIT);
  const projectNames = new Map(
    conversationsContext.projects.map((project) => [project.id, project.name]),
  );

  return (
    <section className="mt-5 w-full text-left" aria-label="Recent conversations">
      <button
        type="button"
        onClick={() => setListOpen((current) => !current)}
        className="mb-2 flex w-full items-center justify-between gap-3 rounded-md px-1 py-1 text-left transition-colors hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={listOpen}
        aria-label={listOpen ? "Hide recent conversations" : "Show recent conversations"}
      >
        <h2 className="text-sm font-semibold text-foreground">Recent conversations</h2>
        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
          {allRecent.length}
          {listOpen ? (
            <ChevronUp className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )}
        </span>
      </button>

      {listOpen ? (
        <>
          <div className="divide-y divide-border/60 border-y border-border/60">
            {visible.map((conversation) => {
              const projectName =
                conversation.projectId == null ? null : projectNames.get(conversation.projectId);
              return (
                <button
                  key={conversation.id}
                  type="button"
                  onClick={() => conversationsContext.selectConversation(conversation.id)}
                  className="flex w-full items-start gap-3 px-1 py-2.5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Open conversation ${conversation.title || "Untitled"}`}
                >
                  {projectName ? (
                    <FolderOpen className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {conversation.title || "Untitled"}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {projectName
                        ? `${projectName}${conversation.preview ? ` - ${conversation.preview}` : ""}`
                        : conversation.preview || "Continue this conversation"}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          {allRecent.length > ORA_HOME_RECENT_LIMIT ? (
            <button
              type="button"
              onClick={() => setShowAll((current) => !current)}
              className="mt-2 inline-flex items-center gap-1 px-1 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              aria-expanded={showAll}
            >
              {showAll ? (
                <>
                  <ChevronUp className="h-3.5 w-3.5" />
                  Show less
                </>
              ) : (
                <>
                  <ChevronDown className="h-3.5 w-3.5" />
                  Show more
                </>
              )}
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
