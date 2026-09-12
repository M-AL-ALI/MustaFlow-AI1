import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProvisioningProgress } from "./provisioning-progress";

afterEach(cleanup);

const props = () => ({
  status: "ready" as const,
  step: null,
  error: null,
  estimatedSecondsRemaining: null,
  elapsedSeconds: 0,
  retrying: false,
  onRetry: vi.fn(),
  onLogsClick: vi.fn(),
});

describe("Environment setup controls", () => {
  it("labels setup readiness without claiming that the app is running", async () => {
    const user = userEvent.setup();
    render(<ProvisioningProgress {...props()} />);
    const trigger = screen.getByRole("button", { name: "Environment ready" });
    expect(screen.queryByText("Running")).toBeNull();
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "Environment setup details" })).toHaveTextContent(
      "Runtime setup is complete. Database readiness, build results, and preview availability are checked separately.",
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("does not describe runtime setup as proof of database readiness", async () => {
    const user = userEvent.setup();
    render(<ProvisioningProgress {...props()} />);
    await user.click(screen.getByRole("button", { name: "What is provisioning?" }));
    expect(
      await screen.findByText(
        "Environment setup tracks this project's runtime. Database readiness, build results, and preview availability are checked separately.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(/tracks this project's server and database/)).toBeNull();
  });

  it("offers retry and logs even when a failed setup has no error payload", async () => {
    const user = userEvent.setup();
    const input = props();
    render(<ProvisioningProgress {...input} status="error" />);
    await user.click(screen.getByRole("button", { name: "Setup failed" }));
    expect(screen.getByRole("alert")).toHaveTextContent("No error details were provided.");
    await user.click(screen.getByRole("button", { name: "Retry setup" }));
    expect(input.onRetry).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "View environment logs" }));
    expect(input.onLogsClick).toHaveBeenCalledTimes(1);
  });

  it("disables repeated setup attempts while retaining log access", async () => {
    const user = userEvent.setup();
    render(<ProvisioningProgress {...props()} status="error" retrying />);
    await user.click(screen.getByRole("button", { name: "Setup failed" }));
    expect(screen.getByRole("button", { name: /Retrying/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "View environment logs" })).toBeEnabled();
  });

  it("describes hibernation without promising an automatic wake", async () => {
    const user = userEvent.setup();
    render(<ProvisioningProgress {...props()} status="hibernated" />);
    await user.click(screen.getByRole("button", { name: "Environment hibernated" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Use the preview controls to wake the runtime.",
    );
    expect(screen.getByRole("dialog")).not.toHaveTextContent("will wake");
  });

  it("preserves the quiet idle state", () => {
    render(<ProvisioningProgress {...props()} status="idle" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
