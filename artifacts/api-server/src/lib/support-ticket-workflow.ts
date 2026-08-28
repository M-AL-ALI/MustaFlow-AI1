import type { StaffRole } from "@workspace/db";

export const SUPPORT_TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type SupportTicketPriority = (typeof SUPPORT_TICKET_PRIORITIES)[number];

export const SUPPORT_TICKET_RESOLVER_ROLES = ["owner", "operator", "support"] as const;

export function formatSupportTicketNumber(id: number): string {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("support_ticket_id_invalid");
  return `NF-${String(id).padStart(6, "0")}`;
}

export function normalizeSupportTicketStatus(
  value: string,
): "new" | "open" | "waiting_on_user" | "blocked_on_third_party" | "resolved" {
  if (value === "closed") return "resolved";
  if (value === "blocked") return "blocked_on_third_party";
  if (
    value === "new" ||
    value === "open" ||
    value === "waiting_on_user" ||
    value === "blocked_on_third_party" ||
    value === "resolved"
  ) {
    return value;
  }
  return "new";
}

export function isSupportTicketPriority(value: unknown): value is SupportTicketPriority {
  return (
    typeof value === "string" && (SUPPORT_TICKET_PRIORITIES as readonly string[]).includes(value)
  );
}

export function staffRoleCanResolveSupportTicket(role: StaffRole): boolean {
  return (SUPPORT_TICKET_RESOLVER_ROLES as readonly string[]).includes(role);
}
