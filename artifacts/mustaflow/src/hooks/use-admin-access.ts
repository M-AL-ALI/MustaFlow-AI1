import { useEffect, useState } from "react";
import { authFetch } from "@/lib/api-fetch";
import { useClerkUser } from "@/lib/clerk-safe";

type AdminEvidence = { userId: string; isAdmin: boolean; role: string | null };

/** Visibility is an account-scoped server decision, never an email or client-side allowlist. */
export function useAdminAccess() {
  const { user, isLoaded, isSignedIn } = useClerkUser();
  const userId = isLoaded && isSignedIn ? (user?.id ?? null) : null;
  const [evidence, setEvidence] = useState<AdminEvidence | null>(null);

  useEffect(() => {
    setEvidence(null);
    if (!userId) return;
    let active = true;
    let request = 0;
    let controller: AbortController | undefined;
    const refresh = async () => {
      const currentRequest = ++request;
      controller?.abort();
      controller = new AbortController();
      setEvidence(null);
      try {
        const response = await authFetch("/api/admin/me", { signal: controller.signal });
        const result: unknown = response.ok ? await response.json() : null;
        if (!active || currentRequest !== request) return;
        const data =
          result && typeof result === "object" ? (result as Record<string, unknown>) : null;
        const allowed = data?.isAdmin === true;
        setEvidence({
          userId,
          isAdmin: allowed,
          role: allowed && typeof data?.role === "string" ? data.role : null,
        });
      } catch {
        if (active && currentRequest === request) setEvidence(null);
      }
    };
    void refresh();
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(onFocus, 60_000);
    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [userId]);

  const isAdmin = !!userId && evidence?.userId === userId && evidence.isAdmin;
  return { isAdmin, role: isAdmin ? (evidence?.role ?? null) : null };
}
