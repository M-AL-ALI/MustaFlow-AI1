import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EditAndResend, latestUserMessageId } from "./edit-and-resend";

describe("latestUserMessageId", () => {
  it("selects only the final user-authored message", () => {
    expect(
      latestUserMessageId([
        { id: 1, role: "user", content: "First request" },
        { id: 2, role: "assistant", content: "First reply" },
        { id: 3, role: "user", content: "Change the subtitle" },
        { id: 4, role: "assistant", content: "Done" },
      ]),
    ).toBe(3);
  });

  it("returns null when there is no editable user message", () => {
    expect(latestUserMessageId(undefined)).toBeNull();
    expect(latestUserMessageId([{ id: 1, role: "assistant", content: "Hello" }])).toBeNull();
  });
});

describe("EditAndResend", () => {
  it("restores the message through its edit callback", () => {
    const onEdit = vi.fn();
    render(<EditAndResend onEdit={onEdit} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit and resend this message" }));

    expect(onEdit).toHaveBeenCalledOnce();
  });
});
