import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { OraFileCitationsChip, fileCitationLabel } from "../ora-file-citations-chip";
import type { OraFileCitation } from "@workspace/ora-contracts";

afterEach(() => cleanup());

describe("fileCitationLabel", () => {
  it("renders file-only citations as the bare filename", () => {
    expect(fileCitationLabel({ file: "report.docx", kind: "file" })).toBe("report.docx");
  });

  it("renders slide citations with the server's locator verbatim (no double prefix)", () => {
    expect(fileCitationLabel({ file: "deck.pptx", locator: "Slide 4", kind: "slide" })).toBe(
      "deck.pptx — Slide 4",
    );
  });

  it("renders sheet citations with the quoted sheet name", () => {
    expect(fileCitationLabel({ file: "budget.xlsx", locator: "Revenue", kind: "sheet" })).toBe(
      'budget.xlsx — Sheet "Revenue"',
    );
  });

  it("renders section citations with a capitalized kind prefix", () => {
    expect(fileCitationLabel({ file: "notes.pdf", locator: "2.1", kind: "section" })).toBe(
      "notes.pdf — Section 2.1",
    );
  });
});

describe("OraFileCitationsChip", () => {
  it("renders nothing when there are no citations", () => {
    const { container } = render(<OraFileCitationsChip citations={[]} />);
    expect(container.querySelector('[data-testid="ora-file-citations-chip"]')).toBeNull();
  });

  it("shows a single-file label and expands to list the cited locators", () => {
    const citations: OraFileCitation[] = [
      { file: "deck.pptx", locator: "Slide 2", kind: "slide" },
      { file: "deck.pptx", locator: "Slide 3", kind: "slide" },
    ];
    const { container, getByRole } = render(<OraFileCitationsChip citations={citations} />);
    expect(container.textContent).toContain("From your file: deck.pptx");

    const button = getByRole("button");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Slide 2");
    expect(container.textContent).toContain("Slide 3");
  });

  it("shows a multi-file count label when citations span files", () => {
    const citations: OraFileCitation[] = [
      { file: "deck.pptx", locator: "Slide 2", kind: "slide" },
      { file: "budget.xlsx", locator: "Revenue", kind: "sheet" },
    ];
    const { container } = render(<OraFileCitationsChip citations={citations} />);
    expect(container.textContent).toContain("From your files: 2 files");
  });
});
