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
    <div className="min-h-[100dvh] bg-background flex flex-col">
      <OraSidebar onNewConversation={() => void oraChat.clearConversation()} />

      {/* Theme toggle, top-right */}
      <div className="fixed top-3 right-3 z-50">
        <ThemeToggle />
      </div>

      <main className="flex-1 flex flex-col items-center justify-center px-4 py-16">
        <div className="w-full max-w-2xl space-y-6">
          <div className="text-center">
            <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight">
              Hi, I'm <span className="text-primary">Ora</span>
            </h1>
            <p className="text-muted-foreground mt-2">
              Ask me anything, think things through, or get work done — all in one chat.
            </p>
          </div>

          <OraPanel chat={oraChat} />
        </div>
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
