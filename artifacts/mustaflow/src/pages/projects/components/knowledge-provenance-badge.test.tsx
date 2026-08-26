import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KnowledgeProvenanceBadge } from "./knowledge-provenance-badge";

describe("KnowledgeProvenanceBadge", () => {
  it("shows verified human provenance and its authorized receipt", () => {
    render(
      <KnowledgeProvenanceBadge
        provenance={{
          semantics: "zero-memory-provenance-v1",
          status: "verified",
          claimKind: "stated",
          label: "You said",
          recordedAt: "2026-08-26T20:00:00.000Z",
          source: { messageStartId: 4, messageEndId: 5, taskId: 8, versionId: 13 },
        }}
      />,
    );
    const badge = screen.getByTestId("knowledge-provenance");
    expect(badge).toHaveTextContent("You said");
    expect(badge).toHaveAttribute("title", expect.stringContaining("messages 4–5"));
    expect(badge).toHaveAttribute("title", expect.stringContaining("task 8"));
    expect(badge).toHaveAttribute("title", expect.stringContaining("version 13"));
  });

  it("labels historical entries honestly instead of guessing", () => {
    render(<KnowledgeProvenanceBadge provenance={undefined} />);
    const badge = screen.getByTestId("knowledge-provenance");
    expect(badge).toHaveTextContent("Source unverified");
    expect(badge).not.toHaveTextContent(/said|observed|inferred/i);
  });
});
