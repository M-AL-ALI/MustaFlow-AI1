import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { OraFileEditQuality } from "@workspace/ora-contracts";
import { OraEditQualityCard } from "../ora-edit-quality-card";

/**
 * Website edit-quality transparency card (Phase A). Mirrors the mobile
 * `edit-quality-card-wiring.test.ts` coverage: every edit mode must render an
 * honest label, the layout claim is only shown when the server did not flag
 * layout loss, the server warning surfaces verbatim, and long change lists
 * collapse behind an expandable "more changes" control.
 */

const quality = (overrides: Partial<OraFileEditQuality> = {}): OraFileEditQuality => ({
  editMode: "original_edited",
  ...overrides,
});

afterEach(() => cleanup());

describe("OraEditQualityCard — edit modes", () => {
  it("original_edited renders the edited label with the layout-preserved claim", () => {
    render(<OraEditQualityCard quality={quality()} />);
    expect(screen.getByText("Edited your original file")).toBeTruthy();
    expect(screen.getByText("Layout and design preserved")).toBeTruthy();
  });

  it("suppresses the layout claim when the server flagged layout loss", () => {
    render(<OraEditQualityCard quality={quality({ preservedLayout: false })} />);
    expect(screen.getByText("Edited your original file")).toBeTruthy();
    expect(screen.queryByText("Layout and design preserved")).toBeNull();
  });

  it("unchanged renders the honest returned-unchanged label", () => {
    render(<OraEditQualityCard quality={quality({ editMode: "unchanged" })} />);
    expect(screen.getByText("Original file returned unchanged")).toBeTruthy();
  });

  it("redesigned admits the original layout was not preserved", () => {
    render(<OraEditQualityCard quality={quality({ editMode: "redesigned" })} />);
    expect(screen.getByText("Rebuilt from your content")).toBeTruthy();
    expect(screen.getByText("The original layout was not preserved")).toBeTruthy();
  });

  it("failed_safe renders the not-applied label", () => {
    render(<OraEditQualityCard quality={quality({ editMode: "failed_safe" })} />);
    expect(screen.getByText("Edit not applied — original returned unchanged")).toBeTruthy();
  });

  it("surfaces the server warning verbatim", () => {
    render(
      <OraEditQualityCard
        quality={quality({
          editMode: "failed_safe",
          warning: "The document was password protected, so no changes were made.",
        })}
      />,
    );
    expect(
      screen.getByText("The document was password protected, so no changes were made."),
    ).toBeTruthy();
  });
});

describe("OraEditQualityCard — change list collapse", () => {
  const changes = [
    'Replaced: "Q1" → "Q2"',
    "Updated the revenue table",
    "Fixed the header date",
    "Renamed the summary section",
    "Adjusted chart labels",
    "Corrected two typos",
  ];

  it("collapses to four changes with an expandable count", () => {
    render(<OraEditQualityCard quality={quality({ changes })} />);
    expect(screen.getByText('Replaced: "Q1" → "Q2"')).toBeTruthy();
    expect(screen.getByText("Renamed the summary section")).toBeTruthy();
    expect(screen.queryByText("Adjusted chart labels")).toBeNull();
    expect(screen.getByRole("button", { name: /2 more changes/ })).toBeTruthy();
  });

  it("expands to all changes and offers to collapse again", () => {
    render(<OraEditQualityCard quality={quality({ changes })} />);
    fireEvent.click(screen.getByRole("button", { name: /2 more changes/ }));
    expect(screen.getByText("Adjusted chart labels")).toBeTruthy();
    expect(screen.getByText("Corrected two typos")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Show fewer changes/ })).toBeTruthy();
  });

  it("renders no expand control when four or fewer changes exist", () => {
    render(<OraEditQualityCard quality={quality({ changes: changes.slice(0, 3) })} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("uses singular copy for exactly one hidden change", () => {
    render(<OraEditQualityCard quality={quality({ changes: changes.slice(0, 5) })} />);
    expect(screen.getByRole("button", { name: /1 more change$/ })).toBeTruthy();
  });
});
