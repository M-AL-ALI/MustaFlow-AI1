import { describe, expect, it } from "vitest";
import {
  formatSupportTicketNumber,
  isSupportTicketPriority,
  normalizeSupportTicketStatus,
  staffRoleCanResolveSupportTicket,
  SUPPORT_TICKET_PRIORITIES,
} from "./support-ticket-workflow";

describe("support ticket workflow contract", () => {
  it("gives every ticket one stable human-facing number", () => {
    expect(formatSupportTicketNumber(1)).toBe("NF-000001");
    expect(formatSupportTicketNumber(1234567)).toBe("NF-1234567");
    expect(() => formatSupportTicketNumber(0)).toThrow("support_ticket_id_invalid");
  });

  it("normalizes only the two legacy terminal labels", () => {
    expect(normalizeSupportTicketStatus("closed")).toBe("resolved");
    expect(normalizeSupportTicketStatus("blocked")).toBe("blocked_on_third_party");
    expect(normalizeSupportTicketStatus("waiting_on_user")).toBe("waiting_on_user");
    expect(normalizeSupportTicketStatus("invented")).toBe("new");
  });

  it("keeps priority closed and typed", () => {
    expect(SUPPORT_TICKET_PRIORITIES).toEqual(["low", "normal", "high", "urgent"]);
    expect(isSupportTicketPriority("urgent")).toBe(true);
    expect(isSupportTicketPriority("emergency")).toBe(false);
  });

  it("allows only operational staff to resolve", () => {
    expect(staffRoleCanResolveSupportTicket("owner")).toBe(true);
    expect(staffRoleCanResolveSupportTicket("operator")).toBe(true);
    expect(staffRoleCanResolveSupportTicket("support")).toBe(true);
    expect(staffRoleCanResolveSupportTicket("analyst")).toBe(false);
  });
});
