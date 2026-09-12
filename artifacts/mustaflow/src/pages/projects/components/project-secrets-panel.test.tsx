import { act, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SecretEntry } from "@workspace/api-client-react";
import { ProjectSecretsPanel, ProjectSecretsView } from "./project-secrets-panel";
const api = vi.hoisted(() => ({ save: vi.fn(), list: vi.fn() }));
vi.mock("@workspace/api-client-react", () => ({
  createSecret: (...args: unknown[]) => api.save(...args),
  listSecrets: (...args: unknown[]) => api.list(...args),
  getListSecretsQueryKey: (id: number) => ["/api/projects/" + id + "/secrets"],
}));
const key = (overrides: Partial<SecretEntry> = {}): SecretEntry => ({
  id: 1,
  projectId: 101,
  name: "DEMO_KEY",
  environment: "development",
  isPreviewSafe: true,
  minRole: "viewer",
  masked: "masked",
  createdAt: "2026-09-11T00:00:00.000Z",
  ...overrides,
});
const base = {
  projectId: 101,
  secrets: [] as SecretEntry[],
  phase: "ready" as const,
  onRefresh: vi.fn(async () => undefined),
  onSaveSecret: vi.fn(async () => "saved" as const),
  renderSecret: (secret: SecretEntry) => <div>{secret.name}</div>,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { resolve, reject, promise };
}
async function fill(user: ReturnType<typeof userEvent.setup>, name = "DEMO_KEY") {
  await user.type(screen.getByLabelText("Key name", { exact: true }), name);
  await user.type(screen.getByLabelText("Secret value", { exact: true }), "synthetic-value-only");
}
beforeEach(() => {
  vi.resetAllMocks();
  base.onRefresh.mockResolvedValue(undefined);
  base.onSaveSecret.mockResolvedValue("saved");
});
describe("project Secrets states and recovery", () => {
  it("distinguishes a confirmed empty list from loading", () => {
    const { rerender } = render(
      <ProjectSecretsView {...base} phase="loading" secrets={undefined} />,
    );
    expect(screen.getByRole("status", { name: "Secret list loading" })).toBeInTheDocument();
    expect(screen.queryByText(/No keys are configured/)).not.toBeInTheDocument();
    rerender(<ProjectSecretsView {...base} />);
    expect(screen.getByText(/No keys are configured/)).toBeInTheDocument();
  });
  it("does not treat undefined successful data as confirmed emptiness", () => {
    render(<ProjectSecretsView {...base} secrets={undefined} />);
    expect(screen.getByRole("status", { name: "Secret list loading" })).toBeInTheDocument();
  });
  it("shows a retryable error without stale rows or an injected count", async () => {
    const user = userEvent.setup();
    render(<ProjectSecretsView {...base} secrets={[key()]} phase="error" />);
    expect(screen.getByRole("alert", { name: "Secret list status" })).toHaveTextContent(
      "could not be confirmed",
    );
    expect(
      screen.queryByRole("region", { name: "Build and preview eligibility" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("DEMO_KEY")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh keys" }));
    expect(base.onRefresh).toHaveBeenCalledTimes(1);
  });
  it("hides metadata from another project and prevents writes", async () => {
    const user = userEvent.setup();
    render(
      <ProjectSecretsView {...base} secrets={[key({ projectId: 102, name: "FOREIGN_KEY" })]} />,
    );
    expect(screen.getByRole("alert", { name: "Secret list status" })).toHaveTextContent(
      "does not match this project",
    );
    expect(screen.queryByText("FOREIGN_KEY")).not.toBeInTheDocument();
    await fill(user);
    expect(screen.getByRole("button", { name: "Save key" })).toBeDisabled();
  });
  it("shows precise eligibility reasons without claiming runtime injection", () => {
    render(
      <ProjectSecretsView
        {...base}
        secrets={[
          key(),
          key({ id: 2, name: "PROD_ONLY", environment: "production" }),
          key({ id: 3, name: "OWNER_ONLY", minRole: "owner" }),
          key({ id: 4, name: "PREVIEW_OFF", isPreviewSafe: false }),
        ]}
      />,
    );
    const summary = within(screen.getByRole("region", { name: "Build and preview eligibility" }));
    expect(summary.getByText("1 eligible / 3 excluded")).toBeInTheDocument();
    expect(summary.getByText("Restricted to higher roles")).toBeInTheDocument();
    expect(summary.getByText("Preview access off")).toBeInTheDocument();
    expect(summary.getByText(/not proof of which values a running container/)).toBeInTheDocument();
    expect(screen.queryByText(/All secrets are injected/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/restarts a running container automatically/),
    ).not.toBeInTheDocument();
  });
  it("keeps the four environment groups and existing row controls", () => {
    render(
      <ProjectSecretsView
        {...base}
        secrets={[
          key(),
          key({ id: 2, environment: "testing" }),
          key({ id: 3, environment: "staging" }),
          key({ id: 4, environment: "production" }),
        ]}
        renderSecret={(secret) => <button>{"Manage key " + secret.id}</button>}
      />,
    );
    for (const env of ["Development", "Testing", "Staging", "Production"])
      expect(screen.getByRole("region", { name: env + " keys" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Manage key/ })).toHaveLength(4);
  });
  it("saves with explicit preview opt-out by default and clears values", async () => {
    const user = userEvent.setup();
    render(<ProjectSecretsView {...base} />);
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(base.onSaveSecret).toHaveBeenCalledWith({
      name: "DEMO_KEY",
      value: "synthetic-value-only",
      environment: "development",
      isPreviewSafe: false,
    });
    expect(screen.getByLabelText("Secret value", { exact: true })).toHaveValue("");
    expect(screen.getByRole("status", { name: "Secret save result" })).toHaveTextContent(
      "not proof",
    );
  });
  it("sends the explicit preview opt-in only for a development/testing key", async () => {
    const user = userEvent.setup();
    render(<ProjectSecretsView {...base} />);
    await fill(user);
    await user.selectOptions(screen.getByLabelText("Environment", { exact: true }), "testing");
    await user.click(screen.getByRole("checkbox", { name: /Allow this key/ }));
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(base.onSaveSecret).toHaveBeenCalledWith(
      expect.objectContaining({ environment: "testing", isPreviewSafe: true }),
    );
  });
  it("clears opt-in when the environment changes and never enables production preview", async () => {
    const user = userEvent.setup();
    render(<ProjectSecretsView {...base} />);
    await fill(user);
    await user.click(screen.getByRole("checkbox", { name: /Allow this key/ }));
    await user.selectOptions(screen.getByLabelText("Environment", { exact: true }), "production");
    expect(screen.queryByRole("checkbox", { name: /Allow this key/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(base.onSaveSecret).toHaveBeenCalledWith(
      expect.objectContaining({ environment: "production", isPreviewSafe: false }),
    );
  });
  it("requires a fresh opt-in after returning to development", async () => {
    const user = userEvent.setup();
    render(<ProjectSecretsView {...base} />);
    await user.click(screen.getByRole("checkbox", { name: /Allow this key/ }));
    await user.selectOptions(screen.getByLabelText("Environment", { exact: true }), "staging");
    await user.selectOptions(screen.getByLabelText("Environment", { exact: true }), "development");
    expect(screen.getByRole("checkbox", { name: /Allow this key/ })).not.toBeChecked();
  });
  it("clears a failed value and does not leak server error details", async () => {
    const user = userEvent.setup();
    render(
      <ProjectSecretsView
        {...base}
        onSaveSecret={async () => {
          throw new Error("private-error-detail");
        }}
      />,
    );
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Save key" }));
    const alert = screen.getByRole("alert", { name: "Secret save status" });
    expect(alert).toHaveTextContent("could not be saved");
    expect(alert).not.toHaveTextContent("private-error-detail");
    expect(screen.getByLabelText("Secret value", { exact: true })).toHaveValue("");
    expect(screen.queryByRole("status", { name: "Secret save result" })).not.toBeInTheDocument();
  });
  it("distinguishes an acknowledged save from a failed list reload", async () => {
    const user = userEvent.setup();
    render(<ProjectSecretsView {...base} onSaveSecret={async () => "saved-refresh-failed"} />);
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(screen.getByRole("alert", { name: "Secret save status" })).toHaveTextContent(
      "was saved, but the list could not be refreshed",
    );
    expect(screen.getByRole("alert", { name: "Secret save status" })).toHaveTextContent(
      "do not add it again",
    );
    expect(screen.getByLabelText("Secret value", { exact: true })).toHaveValue("");
  });
  it("does not claim success for an unconfirmed save response", async () => {
    const user = userEvent.setup();
    render(<ProjectSecretsView {...base} onSaveSecret={async () => "unconfirmed"} />);
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(screen.getByRole("alert", { name: "Secret save status" })).toHaveTextContent(
      "did not confirm this project's key",
    );
    expect(screen.queryByRole("status", { name: "Secret save result" })).not.toBeInTheDocument();
  });
  it("locks the form during a save and prevents duplicate submissions", async () => {
    const user = userEvent.setup();
    const pending = deferred<"saved">();
    const save = vi.fn(() => pending.promise);
    render(<ProjectSecretsView {...base} onSaveSecret={save} />);
    await fill(user);
    await user.dblClick(screen.getByRole("button", { name: "Save key" }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Key name", { exact: true })).toBeDisabled();
    expect(screen.getByLabelText("Secret value", { exact: true })).toBeDisabled();
    expect(screen.getByLabelText("Environment", { exact: true })).toBeDisabled();
    await act(async () => {
      pending.resolve("saved");
      await pending.promise;
    });
  });
  it("resets a draft and ignores late completion when switching projects", async () => {
    const user = userEvent.setup();
    const pending = deferred<"saved">();
    const { rerender } = render(
      <ProjectSecretsView {...base} onSaveSecret={() => pending.promise} />,
    );
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Save key" }));
    rerender(<ProjectSecretsView {...base} projectId={102} />);
    expect(screen.getByLabelText("Key name", { exact: true })).toHaveValue("");
    await act(async () => {
      pending.resolve("saved");
      await pending.promise;
    });
    expect(screen.queryByRole("status", { name: "Secret save result" })).not.toBeInTheDocument();
  });
  it("does not associate a typed value with a new agent-prefilled key name", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ProjectSecretsView {...base} prefillSecretName="FIRST_KEY" />);
    await user.type(screen.getByLabelText("Secret value", { exact: true }), "test-only");
    rerender(<ProjectSecretsView {...base} prefillSecretName="SECOND_KEY" />);
    expect(screen.getByLabelText("Key name", { exact: true })).toHaveValue("SECOND_KEY");
    expect(screen.getByLabelText("Secret value", { exact: true })).toHaveValue("");
  });
  it("preserves guide selection while clearing an unrelated typed value", async () => {
    const user = userEvent.setup();
    render(
      <ProjectSecretsView
        {...base}
        renderGuide={(select) => (
          <button onClick={() => select("GUIDED_KEY")}>Choose guided key</button>
        )}
      />,
    );
    await fill(user);
    await user.click(screen.getByText("Find the key name for a service"));
    await user.click(screen.getByRole("button", { name: "Choose guided key" }));
    expect(screen.getByLabelText("Key name", { exact: true })).toHaveValue("GUIDED_KEY");
    expect(screen.getByLabelText("Secret value", { exact: true })).toHaveValue("");
    expect(screen.getByLabelText("Secret value", { exact: true })).toHaveFocus();
  });
  it("offers an explicit retry after refresh fails without pretending the list is empty", async () => {
    const user = userEvent.setup();
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error("private-detail"))
      .mockResolvedValueOnce(undefined);
    render(<ProjectSecretsView {...base} onRefresh={refresh} />);
    await user.click(screen.getByRole("button", { name: "Refresh keys" }));
    expect(screen.getByRole("alert", { name: "Secret list status" })).toHaveTextContent(
      "The refresh failed",
    );
    expect(screen.queryByText(/No keys are configured/)).not.toBeInTheDocument();
    await fill(user);
    expect(screen.getByRole("button", { name: "Save key" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Refresh keys" }));
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert", { name: "Secret list status" })).not.toBeInTheDocument();
  });
  it("ignores a late refresh failure after closing the tool", async () => {
    const user = userEvent.setup();
    const pending = deferred<void>();
    const { unmount } = render(<ProjectSecretsView {...base} onRefresh={() => pending.promise} />);
    await user.click(screen.getByRole("button", { name: "Refresh keys" }));
    unmount();
    await act(async () => {
      pending.reject(new Error("not-visible"));
      await expect(pending.promise).rejects.toThrow("not-visible");
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it.each(["2KEY", "BAD KEY", "BAD-KEY"])("does not submit invalid key name %s", async (name) => {
    const user = userEvent.setup();
    render(<ProjectSecretsView {...base} />);
    await fill(user, name);
    expect(screen.getByLabelText("Key name", { exact: true })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(screen.getByRole("button", { name: "Save key" })).toBeDisabled();
    expect(base.onSaveSecret).not.toHaveBeenCalled();
  });
});
describe("project Secrets API adapter", () => {
  function mount() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ProjectSecretsPanel {...base} />
      </QueryClientProvider>,
    );
    return client;
  }
  it("writes and refreshes only the current project", async () => {
    const user = userEvent.setup();
    api.save.mockResolvedValue(key());
    api.list.mockResolvedValue([key()]);
    const client = mount();
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Save key" }));
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Secret save result" })).toBeInTheDocument(),
    );
    expect(api.save).toHaveBeenCalledWith(101, {
      name: "DEMO_KEY",
      value: "synthetic-value-only",
      environment: "development",
      isPreviewSafe: false,
    });
    expect(api.list).toHaveBeenCalledWith(101);
    client.clear();
  });
  it("retains acknowledged-save truth when refresh fails", async () => {
    const user = userEvent.setup();
    api.save.mockResolvedValue(key());
    api.list.mockRejectedValue(new Error("private"));
    const client = mount();
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(await screen.findByRole("alert", { name: "Secret save status" })).toHaveTextContent(
      "was saved",
    );
    expect(api.save).toHaveBeenCalledTimes(1);
    client.clear();
  });
  it("rejects response metadata for another project before reporting success", async () => {
    const user = userEvent.setup();
    api.save.mockResolvedValue(key({ projectId: 102 }));
    const client = mount();
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(await screen.findByRole("alert", { name: "Secret save status" })).toHaveTextContent(
      "did not confirm",
    );
    expect(api.list).not.toHaveBeenCalled();
    client.clear();
  });
});

describe("secret recovery regression", () => {
  it("clears only the obsolete post-save refresh warning after a successful reload", async () => {
    const user = userEvent.setup();
    render(<ProjectSecretsView {...base} onSaveSecret={async () => "saved-refresh-failed"} />);
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(screen.getByRole("alert", { name: "Secret save status" })).toHaveTextContent(
      "was saved",
    );
    await user.click(screen.getByRole("button", { name: "Refresh keys" }));
    expect(screen.queryByRole("alert", { name: "Secret save status" })).not.toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Secret save result" })).not.toBeInTheDocument();
  });
  it.each(["unconfirmed", "write-failed"] as const)(
    "does not turn %s into successful save after refreshing",
    async (mode) => {
      const user = userEvent.setup();
      render(
        <ProjectSecretsView
          {...base}
          onSaveSecret={async () => {
            if (mode === "write-failed") throw Error("synthetic");
            return "unconfirmed";
          }}
        />,
      );
      await fill(user);
      await user.click(screen.getByRole("button", { name: "Save key" }));
      await user.click(screen.getByRole("button", { name: "Refresh keys" }));
      expect(screen.getByRole("alert", { name: "Secret save status" })).toBeInTheDocument();
      expect(screen.queryByRole("status", { name: "Secret save result" })).not.toBeInTheDocument();
    },
  );
  it("keeps the post-save warning when reloading still fails", async () => {
    const user = userEvent.setup();
    render(
      <ProjectSecretsView
        {...base}
        onSaveSecret={async () => "saved-refresh-failed"}
        onRefresh={async () => {
          throw Error("synthetic");
        }}
      />,
    );
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Save key" }));
    await user.click(screen.getByRole("button", { name: "Refresh keys" }));
    expect(screen.getByRole("alert", { name: "Secret save status" })).toHaveTextContent(
      "was saved",
    );
    expect(screen.getByRole("alert", { name: "Secret list status" })).toHaveTextContent(
      "refresh failed",
    );
  });
  it("uses explicit non-login names and new-password semantics without revealing values", () => {
    render(<ProjectSecretsView {...base} />);
    expect(screen.getByLabelText("Key name", { exact: true })).toHaveAttribute(
      "name",
      "project-secret-key-name-101",
    );
    const field = screen.getByLabelText("Secret value", { exact: true });
    expect(field).toHaveAttribute("name", "project-api-secret-101");
    expect(field).toHaveAttribute("autocomplete", "new-password");
    expect(field).toHaveAttribute("type", "password");
  });
});
