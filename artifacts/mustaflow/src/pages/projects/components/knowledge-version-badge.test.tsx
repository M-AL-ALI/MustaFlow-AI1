import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KnowledgeVersionBadge } from "./knowledge-version-badge";

describe("KnowledgeVersionBadge", () => {
  it.each([
    ["active", "Current app version"],
    ["historical", "Saved with another version"],
    ["unbound", "Version not verified"],
  ] as const)("shows the honest %s memory state", (state, label) => {
    render(
      <KnowledgeVersionBadge
        versionState={{
          semantics: "zero-memory-version-v1",
          state,
          label,
          versionId: state === "unbound" ? null : 158,
          currentVersionId: 163,
        }}
      />,
    );
    expect(screen.getByTestId("knowledge-version-state")).toHaveTextContent(label);
  });

  it("does not label global memory as app-version memory", () => {
    const { container } = render(<KnowledgeVersionBadge versionState={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
