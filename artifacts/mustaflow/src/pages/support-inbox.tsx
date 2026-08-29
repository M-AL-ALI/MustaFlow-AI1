import { useMemo, useState } from "react";
import {
  LifeBuoy,
  RefreshCw,
  Search,
  Inbox,
  ChevronLeft,
  Paperclip,
  Download,
  Send,
  User,
  Headphones,
  FolderKanban,
  Mail,
  Loader2,
  CheckCircle,
  AlertCircle,
  StickyNote,
  Lock,
  Bell,
  BellOff,
  FlaskConical,
  Clock3,
  UserCheck,
  Flag,
} from "lucide-react";
import {
  useListAdminSupportTickets,
  useGetAdminSupportTicket,
  useUpdateAdminSupportTicket,
  useReplyAdminSupportTicket,
  useAddAdminSupportTicketNote,
  useListAdminSupportAssignees,
  getListAdminSupportTicketsQueryKey,
  getGetAdminSupportTicketQueryKey,
} from "@workspace/api-client-react";
import type {
  AdminSupportTicketSummary,
  AdminSupportTicketMessage,
  AdminSupportTicketAttachment,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { authFetch } from "../lib/api-fetch";
import { cn } from "../lib/utils";
import {
  useSupportAlertsPref,
  requestSupportAlertNotifications,
} from "@/hooks/use-admin-ticket-alerts";
import { toast } from "@/hooks/use-toast";
import { SupportOperationConsole } from "./support-operation-console";
import { presentSupportEmailStatus, type SupportUserDeliveryView } from "@/lib/support-operations";
import { AdminBreadcrumbs } from "@/components/admin/admin-breadcrumbs";
import { Link } from "wouter";

type StatusFilter =
  | "all"
  | "new"
  | "open"
  | "waiting_on_user"
  | "blocked_on_third_party"
  | "resolved";

// Header control: send a diagnostic test email to SUPPORT_EMAIL.
function TestEmailButton() {
  const [state, setState] = useState<"idle" | "loading" | "ok" | "err" | "miscfg">("idle");
  const [detail, setDetail] = useState<string>("");

  async function handleClick() {
    setState("loading");
    setDetail("");
    try {
      const res = await authFetch("/api/admin/email/test", { method: "POST" });
      const body = (await res.json()) as {
        ok?: boolean;
        emailStatus?: string;
        recipient?: string | null;
        error?: string;
      };
      if (res.status === 503 || body.emailStatus === "skipped") {
        setState("miscfg");
        setDetail(body.error ?? "Email delivery is not configured.");
      } else if (body.ok && body.emailStatus === "sent") {
        setState("ok");
        setDetail(`Sent to ${body.recipient ?? "support@mustaflow.com"}.`);
      } else {
        setState("err");
        setDetail(body.error ?? `Resend returned: ${body.emailStatus ?? "unknown"}`);
      }
    } catch {
      setState("err");
      setDetail("Network error — check that the API server is running.");
    }
    setTimeout(() => setState("idle"), 6000);
  }

  const icon =
    state === "loading" ? (
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
    ) : state === "ok" ? (
      <CheckCircle className="h-3.5 w-3.5 text-green-500" />
    ) : state === "err" || state === "miscfg" ? (
      <AlertCircle className="h-3.5 w-3.5 text-amber-500" />
    ) : (
      <FlaskConical className="h-3.5 w-3.5" />
    );

  return (
    <div className="flex flex-col items-end gap-0.5">
      <button
        onClick={() => void handleClick()}
        disabled={state === "loading"}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        title="Send a diagnostic test email to the support inbox"
      >
        {icon}
        Test email
      </button>
      {detail && (
        <span
          className={cn(
            "text-[11px] max-w-[200px] text-right",
            state === "ok" ? "text-green-600" : "text-amber-600",
          )}
        >
          {detail}
        </span>
      )}
    </div>
  );
}

// Header control: toggle real-time new-ticket alerts on/off and (when enabling)
// offer to turn on native browser notifications.
function AlertsToggle() {
  const [enabled, setEnabled] = useSupportAlertsPref();

  async function handleToggle() {
    const next = !enabled;
    setEnabled(next);
    if (next) {
      const result = await requestSupportAlertNotifications();
      if (result === "denied") {
        toast({
          title: "In-app alerts on",
          description: "Browser notifications are blocked, so you'll see in-app toasts only.",
        });
      }
    }
  }

  return (
    <button
      onClick={() => void handleToggle()}
      className={cn(
        "flex items-center gap-1.5 text-sm transition-colors",
        enabled
          ? "text-foreground hover:text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
      title={
        enabled
          ? "Real-time alerts on — click to disable"
          : "Real-time alerts off — click to enable"
      }
    >
      {enabled ? <Bell className="h-3.5 w-3.5" /> : <BellOff className="h-3.5 w-3.5" />}
      {enabled ? "Alerts on" : "Alerts off"}
    </button>
  );
}

const STATUS_TABS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "new", label: "New" },
  { value: "open", label: "Open" },
  { value: "waiting_on_user", label: "Waiting" },
  { value: "blocked_on_third_party", label: "Third party" },
  { value: "resolved", label: "Resolved" },
];

function statusBadgeClass(status: string): string {
  switch (status) {
    case "new":
      return "bg-blue-500/10 text-blue-500 border-blue-500/20";
    case "open":
      return "bg-amber-500/10 text-amber-500 border-amber-500/20";
    case "waiting_on_user":
      return "bg-violet-500/10 text-violet-500 border-violet-500/20";
    case "blocked_on_third_party":
      return "bg-orange-500/10 text-orange-600 border-orange-500/20";
    case "resolved":
      return "bg-green-500/10 text-green-500 border-green-500/20";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

function statusLabel(status: string): string {
  return status.replaceAll("_", " ");
}

function formatAge(minutes: number): string {
  if (minutes < 60) return `${minutes}m old`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}h old`;
  return `${Math.floor(minutes / 1_440)}d old`;
}

function priorityBadgeClass(priority: string): string {
  if (priority === "urgent") return "bg-red-500/10 text-red-600 border-red-500/20";
  if (priority === "high") return "bg-orange-500/10 text-orange-600 border-orange-500/20";
  if (priority === "low") return "bg-slate-500/10 text-slate-500 border-slate-500/20";
  return "bg-muted text-muted-foreground border-border";
}

function formatDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize",
        statusBadgeClass(status),
      )}
    >
      {statusLabel(status)}
    </span>
  );
}

export default function SupportInboxPage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<StatusFilter>("all");
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const params = useMemo(
    () => ({ status, ...(q ? { q } : {}), limit: 100, offset: 0 }),
    [status, q],
  );

  const {
    data: listData,
    isLoading: listLoading,
    isFetching: listFetching,
    refetch: refetchList,
  } = useListAdminSupportTickets(params);
  const { data: assigneeData } = useListAdminSupportAssignees();
  const assigneeNames = useMemo(
    () =>
      new Map(
        (assigneeData?.assignees ?? []).map((assignee) => [
          assignee.userId,
          assignee.displayName ?? assignee.userId,
        ]),
      ),
    [assigneeData],
  );

  const tickets = listData?.tickets ?? [];
  const statusCounts = listData?.statusCounts ?? {
    new: 0,
    open: 0,
    waiting_on_user: 0,
    blocked_on_third_party: 0,
    resolved: 0,
  };

  function tabCount(value: StatusFilter): number | null {
    if (value === "new") return statusCounts.new;
    if (value === "open") return statusCounts.open;
    if (value === "waiting_on_user") return statusCounts.waiting_on_user;
    if (value === "blocked_on_third_party") return statusCounts.blocked_on_third_party;
    if (value === "resolved") return statusCounts.resolved;
    return null;
  }

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    setQ(searchInput.trim());
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <AdminBreadcrumbs
        items={[
          { label: "Projects", href: "/projects" },
          { label: "Admin Page", href: "/admin" },
          { label: "Support Inbox" },
        ]}
      />
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <LifeBuoy className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Support Inbox</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Triage and reply to escalated support tickets.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <TestEmailButton />
          <AlertsToggle />
          <button
            onClick={() => refetchList()}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", listFetching && "animate-spin")} />
            Refresh
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-6">
        {/* List column */}
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-1.5">
            {STATUS_TABS.map((tab) => {
              const c = tabCount(tab.value);
              const active = status === tab.value;
              return (
                <button
                  key={tab.value}
                  onClick={() => setStatus(tab.value)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    active
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {tab.label}
                  {c != null && (
                    <span
                      className={cn(
                        "rounded-full px-1.5 text-[11px]",
                        active ? "bg-primary-foreground/20" : "bg-background/60",
                      )}
                    >
                      {c}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <form onSubmit={submitSearch} className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search subject, email, or user…"
              className="w-full rounded-md border border-border bg-background pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </form>

          <div className="space-y-2">
            {listLoading ? (
              <div className="flex items-center justify-center py-16 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : tickets.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
                <Inbox className="h-8 w-8 mb-2 opacity-50" />
                <p className="text-sm">No tickets found.</p>
              </div>
            ) : (
              tickets.map((t) => (
                <TicketListItem
                  key={t.id}
                  ticket={t}
                  assigneeName={
                    t.assignedToUserId
                      ? (assigneeNames.get(t.assignedToUserId) ?? "Assigned staff")
                      : null
                  }
                  active={t.id === selectedId}
                  onClick={() => setSelectedId(t.id)}
                />
              ))
            )}
          </div>
        </div>

        {/* Detail column */}
        <div>
          {selectedId == null ? (
            <div className="hidden lg:flex flex-col items-center justify-center h-full min-h-[400px] rounded-xl border border-dashed border-border text-center text-muted-foreground">
              <Headphones className="h-8 w-8 mb-2 opacity-50" />
              <p className="text-sm">Select a ticket to view the conversation.</p>
            </div>
          ) : (
            <TicketDetail
              ticketId={selectedId}
              onClose={() => setSelectedId(null)}
              onMutated={() => {
                queryClient.invalidateQueries({
                  queryKey: getListAdminSupportTicketsQueryKey(),
                });
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function TicketListItem({
  ticket,
  assigneeName,
  active,
  onClick,
}: {
  ticket: AdminSupportTicketSummary;
  assigneeName: string | null;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full text-left rounded-lg border px-4 py-3 transition-colors",
        active
          ? "border-primary bg-primary/5"
          : "border-border bg-card hover:border-primary/40 hover:bg-muted/40",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold tracking-wide text-primary">
            {ticket.ticketNumber}
          </p>
          <p className="font-medium text-sm line-clamp-1">{ticket.subject}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {ticket.emailStatus === "failed" && (
            <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive">
              <Mail className="h-2.5 w-2.5" />
              email failed
            </span>
          )}
          {ticket.emailStatus === "skipped" && (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              <Mail className="h-2.5 w-2.5" />
              no email
            </span>
          )}
          <StatusBadge status={ticket.status} />
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium capitalize",
            priorityBadgeClass(ticket.priority),
          )}
        >
          <Flag className="h-2.5 w-2.5" /> {ticket.priority}
        </span>
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <Clock3 className="h-3 w-3" /> {formatAge(ticket.ageMinutes)}
        </span>
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <UserCheck className="h-3 w-3" /> {assigneeName ?? "Unassigned"}
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <User className="h-3 w-3" />
          {ticket.userEmail ?? ticket.userId}
        </span>
        {ticket.attachmentCount > 0 && (
          <span className="inline-flex items-center gap-1">
            <Paperclip className="h-3 w-3" />
            {ticket.attachmentCount}
          </span>
        )}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1 min-w-0">
          {ticket.projectId != null ? (
            <>
              <FolderKanban className="h-3 w-3 shrink-0" />
              <span className="truncate">{ticket.projectName}</span>
            </>
          ) : (
            <span className="capitalize">{ticket.category}</span>
          )}
        </span>
        <span className="shrink-0">{formatDate(ticket.createdAt)}</span>
      </div>
    </button>
  );
}

function TicketDetail({
  ticketId,
  onClose,
  onMutated,
}: {
  ticketId: number;
  onClose: () => void;
  onMutated: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: ticket, isLoading, isError, refetch } = useGetAdminSupportTicket(ticketId);
  const { data: assigneeData } = useListAdminSupportAssignees();
  const [composerMode, setComposerMode] = useState<"reply" | "note">("reply");
  const [reply, setReply] = useState("");
  const [note, setNote] = useState("");
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const updateStatus = useUpdateAdminSupportTicket();
  const sendReply = useReplyAdminSupportTicket();
  const addNote = useAddAdminSupportTicketNote();

  function invalidateDetail() {
    queryClient.invalidateQueries({ queryKey: getGetAdminSupportTicketQueryKey(ticketId) });
  }

  function changeStatus(next: "new" | "open" | "waiting_on_user") {
    if (!ticket || ticket.status === next) return;
    updateStatus.mutate(
      { id: ticketId, data: { status: next } },
      {
        onSuccess: () => {
          invalidateDetail();
          onMutated();
        },
      },
    );
  }

  function changePriority(next: "low" | "normal" | "high" | "urgent") {
    updateStatus.mutate(
      { id: ticketId, data: { priority: next } },
      {
        onSuccess: () => {
          invalidateDetail();
          onMutated();
        },
      },
    );
  }

  function changeAssignee(next: string) {
    updateStatus.mutate(
      { id: ticketId, data: { assigneeUserId: next || null } },
      {
        onSuccess: () => {
          invalidateDetail();
          onMutated();
        },
      },
    );
  }

  function submitReply(e: React.FormEvent) {
    e.preventDefault();
    const body = reply.trim();
    if (!body) return;
    setFeedback(null);
    sendReply.mutate(
      { id: ticketId, data: { message: body } },
      {
        onSuccess: (res) => {
          setReply("");
          invalidateDetail();
          onMutated();
          if (res.emailStatus === "sent") {
            setFeedback({
              kind: "ok",
              text: "Reply saved, and the email provider accepted the message.",
            });
          } else if (res.emailStatus === "skipped") {
            setFeedback({
              kind: "ok",
              text: "Reply saved. Email delivery is not configured, so it was not emailed.",
            });
          } else {
            setFeedback({
              kind: "err",
              text: "Reply saved but the email failed to send.",
            });
          }
        },
        onError: () => {
          setFeedback({ kind: "err", text: "Could not send the reply. Please try again." });
        },
      },
    );
  }

  function submitNote(e: React.FormEvent) {
    e.preventDefault();
    const body = note.trim();
    if (!body) return;
    setFeedback(null);
    addNote.mutate(
      { id: ticketId, data: { note: body } },
      {
        onSuccess: () => {
          setNote("");
          invalidateDetail();
          onMutated();
          setFeedback({ kind: "ok", text: "Internal note added. The requester cannot see it." });
        },
        onError: () => {
          setFeedback({ kind: "err", text: "Could not add the note. Please try again." });
        },
      },
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[400px] rounded-xl border border-border text-center text-muted-foreground gap-3">
        <AlertCircle className="h-8 w-8 text-red-500/70" />
        <p className="text-sm">Could not load this ticket.</p>
        <button
          onClick={() => refetch()}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted transition-colors"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Retry
        </button>
      </div>
    );
  }

  if (isLoading || !ticket) {
    return (
      <div className="flex items-center justify-center h-full min-h-[400px] rounded-xl border border-border">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden flex flex-col">
      {/* Header */}
      <div className="px-5 py-4 border-b border-border">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold tracking-wide text-primary">
              {ticket.ticketNumber}
            </p>
            <button
              onClick={onClose}
              className="lg:hidden inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-2"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Back
            </button>
            <h2 className="text-lg font-semibold leading-tight">{ticket.subject}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Mail className="h-3 w-3" />
                {ticket.userEmail ?? "no email on file"}
              </span>
              <span className="capitalize">Plan: {ticket.plan}</span>
              <span className="capitalize">Category: {ticket.category}</span>
              <span className="inline-flex items-center gap-1">
                <Clock3 className="h-3 w-3" /> {formatAge(ticket.ageMinutes)}
              </span>
              {ticket.projectId != null && (
                <span className="inline-flex items-center gap-1">
                  <FolderKanban className="h-3 w-3" />
                  {ticket.projectName}
                </span>
              )}
            </div>
          </div>
          <StatusBadge status={ticket.status} />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <Link
            href="/admin"
            className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Back to Admin Page
          </Link>
          {ticket.projectId != null ? (
            <Link
              href={`/projects/${ticket.projectId}`}
              className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1.5 font-medium text-primary transition-colors hover:bg-primary/10"
            >
              <FolderKanban className="h-3.5 w-3.5" />
              Open reporting project{ticket.projectName ? `: ${ticket.projectName}` : ""}
            </Link>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-muted-foreground">
              <FolderKanban className="h-3.5 w-3.5" />
              No project linked to this ticket
            </span>
          )}
        </div>

        {/* Status controls */}
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground mr-1">Set status:</span>
          {(["new", "open", "waiting_on_user"] as const).map((s) => (
            <button
              key={s}
              onClick={() => changeStatus(s)}
              disabled={updateStatus.isPending || ticket.status === s}
              className={cn(
                "rounded-md border px-2.5 py-1 text-xs font-medium capitalize transition-colors disabled:opacity-50",
                ticket.status === s
                  ? statusBadgeClass(s)
                  : "border-border text-muted-foreground hover:text-foreground hover:bg-muted",
              )}
            >
              {statusLabel(s)}
            </button>
          ))}
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Flag className="h-3 w-3" /> Priority
            </span>
            <select
              aria-label="Ticket priority"
              value={ticket.priority}
              disabled={updateStatus.isPending}
              onChange={(event) =>
                changePriority(event.target.value as "low" | "normal" | "high" | "urgent")
              }
              className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm text-foreground"
            >
              {(["low", "normal", "high", "urgent"] as const).map((priority) => (
                <option key={priority} value={priority}>
                  {priority[0].toUpperCase() + priority.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <UserCheck className="h-3 w-3" /> Assigned staff
            </span>
            <select
              aria-label="Ticket assignee"
              value={ticket.assignedToUserId ?? ""}
              disabled={updateStatus.isPending}
              onChange={(event) => changeAssignee(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm text-foreground"
            >
              <option value="">Unassigned</option>
              {(assigneeData?.assignees ?? [])
                .filter((assignee) => assignee.assignable)
                .map((assignee) => (
                  <option key={assignee.userId} value={assignee.userId}>
                    {assignee.displayName} · {assignee.role}
                  </option>
                ))}
            </select>
          </label>
        </div>
        {ticket.status === "resolved" && ticket.resolvedByUserId && (
          <p className="mt-3 text-xs text-emerald-600">
            Resolved by {ticket.resolvedByUserId}
            {ticket.resolvedByRole ? ` (${ticket.resolvedByRole})` : ""}
            {ticket.resolvedAt ? ` on ${formatDate(ticket.resolvedAt)}` : ""}.
          </p>
        )}
      </div>

      <SupportOperationConsole
        ticketId={ticketId}
        ticketNumber={ticket.ticketNumber}
        onMutated={onMutated}
      />

      {/* Attachments */}
      {ticket.attachments.length > 0 && (
        <div className="px-5 py-3 border-b border-border bg-muted/20">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Attachments
          </p>
          <div className="flex flex-wrap gap-2">
            {ticket.attachments.map((a, i) => (
              <AttachmentChip key={i} attachment={a} />
            ))}
          </div>
        </div>
      )}

      {/* Transcript */}
      <div className="px-5 py-4 space-y-4 max-h-[420px] overflow-y-auto">
        {ticket.transcript.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">No conversation history.</p>
        ) : (
          ticket.transcript.map((m, i) => <TranscriptBubble key={i} message={m} />)
        )}
      </div>

      {/* Reply box */}
      <div className="px-5 py-4 border-t border-border space-y-3">
        {/* Composer mode toggle: customer-facing reply vs. internal note */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              setComposerMode("reply");
              setFeedback(null);
            }}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              composerMode === "reply"
                ? "bg-primary text-primary-foreground"
                : "bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Mail className="h-3.5 w-3.5" />
            Reply to requester
          </button>
          <button
            type="button"
            onClick={() => {
              setComposerMode("note");
              setFeedback(null);
            }}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              composerMode === "note"
                ? "bg-amber-500 text-white"
                : "bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <StickyNote className="h-3.5 w-3.5" />
            Internal note
          </button>
        </div>

        {feedback && (
          <div
            className={cn(
              "flex items-start gap-2 rounded-md px-3 py-2 text-xs",
              feedback.kind === "ok"
                ? "bg-green-500/10 text-green-600"
                : "bg-red-500/10 text-red-600",
            )}
          >
            {feedback.kind === "ok" ? (
              <CheckCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            ) : (
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            )}
            <span>{feedback.text}</span>
          </div>
        )}

        {composerMode === "reply" ? (
          <form onSubmit={submitReply} className="space-y-2">
            {!ticket.userEmail && (
              <p className="text-xs text-amber-600 flex items-center gap-1.5">
                <AlertCircle className="h-3.5 w-3.5" />
                No email on file — a reply cannot be emailed to this requester.
              </p>
            )}
            <textarea
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              placeholder="Write a reply to the requester…"
              rows={3}
              className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={sendReply.isPending || !reply.trim() || !ticket.userEmail}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {sendReply.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                Send reply
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={submitNote} className="space-y-2">
            <p className="text-xs text-amber-600 flex items-center gap-1.5">
              <Lock className="h-3.5 w-3.5" />
              Visible only to support staff — never emailed to the requester.
            </p>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add an internal note (e.g. waiting on engineering, duplicate of #42)…"
              rows={3}
              className="w-full resize-y rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40"
            />
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={addNote.isPending || !note.trim()}
                className="inline-flex items-center gap-1.5 rounded-md bg-amber-500 px-4 py-2 text-sm font-medium text-white hover:bg-amber-600 transition-colors disabled:opacity-50"
              >
                {addNote.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <StickyNote className="h-4 w-4" />
                )}
                Add note
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function TranscriptBubble({ message }: { message: AdminSupportTicketMessage }) {
  // Internal staff notes are rendered as a full-width, visually distinct band so
  // they can never be mistaken for a customer-facing message.
  if (message.internalNote === true) {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-600 mb-1">
          <Lock className="h-3 w-3" />
          Internal note — not visible to the requester
        </div>
        <p className="text-sm whitespace-pre-wrap break-words text-foreground">{message.content}</p>
        <p className="mt-1 text-[10px] text-amber-600/80">
          {message.at ? formatDate(message.at) : ""}
        </p>
      </div>
    );
  }

  const isUser = message.role === "user";
  const isStaff = message.staffReply === true;
  const deliveryStatus = (
    message as AdminSupportTicketMessage & {
      deliveryStatus?: SupportUserDeliveryView["emailStatus"];
    }
  ).deliveryStatus;
  return (
    <div className={cn("flex gap-2.5", isUser ? "" : "flex-row-reverse")}>
      <div
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
          isUser ? "bg-muted" : "bg-primary/10",
        )}
      >
        {isUser ? (
          <User className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <Headphones className="h-3.5 w-3.5 text-primary" />
        )}
      </div>
      <div className={cn("max-w-[80%] space-y-1", isUser ? "" : "items-end")}>
        <div
          className={cn(
            "rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words",
            isUser ? "bg-muted text-foreground" : "bg-primary/10 text-foreground",
          )}
        >
          {message.content}
        </div>
        <p className={cn("text-[10px] text-muted-foreground", isUser ? "text-left" : "text-right")}>
          {isUser ? "Requester" : isStaff ? "Support (you)" : "Ora"}
          {message.at ? ` · ${formatDate(message.at)}` : ""}
          {isStaff && deliveryStatus ? ` · ${presentSupportEmailStatus(deliveryStatus)}` : ""}
        </p>
      </div>
    </div>
  );
}

function AttachmentChip({ attachment }: { attachment: AdminSupportTicketAttachment }) {
  const [downloading, setDownloading] = useState(false);

  async function download() {
    if (!attachment.downloadUrl || downloading) return;
    setDownloading(true);
    try {
      const res = await authFetch(attachment.downloadUrl);
      if (!res.ok) throw new Error("download failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = attachment.fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      // best-effort; surface nothing intrusive
    } finally {
      setDownloading(false);
    }
  }

  return (
    <button
      onClick={download}
      disabled={!attachment.downloadUrl || downloading}
      className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-xs hover:bg-muted transition-colors disabled:opacity-50"
    >
      {downloading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Download className="h-3.5 w-3.5" />
      )}
      <span className="max-w-[160px] truncate">{attachment.fileName}</span>
    </button>
  );
}
