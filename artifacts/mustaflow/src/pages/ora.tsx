import { OraSidebar } from "@/components/layout/ora-sidebar";
import { OraPanel } from "@/components/ora-panel";
import { useOraChat } from "@/hooks/use-ora-chat";
import { OraConversationsProvider } from "@/hooks/use-ora-conversations";
import { ThemeToggle } from "@/components/theme-toggle";

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
      <OraSidebar onNewConversation={() => void oraChat.clearConversation()} />

      {/* Theme toggle, top-right */}
      <div className="fixed top-3 right-3 z-50">
        <ThemeToggle />
      </div>

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
  return (
    <OraConversationsProvider>
      <OraPageInner />
    </OraConversationsProvider>
  );
}
