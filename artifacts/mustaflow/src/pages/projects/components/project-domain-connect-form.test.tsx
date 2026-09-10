import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectDomainConnectForm } from "./project-domain-connect-form";

afterEach(cleanup);
function props() {
  return {
    value: "app.example.test",
    onChange: vi.fn(),
    onConnect: vi.fn(async () => {}),
    isSubmitting: false,
    error: null,
  };
}

describe("existing project domain connection form", () => {
  it("has a visible input label and explains retained registration ownership", () => {
    render(<ProjectDomainConnectForm {...props()} />);
    const input = screen.getByRole("textbox", { name: "Domain you already own" });
    expect(input).toHaveAccessibleDescription(/does not transfer its registration/);
    expect(screen.getByRole("button", { name: "Connect domain" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the controlled hostname and existing parent callback contract", () => {
    const input = props();
    render(<ProjectDomainConnectForm {...input} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Domain you already own" }), {
      target: { value: "https://another.example.test" },
    });
    expect(input.onChange).toHaveBeenCalledWith("https://another.example.test");
    expect(input.onConnect).not.toHaveBeenCalled();
  });

  it.each(["", "   "])("does not submit an empty hostname %j", (value) => {
    const input = { ...props(), value };
    render(<ProjectDomainConnectForm {...input} />);
    expect(screen.getByRole("button", { name: "Connect domain" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("form", { name: "Connect an existing domain" }));
    expect(input.onConnect).not.toHaveBeenCalled();
  });

  it("blocks duplicate form submissions synchronously until the request settles", async () => {
    let resolve!: () => void;
    const request = new Promise<void>((done) => {
      resolve = done;
    });
    const input = { ...props(), onConnect: vi.fn(() => request) };
    render(<ProjectDomainConnectForm {...input} />);
    const form = screen.getByRole("form", { name: "Connect an existing domain" });
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(input.onConnect).toHaveBeenCalledOnce();
    expect(form).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("textbox")).toBeDisabled();
    await act(async () => {
      resolve();
      await request;
    });
    expect(screen.getByRole("button", { name: "Connect domain" })).toBeEnabled();
    expect(screen.queryByText(/verified|connected successfully/i)).not.toBeInTheDocument();
  });

  it("also respects a request already pending in its parent", () => {
    const input = { ...props(), isSubmitting: true };
    render(<ProjectDomainConnectForm {...input} />);
    fireEvent.submit(screen.getByRole("form", { name: "Connect an existing domain" }));
    expect(input.onConnect).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Connecting domain" })).toBeDisabled();
  });

  it("exposes a rejected request without an unhandled rejection and allows a retry", async () => {
    const input = {
      ...props(),
      onConnect: vi.fn(async () => {
        throw new Error("Network failed");
      }),
    };
    render(<ProjectDomainConnectForm {...input} />);
    fireEvent.submit(screen.getByRole("form", { name: "Connect an existing domain" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be confirmed");
    expect(screen.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Connect domain" })).toBeEnabled();
  });

  it("associates the parent's provider error with the hostname field", () => {
    render(<ProjectDomainConnectForm {...props()} error="Domain quota reached." />);
    expect(screen.getByRole("alert")).toHaveTextContent("Domain quota reached.");
    expect(screen.getByRole("textbox")).toHaveAccessibleDescription(/Domain quota reached/);
  });
});
