import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  APPLY_FAILURE_FALLBACK_ERROR,
  PROJECT_FILE_VERSION_HANDOFF_ERROR,
} from "@/lib/user-visible-errors";
import { ApplyFailureNotice } from "./apply-failure-notice";

describe("ApplyFailureNotice", () => {
  it("shows the clean rollback result from a failed version handoff", () => {
    render(<ApplyFailureNotice error={{ data: { error: PROJECT_FILE_VERSION_HANDOFF_ERROR } }} />);

    expect(screen.getByRole("alert")).toHaveTextContent(PROJECT_FILE_VERSION_HANDOFF_ERROR);
  });

  it("does not render raw server failure text", () => {
    const rawMessage = "duplicate key value violates postgres constraint project_files_path";
    render(<ApplyFailureNotice error={{ data: { error: rawMessage } }} />);

    expect(screen.getByRole("alert")).toHaveTextContent(APPLY_FAILURE_FALLBACK_ERROR);
    expect(screen.queryByText(rawMessage)).not.toBeInTheDocument();
  });
});
