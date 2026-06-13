import { describe, expect, it } from "vitest";
import { parseSupportTicketRouteId } from "../support-tickets";

describe("parseSupportTicketRouteId", () => {
  it("accepts positive integer route ids", () => {
    expect(parseSupportTicketRouteId("1")).toBe(1);
    expect(parseSupportTicketRouteId("42")).toBe(42);
  });

  it("rejects missing, non-numeric, zero, and decimal ids", () => {
    expect(parseSupportTicketRouteId()).toBeNull();
    expect(parseSupportTicketRouteId("abc")).toBeNull();
    expect(parseSupportTicketRouteId("0")).toBeNull();
    expect(parseSupportTicketRouteId("-1")).toBeNull();
    expect(parseSupportTicketRouteId("1.5")).toBeNull();
  });
});
