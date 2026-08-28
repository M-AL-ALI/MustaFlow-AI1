import { Check, ShieldCheck, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { authFetch } from "@/lib/api-fetch";

interface InvitePreview {
  projectId: number;
  projectName: string;
  role: "owner" | "publisher" | "editor" | "viewer";
  status: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: string;
}

export default function ProjectInviteAcceptPage() {
  const [, params] = useRoute("/projects/invites/:token");
  const [, navigate] = useLocation();
  const token = params?.token ?? "";
  const [invite, setInvite] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void authFetch(`/api/project-invites/${encodeURIComponent(token)}`)
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as
          | (InvitePreview & { error?: string })
          | null;
        if (!response.ok || !body)
          throw new Error(body?.error ?? "That invitation could not be found.");
        setInvite(body);
      })
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : "That invitation could not be found."),
      );
  }, [token]);

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await authFetch(`/api/project-invites/${encodeURIComponent(token)}/accept`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => null)) as {
        error?: string;
        projectId?: number;
      } | null;
      if (!response.ok || !body?.projectId)
        throw new Error(body?.error ?? "The invitation could not be accepted.");
      navigate(`/projects/${body.projectId}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The invitation could not be accepted.");
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <section className="w-full max-w-lg space-y-5 rounded-2xl border border-border bg-card p-6 shadow-xl">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Users className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold">Project invitation</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Access is limited to one named NabuFlow project.
          </p>
        </div>
        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}
        {invite ? (
          <div className="space-y-4">
            <div className="rounded-xl border border-border p-4">
              <p className="text-lg font-semibold">{invite.projectName}</p>
              <p className="mt-1 text-sm text-muted-foreground">Role: {invite.role}</p>
              <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                Work in this project may use the workspace owner&apos;s NabuFlow credits. The owner
                can remove access at any time.
              </p>
            </div>
            {invite.status === "pending" ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void accept()}
                className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-primary font-medium text-primary-foreground disabled:opacity-50"
              >
                <Check className="h-4 w-4" />
                {busy ? "Joining…" : "Accept and open project"}
              </button>
            ) : (
              <p className="text-sm text-muted-foreground">This invitation is {invite.status}.</p>
            )}
          </div>
        ) : !error ? (
          <p className="text-sm text-muted-foreground">Loading invitation…</p>
        ) : null}
        <Link href="/projects" className="block text-center text-sm text-primary hover:underline">
          Back to projects
        </Link>
      </section>
    </main>
  );
}
