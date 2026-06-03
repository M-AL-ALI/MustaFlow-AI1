import { authFetch } from "@/lib/api-fetch";
import { useEffect, useState } from "react";
import { useParams, useLocation } from "wouter";
import { Show } from "@clerk/react";
import { Building2, Check, Loader2, AlertCircle, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

type State =
  | { kind: "loading" }
  | { kind: "success"; orgId: number; role: string }
  | { kind: "error"; message: string };

function AcceptInner({ token }: { token: string }) {
  const [, setLocation] = useLocation();
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await authFetch(`/api/orgs/invites/${encodeURIComponent(token)}/accept`, {
          method: "POST",
        });
        if (cancelled) return;
        const data = (await r.json().catch(() => ({}))) as {
          organizationId?: number;
          role?: string;
          error?: string;
        };
        if (r.ok && data.organizationId) {
          setState({
            kind: "success",
            orgId: data.organizationId,
            role: data.role ?? "member",
          });
        } else {
          setState({
            kind: "error",
            message: data.error ?? `Could not accept invitation (status ${r.status})`,
          });
        }
      } catch {
        if (!cancelled) {
          setState({ kind: "error", message: "Network error — please try again." });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="flex min-h-[80vh] items-center justify-center px-4 py-12">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center space-y-5">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Building2 className="h-7 w-7" />
        </div>

        {state.kind === "loading" && (
          <>
            <h1 className="text-lg font-semibold">Accepting your invitation…</h1>
            <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
          </>
        )}

        {state.kind === "success" && (
          <>
            <div className="mx-auto flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-500">
              <Check className="h-4 w-4" />
            </div>
            <h1 className="text-lg font-semibold">You're in!</h1>
            <p className="text-sm text-muted-foreground">
              You joined as <span className="font-medium capitalize">{state.role}</span>.
            </p>
            <Button className="w-full gap-2" onClick={() => setLocation(`/orgs/${state.orgId}`)}>
              Go to organization
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </>
        )}

        {state.kind === "error" && (
          <>
            <div className="mx-auto flex h-8 w-8 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <AlertCircle className="h-4 w-4" />
            </div>
            <h1 className="text-lg font-semibold">Invitation problem</h1>
            <p className="text-sm text-muted-foreground">{state.message}</p>
            <Button variant="outline" className="w-full" onClick={() => setLocation("/projects")}>
              Back to projects
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function SignInPrompt({ token }: { token: string }) {
  const [, setLocation] = useLocation();
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  const returnTo = `${base}/orgs/invites/${token}`;

  return (
    <div className="flex min-h-[80vh] items-center justify-center px-4 py-12">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center space-y-5">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Building2 className="h-7 w-7" />
        </div>
        <h1 className="text-lg font-semibold">You've been invited</h1>
        <p className="text-sm text-muted-foreground">
          Sign in or create an account to accept this invitation.
        </p>
        <div className="space-y-2">
          <Button
            className="w-full"
            onClick={() => setLocation(`/sign-in?redirect_url=${encodeURIComponent(returnTo)}`)}
          >
            Sign in
          </Button>
          <Button
            variant="outline"
            className="w-full"
            onClick={() => setLocation(`/sign-up?redirect_url=${encodeURIComponent(returnTo)}`)}
          >
            Create an account
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function OrgInviteAcceptPage() {
  const params = useParams<{ token: string }>();
  const token = params.token ?? "";

  if (!token) {
    return (
      <div className="flex min-h-[80vh] items-center justify-center px-4">
        <p className="text-sm text-muted-foreground">Missing invite token.</p>
      </div>
    );
  }

  return (
    <>
      <Show when="signed-in">
        <AcceptInner token={token} />
      </Show>
      <Show when="signed-out">
        <SignInPrompt token={token} />
      </Show>
    </>
  );
}
