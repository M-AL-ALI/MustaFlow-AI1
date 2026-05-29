// ─────────────────────────────────────────────────────────────────────────────
// Phase 6 — OraHandoffCard
//
// Compact CTA card shown under the last Ora message when the conversation has
// build intent. Creates a handoff token on click, then:
//   - Signed-in users: navigate to /projects?handoff=TOKEN (exchanges immediately)
//   - Anonymous users: navigate to /sign-up?handoff=TOKEN (exchanges post-auth)
//
// Token is removed from the URL with history.replaceState() after exchange
// (handled by the receiving page).
//
// Files / images / datasets are NOT transferred — only a short text summary
// that the user can review and edit before building.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import { useLocation } from "wouter";
import { useUser } from "@clerk/react";
import { Loader2, X, ArrowRight, Info } from "lucide-react";
import type { OraMessage } from "@/hooks/use-ora-chat";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface Props {
  messages: OraMessage[];
  onDismiss: () => void;
}

type Status = "idle" | "loading" | "error";

export function OraHandoffCard({ messages, onDismiss }: Props) {
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [, setLocation] = useLocation();
  const { isSignedIn } = useUser();

  async function handleContinue() {
    if (status === "loading") return;
    setStatus("loading");
    setErrorMsg(null);

    try {
      // Send only sanitized text content — no fileRef / imageRef / metadata
      const safeMessages = messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .filter((m) => !m.datasetResult)
        .slice(-8)
        .map((m) => ({ role: m.role, content: m.content.slice(0, 300) }));

      const res = await fetch(`${BASE}/api/public-ai/handoff/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ messages: safeMessages }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Could not create handoff. Please try again.");
      }

      const { token } = (await res.json()) as { token: string; expiresAt: number };

      if (isSignedIn) {
        // Signed-in: navigate to projects page which exchanges the token
        // Token removed from URL by the projects page after exchange
        setLocation(`/projects?handoff=${encodeURIComponent(token)}`);
      } else {
        // Anonymous: redirect to sign-up; post-auth the projects page exchanges
        // Token is opaque UUID, not user content — safe to put in URL
        setLocation(`/sign-up?handoff=${encodeURIComponent(token)}`);
      }
    } catch (err: unknown) {
      const msg =
        (err as Error).message ??
        "Something went wrong. Please try again or describe your idea directly in the Builder.";
      setStatus("error");
      setErrorMsg(msg);
    }
  }

  return (
    <div className="mt-3 rounded-xl border border-[hsl(265_85%_65%/0.25)] bg-[hsl(265_85%_65%/0.06)] px-3.5 py-3 text-xs">
      {/* Header row */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <p className="font-medium text-foreground/90 leading-snug">Ready to build this?</p>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="shrink-0 -mt-0.5 -mr-0.5 p-0.5 rounded text-muted-foreground/50 hover:text-muted-foreground transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Disclaimer — correction #11 */}
      <div className="flex items-start gap-1.5 mb-3 text-muted-foreground/70 leading-snug">
        <Info className="h-3 w-3 shrink-0 mt-px" />
        <span>
          Only a short text summary is passed to the Builder — files, images, datasets, and voice
          audio are <strong className="font-medium text-muted-foreground/90">not</strong>{" "}
          transferred automatically. You can review and edit the idea before building.
        </span>
      </div>

      {/* Error state */}
      {status === "error" && errorMsg && (
        <p className="mb-2 text-destructive/90 leading-snug">{errorMsg}</p>
      )}

      {/* CTA button */}
      <button
        type="button"
        onClick={handleContinue}
        disabled={status === "loading"}
        className="inline-flex items-center gap-1.5 rounded-lg bg-[hsl(265_85%_65%)] hover:bg-[hsl(265_85%_58%)] text-white px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {status === "loading" ? (
          <>
            <Loader2 className="h-3 w-3 animate-spin" />
            Preparing…
          </>
        ) : (
          <>
            Continue in Builder
            <ArrowRight className="h-3 w-3" />
          </>
        )}
      </button>
    </div>
  );
}
