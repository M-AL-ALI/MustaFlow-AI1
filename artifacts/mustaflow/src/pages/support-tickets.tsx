import {
  LifeBuoy,
  Loader2,
  ChevronLeft,
  Paperclip,
  CircleDot,
  CheckCircle2,
  MessageSquare,
} from "lucide-react";
import { useAuth } from "@clerk/react";
import { Link, useParams } from "wouter";
import { useListSupportTickets, useGetSupportTicket } from "@workspace/api-client-react";
import { SupportOwnerActions } from "./support-owner-actions";

/**
 * My Support Tickets (Task #1318).
 *
 * A read-only, owner-scoped view of the support tickets the signed-in user has
 * submitted via the Help Center escalation flow. Lets them check status
 * (open/closed), re-read the transcript they sent, and follow up by reopening
 * the Help Center support chat.
 *
 * Backed by /help/support/tickets (list) and /help/support/tickets/:id (detail),
 * both strictly scoped by the authenticated userId server-side.
 */

function formatDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// A ticket is "active" while it's still being handled (new = untouched,
// open = being worked); "resolved"/"closed" means it's done.
function isActiveStatus(status: string): boolean {
  return status === "new" || status === "open";
}

function statusLabel(status: string): string {
  switch (status) {
    case "new":
      return "New";
    case "open":
      return "Open";
    case "resolved":
    case "closed":
      return "Resolved";
    default:
      return status;
  }
}

export function parseSupportTicketRouteId(value?: string): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function StatusBadge({ status }: { status: string }) {
  const active = isActiveStatus(status);
  return (
    <span
      className={
        active
          ? "inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-500"
          : "inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground"
      }
    >
      {active ? <CircleDot className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}
      {statusLabel(status)}
    </span>
  );
}

function SignedOut() {
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="flex items-center gap-2">
        <LifeBuoy className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold">My support tickets</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        Sign in to view the support tickets you've submitted.
      </p>
      <Link
        href="/sign-in"
        className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        Sign in
      </Link>
    </div>
  );
}

function TicketDetail({ ticketId }: { ticketId: number }) {
  const { data, isLoading, isError, error } = useGetSupportTicket(ticketId);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading ticket…
      </div>
    );
  }

  if (isError || !data) {
    const status = (error as { status?: number } | undefined)?.status;
    return (
      <div className="rounded-lg border border-border bg-card p-6 text-center">
        <p className="text-sm text-muted-foreground">
          {status === 404
            ? "This ticket doesn't exist or doesn't belong to your account."
            : "We couldn't load this ticket. Please try again."}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3 rounded-lg border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold leading-snug">{data.subject}</h2>
          <StatusBadge status={data.status} />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>Ticket #{data.id}</span>
          <span className="rounded-full bg-muted px-2 py-0.5">{data.category}</span>
          <span>Submitted {formatDate(data.createdAt)}</span>
          {data.attachments.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <Paperclip className="h-3 w-3" />
              {data.attachments.length} attachment
              {data.attachments.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
      </div>

      <SupportOwnerActions ticketId={ticketId} />

      {data.attachments.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Attachments</h3>
          <ul className="space-y-1.5">
            {data.attachments.map((a, i) => (
              <li key={`${a.fileName}-${i}`}>
                {a.url ? (
                  <a
                    href={a.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
                  >
                    <Paperclip className="h-3.5 w-3.5" />
                    {a.fileName}
                  </a>
                ) : (
                  <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                    <Paperclip className="h-3.5 w-3.5" />
                    {a.fileName}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Conversation</h3>
        {data.transcript.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No conversation was attached to this ticket.
          </p>
        ) : (
          <div className="space-y-3">
            {data.transcript.map((m, i) => (
              <div
                key={i}
                className={
                  m.role === "user"
                    ? "ml-auto max-w-[85%] rounded-lg rounded-br-sm bg-primary/10 px-3.5 py-2.5"
                    : "mr-auto max-w-[85%] rounded-lg rounded-bl-sm bg-muted px-3.5 py-2.5"
                }
              >
                <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {m.role === "user" ? "You" : "Ora Support"}
                </div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed">{m.content}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
        <Link
          href="/help"
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <MessageSquare className="h-4 w-4" />
          Follow up in support chat
        </Link>
        <span className="text-xs text-muted-foreground">
          Reopen the Help Center chat to add more details or escalate again.
        </span>
      </div>
    </div>
  );
}

function TicketList() {
  const { data, isLoading, isError } = useListSupportTickets();
  const tickets = data?.tickets ?? [];

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading your tickets…
      </div>
    );
  }

  if (isError) {
    return (
      <div className="rounded-lg border border-border bg-card p-6 text-center text-sm text-muted-foreground">
        We couldn't load your tickets. Please try again.
      </div>
    );
  }

  if (tickets.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-card/50 p-10 text-center">
        <LifeBuoy className="mx-auto h-8 w-8 text-muted-foreground" />
        <p className="mt-3 text-sm font-medium">No support tickets yet</p>
        <p className="mt-1 text-sm text-muted-foreground">
          When you escalate a question to our team from the Help Center, it will show up here.
        </p>
        <Link
          href="/help"
          className="mt-4 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <MessageSquare className="h-4 w-4" />
          Go to Help Center
        </Link>
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {tickets.map((t) => (
        <li key={t.id}>
          <Link
            href={`/support/tickets/${t.id}`}
            className="block rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:bg-muted"
          >
            <div className="flex items-start justify-between gap-3">
              <span className="text-sm font-medium leading-snug">{t.subject}</span>
              <StatusBadge status={t.status} />
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>#{t.id}</span>
              <span className="rounded-full bg-muted px-2 py-0.5">{t.category}</span>
              <span>{formatDate(t.createdAt)}</span>
              {t.attachmentCount > 0 && (
                <span className="inline-flex items-center gap-1">
                  <Paperclip className="h-3 w-3" />
                  {t.attachmentCount}
                </span>
              )}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function InvalidTicketId() {
  return (
    <div className="rounded-lg border border-border bg-card p-6 text-center">
      <p className="text-sm text-muted-foreground">This support ticket link is invalid.</p>
    </div>
  );
}

export default function SupportTicketsPage() {
  const { isSignedIn, isLoaded } = useAuth();
  const params = useParams<{ id?: string }>();
  const ticketId = parseSupportTicketRouteId(params.id);

  if (!isLoaded) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isSignedIn) return <SignedOut />;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      {params.id ? (
        <>
          <Link
            href="/support/tickets"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="h-4 w-4" />
            All tickets
          </Link>
          {ticketId != null ? <TicketDetail ticketId={ticketId} /> : <InvalidTicketId />}
        </>
      ) : (
        <>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <LifeBuoy className="h-6 w-6 text-primary" />
              <h1 className="text-2xl font-bold">My support tickets</h1>
            </div>
            <p className="text-sm text-muted-foreground">
              Check the status of tickets you've submitted and reopen them to follow up.
            </p>
          </div>
          <TicketList />
        </>
      )}
    </div>
  );
}
