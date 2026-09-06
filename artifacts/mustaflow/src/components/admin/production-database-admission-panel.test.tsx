import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authFetch } from "@/lib/api-fetch";
import {
  PRODUCTION_DATABASE_ADMISSION_CONFIRMATION,
  ProductionDatabaseAdmissionPanel,
} from "./production-database-admission-panel";

vi.mock("@/lib/api-fetch", () => ({ authFetch: vi.fn() }));

const prepared = {
  configuredEpoch: "71c079dd-caa9-4abd-b61e-84eac2d93260",
  phase: "prepared",
  activeEpoch: null,
  workerDeploymentVersion: "b1bd960c-ff39-460d-8bfa-5238202194fa",
  evidenceSha256: "a".repeat(64),
  observedAt: "2026-09-06T15:00:00.000Z",
  readyAt: "2026-09-06T15:06:00.000Z",
  activatedAt: null,
  projectIdFloor: 96,
  canActivate: true,
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe("ProductionDatabaseAdmissionPanel", () => {
  beforeEach(() => vi.mocked(authFetch).mockReset());

  it("shows the typed production status and requires exact activation confirmation", async () => {
    const user = userEvent.setup();
    vi.mocked(authFetch).mockResolvedValue(jsonResponse(prepared));
    render(<ProductionDatabaseAdmissionPanel />);

    await screen.findByText("Prepared and drained. The boundary is ready for owner activation.");
    const activate = screen.getByRole("button", { name: "Activate admission boundary" });
    const confirmation = screen.getByRole("textbox");
    expect(activate).toBeDisabled();
    await user.type(confirmation, "ACTIVATE DATABASE");
    expect(activate).toBeDisabled();
    await user.clear(confirmation);
    await user.type(confirmation, PRODUCTION_DATABASE_ADMISSION_CONFIRMATION);
    expect(activate).toBeEnabled();
  });

  it("posts activation once and renders the durable active boundary", async () => {
    const user = userEvent.setup();
    vi.mocked(authFetch)
      .mockResolvedValueOnce(jsonResponse(prepared))
      .mockResolvedValueOnce(
        jsonResponse({
          ...prepared,
          phase: "active",
          activeEpoch: prepared.configuredEpoch,
          activatedAt: "2026-09-06T15:07:00.000Z",
          projectIdFloor: 643,
          canActivate: false,
        }),
      );
    render(<ProductionDatabaseAdmissionPanel />);
    await screen.findByText("Prepared and drained. The boundary is ready for owner activation.");
    await user.type(screen.getByRole("textbox"), PRODUCTION_DATABASE_ADMISSION_CONFIRMATION);
    await user.click(screen.getByRole("button", { name: "Activate admission boundary" }));

    await screen.findByText(/Every future production database allocation requires/);
    expect(authFetch).toHaveBeenLastCalledWith(
      "/api/admin/production-database-admission/activate",
      { method: "POST" },
    );
    await waitFor(() => expect(screen.queryByRole("textbox")).not.toBeInTheDocument());
  });

  it("fails closed on an unreadable response", async () => {
    vi.mocked(authFetch).mockResolvedValue(jsonResponse({ phase: "active" }));
    render(<ProductionDatabaseAdmissionPanel />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No project or database was changed.",
    );
  });
});
