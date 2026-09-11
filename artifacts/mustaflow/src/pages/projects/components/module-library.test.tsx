import { act, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import type { SecretInput } from "@workspace/api-client-react";
import { ModuleLibrary, ModuleLibraryView } from "./module-library";
import type { ModuleSecret } from "./module-library-model";
const api = vi.hoisted(() => ({ save: vi.fn(), list: vi.fn() }));
vi.mock("@workspace/api-client-react", () => ({
  useCreateSecret: () => ({ mutateAsync: api.save }),
  listSecrets: (...args: unknown[]) => api.list(...args),
  getListSecretsQueryKey: (id: number) => ["/api/projects/" + id + "/secrets"],
}));
const key = (name: string, overrides: Partial<ModuleSecret> = {}): ModuleSecret => ({
  id: 1,
  projectId: 101,
  name,
  environment: "development",
  isPreviewSafe: true,
  ...overrides,
});
const keys = [key("SUPABASE_URL"), key("SUPABASE_ANON_KEY", { id: 2 })];
const defaults = {
  projectId: 101,
  secrets: [] as ModuleSecret[],
  secretState: "ready" as const,
  onSaveSecret: vi.fn(async () => [] as ModuleSecret[]),
  onSendMessage: vi.fn(),
};
const card = (name = "Real-time Database") => within(screen.getByRole("article", { name }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { resolve, reject, promise };
}
beforeEach(() => {
  vi.clearAllMocks();
});
describe("honest module setup", () => {
  it("renders eight modules without claiming they are active or connected", () => {
    render(<ModuleLibraryView {...defaults} />);
    expect(screen.getAllByRole("article")).toHaveLength(8);
    expect(screen.queryByText("Active")).not.toBeInTheDocument();
    expect(screen.getByText(/request or an earlier report does not prove/i)).toBeInTheDocument();
  });
  it("saves all required keys in order and requests setup only after the last confirmation", async () => {
    const user = userEvent.setup();
    const send = vi.fn();
    const save = vi.fn();
    function Harness() {
      const [secrets, setSecrets] = useState<ModuleSecret[]>([]);
      return (
        <ModuleLibraryView
          {...defaults}
          secrets={secrets}
          onSendMessage={send}
          onSaveSecret={async (input) => {
            save(input);
            const next = [...secrets, key(input.name)];
            setSecrets(next);
            return next;
          }}
        />
      );
    }
    render(<Harness />);
    await user.click(card().getByRole("button", { name: "Add development keys" }));
    await user.type(screen.getByLabelText("Value for SUPABASE_URL"), "synthetic-value-one");
    await user.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Value for SUPABASE_ANON_KEY")).toHaveValue("");
    await user.type(screen.getByLabelText("Value for SUPABASE_ANON_KEY"), "synthetic-value-two");
    await user.click(screen.getByRole("button", { name: "Save and request setup" }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toContain("SUPABASE_URL, SUPABASE_ANON_KEY");
    expect(send.mock.calls[0][0]).not.toContain("synthetic-value");
    expect(save.mock.calls.map(([input]) => input)).toEqual([
      {
        name: "SUPABASE_URL",
        value: "synthetic-value-one",
        environment: "development",
        isPreviewSafe: true,
      },
      {
        name: "SUPABASE_ANON_KEY",
        value: "synthetic-value-two",
        environment: "development",
        isPreviewSafe: true,
      },
    ]);
    expect(card().getByText("Setup requested")).toBeInTheDocument();
    expect(screen.queryByText("Active")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Value for/)).not.toBeInTheDocument();
  });
  it("does not optimistically wire or retain a typed value after a save failure", async () => {
    const user = userEvent.setup();
    const save = vi.fn().mockRejectedValue(new Error("sensitive-provider-error"));
    render(<ModuleLibraryView {...defaults} onSaveSecret={save} />);
    await user.click(card().getByRole("button", { name: "Add development keys" }));
    await user.type(screen.getByLabelText("Value for SUPABASE_URL"), "not-a-real-key");
    await user.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(screen.getByRole("alert")).toHaveTextContent("No setup request was sent");
    expect(screen.getByRole("alert")).not.toHaveTextContent("sensitive-provider-error");
    expect(screen.getByLabelText("Value for SUPABASE_URL")).toHaveValue("");
    expect(defaults.onSendMessage).not.toHaveBeenCalled();
  });
  it.each([
    { projectId: 102 },
    { environment: "production" as const },
    { isPreviewSafe: false },
    { name: "WRONG_KEY" },
  ])("rejects an unconfirmed save result %j", async (overrides) => {
    const user = userEvent.setup();
    render(
      <ModuleLibraryView
        {...defaults}
        onSaveSecret={async () => [key("SUPABASE_URL", overrides)]}
      />,
    );
    await user.click(card().getByRole("button", { name: "Add development keys" }));
    await user.type(screen.getByLabelText("Value for SUPABASE_URL"), "test-value");
    await user.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(screen.getByRole("alert")).toHaveTextContent("could not be confirmed");
    expect(defaults.onSendMessage).not.toHaveBeenCalled();
  });
  it("rechecks every key when a previously saved key disappears", async () => {
    const user = userEvent.setup();
    render(
      <ModuleLibraryView {...defaults} secrets={[keys[0]]} onSaveSecret={async () => [keys[1]]} />,
    );
    await user.click(card().getByRole("button", { name: "Add development keys" }));
    await user.type(screen.getByLabelText("Value for SUPABASE_ANON_KEY"), "test-value");
    await user.click(screen.getByRole("button", { name: "Save and request setup" }));
    expect(screen.getByLabelText("Value for SUPABASE_URL")).toHaveValue("");
    expect(defaults.onSendMessage).not.toHaveBeenCalled();
  });
  it.each(["loading", "error"] as const)(
    "does not turn a %s key query into a setup request",
    async (secretState) => {
      render(<ModuleLibraryView {...defaults} secrets={keys} secretState={secretState} />);
      expect(card().getByRole("button", { name: "Set up with agent" })).toBeDisabled();
      expect(card().getByText("Keys not confirmed")).toBeInTheDocument();
    },
  );
  it("disables setup without an agent instead of faking success", () => {
    render(<ModuleLibraryView {...defaults} onSendMessage={undefined} />);
    expect(
      card("Push Notifications").getByRole("button", { name: "Set up with agent" }),
    ).toBeDisabled();
    expect(screen.queryByText("Setup requested")).not.toBeInTheDocument();
  });
  it("requests a keyless module without saving an invented secret", async () => {
    const user = userEvent.setup();
    render(<ModuleLibraryView {...defaults} />);
    await user.click(card("Push Notifications").getByRole("button", { name: "Set up with agent" }));
    expect(defaults.onSendMessage).toHaveBeenCalledTimes(1);
    expect(defaults.onSaveSecret).not.toHaveBeenCalled();
    expect(card("Push Notifications").getByText("Setup requested")).toBeInTheDocument();
  });
  it("uses pre-existing complete development keys without prompting for them again", async () => {
    const user = userEvent.setup();
    render(<ModuleLibraryView {...defaults} secrets={keys} />);
    await user.click(card().getByRole("button", { name: "Set up with agent" }));
    expect(defaults.onSendMessage).toHaveBeenCalledTimes(1);
    expect(defaults.onSaveSecret).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/Value for/)).not.toBeInTheDocument();
  });
  it("prevents a duplicate request while the same module remains open", async () => {
    const user = userEvent.setup();
    render(<ModuleLibraryView {...defaults} secrets={keys} />);
    const button = card().getByRole("button", { name: "Set up with agent" });
    await user.dblClick(button);
    expect(defaults.onSendMessage).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
  });
  it("shows a request failure and permits an explicit retry", async () => {
    const user = userEvent.setup();
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("private details"))
      .mockResolvedValueOnce(undefined);
    render(<ModuleLibraryView {...defaults} secrets={keys} onSendMessage={send} />);
    await user.click(card().getByRole("button", { name: "Set up with agent" }));
    expect(screen.getByRole("alert")).toHaveTextContent("could not be sent");
    expect(screen.queryByText("Setup requested")).not.toBeInTheDocument();
    await user.click(card().getByRole("button", { name: "Set up with agent" }));
    expect(send).toHaveBeenCalledTimes(2);
    expect(card().getByText("Setup requested")).toBeInTheDocument();
  });
  it("shows an old report honestly and asks for a check instead of claiming connectivity", async () => {
    const user = userEvent.setup();
    render(<ModuleLibraryView {...defaults} secrets={keys} wiredModuleIds={["realtime-db"]} />);
    expect(card().getByText("Added in last report")).toBeInTheDocument();
    await user.click(card().getByRole("button", { name: "Check with agent" }));
    expect(defaults.onSendMessage.mock.calls[0][0]).toContain("non-destructive");
    expect(card().getByText("Check requested")).toBeInTheDocument();
  });
  it("does not let a historical report override missing keys", () => {
    render(<ModuleLibraryView {...defaults} wiredModuleIds={["realtime-db"]} />);
    expect(card().getByText("Keys needed")).toBeInTheDocument();
    expect(card().getByRole("button", { name: "Add development keys" })).toBeEnabled();
  });
  it("requests code removal without asserting it has already been removed", async () => {
    const user = userEvent.setup();
    render(<ModuleLibraryView {...defaults} secrets={keys} wiredModuleIds={["realtime-db"]} />);
    await user.click(card().getByRole("button", { name: "Request removal" }));
    expect(card().getByText("Removal requested")).toBeInTheDocument();
    expect(defaults.onSendMessage.mock.calls[0][0]).toContain("Preserve provider accounts");
  });
  it("resets secret form state when switching projects", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ModuleLibraryView {...defaults} />);
    await user.click(card().getByRole("button", { name: "Add development keys" }));
    await user.type(screen.getByLabelText("Value for SUPABASE_URL"), "must-not-follow");
    rerender(<ModuleLibraryView {...defaults} projectId={102} />);
    expect(screen.queryByLabelText(/Value for/)).not.toBeInTheDocument();
    await user.click(card().getByRole("button", { name: "Add development keys" }));
    expect(screen.getByLabelText("Value for SUPABASE_URL")).toHaveValue("");
  });
  it("ignores late secret completion after a project switch", async () => {
    const user = userEvent.setup();
    const pending = deferred<ModuleSecret[]>();
    const { rerender } = render(
      <ModuleLibraryView {...defaults} secrets={[keys[0]]} onSaveSecret={() => pending.promise} />,
    );
    await user.click(card().getByRole("button", { name: "Add development keys" }));
    await user.type(screen.getByLabelText("Value for SUPABASE_ANON_KEY"), "test-only");
    await user.click(screen.getByRole("button", { name: "Save and request setup" }));
    rerender(<ModuleLibraryView {...defaults} projectId={102} />);
    await act(async () => {
      pending.resolve(keys);
      await pending.promise;
    });
    expect(defaults.onSendMessage).not.toHaveBeenCalled();
    expect(screen.queryByText("Setup requested")).not.toBeInTheDocument();
  });
  it("ignores late completion after closing the tool", async () => {
    const user = userEvent.setup();
    const pending = deferred<ModuleSecret[]>();
    const { unmount } = render(
      <ModuleLibraryView {...defaults} secrets={[keys[0]]} onSaveSecret={() => pending.promise} />,
    );
    await user.click(card().getByRole("button", { name: "Add development keys" }));
    await user.type(screen.getByLabelText("Value for SUPABASE_ANON_KEY"), "test-only");
    await user.click(screen.getByRole("button", { name: "Save and request setup" }));
    unmount();
    await act(async () => {
      pending.resolve(keys);
      await pending.promise;
    });
    expect(defaults.onSendMessage).not.toHaveBeenCalled();
  });
  it("locks form controls while saving and never exposes an editable key name", async () => {
    const user = userEvent.setup();
    const pending = deferred<ModuleSecret[]>();
    render(<ModuleLibraryView {...defaults} onSaveSecret={() => pending.promise} />);
    await user.click(card().getByRole("button", { name: "Add development keys" }));
    expect(screen.queryByPlaceholderText("Key name")).not.toBeInTheDocument();
    const field = screen.getByLabelText("Value for SUPABASE_URL");
    await user.type(field, "test-only");
    await user.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(field).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await act(async () => {
      pending.resolve([keys[0]]);
      await pending.promise;
    });
  });
  it("clears secret values on cancellation and switching module forms", async () => {
    const user = userEvent.setup();
    render(<ModuleLibraryView {...defaults} />);
    await user.click(card().getByRole("button", { name: "Add development keys" }));
    await user.type(screen.getByLabelText("Value for SUPABASE_URL"), "test-only");
    await user.click(card("Authentication").getByRole("button", { name: "Add development keys" }));
    expect(screen.getByLabelText("Value for CLERK_PUBLISHABLE_KEY")).toHaveValue("");
    await user.type(screen.getByLabelText("Value for CLERK_PUBLISHABLE_KEY"), "test-only");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText(/Value for/)).not.toBeInTheDocument();
  });
  it("does not send to a stale agent callback if it becomes unavailable during saving", async () => {
    const user = userEvent.setup();
    const pending = deferred<ModuleSecret[]>();
    const { rerender } = render(
      <ModuleLibraryView {...defaults} secrets={[keys[0]]} onSaveSecret={() => pending.promise} />,
    );
    await user.click(card().getByRole("button", { name: "Add development keys" }));
    await user.type(screen.getByLabelText("Value for SUPABASE_ANON_KEY"), "test-only");
    await user.click(screen.getByRole("button", { name: "Save and request setup" }));
    rerender(
      <ModuleLibraryView
        {...defaults}
        secrets={[keys[0]]}
        onSaveSecret={() => pending.promise}
        onSendMessage={undefined}
      />,
    );
    await act(async () => {
      pending.resolve(keys);
      await pending.promise;
    });
    expect(defaults.onSendMessage).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("no setup request was sent");
  });
  it("does not save a whitespace-only value", async () => {
    const user = userEvent.setup();
    render(<ModuleLibraryView {...defaults} />);
    await user.click(card().getByRole("button", { name: "Add development keys" }));
    await user.type(screen.getByLabelText("Value for SUPABASE_URL"), "   ");
    expect(screen.getByRole("button", { name: "Save and continue" })).toBeDisabled();
    expect(defaults.onSaveSecret).not.toHaveBeenCalled();
  });
});
describe("server-confirmed secret adapter", () => {
  it("writes only the current project and fetches its full metadata before dispatch", async () => {
    const user = userEvent.setup();
    const order: string[] = [];
    api.save.mockImplementation(async () => {
      order.push("save");
      return keys[1];
    });
    api.list.mockImplementation(async () => {
      order.push("list");
      return keys;
    });
    const send = vi.fn(() => {
      order.push("send");
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <ModuleLibrary
          projectId={101}
          secrets={[keys[0]]}
          secretState="ready"
          onSendMessage={send}
        />
      </QueryClientProvider>,
    );
    await user.click(card().getByRole("button", { name: "Add development keys" }));
    await user.type(screen.getByLabelText("Value for SUPABASE_ANON_KEY"), "test-only");
    await user.click(screen.getByRole("button", { name: "Save and request setup" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(order).toEqual(["save", "list", "send"]);
    expect(api.save).toHaveBeenCalledWith({
      id: 101,
      data: {
        name: "SUPABASE_ANON_KEY",
        value: "test-only",
        environment: "development",
        isPreviewSafe: true,
      },
    });
    expect(api.list).toHaveBeenCalledWith(101);
    client.clear();
  });
  it("does not dispatch when the post-save metadata refresh fails", async () => {
    const user = userEvent.setup();
    api.save.mockResolvedValue(keys[1]);
    api.list.mockRejectedValue(new Error("do-not-render"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ModuleLibrary
          projectId={101}
          secrets={[keys[0]]}
          secretState="ready"
          onSendMessage={defaults.onSendMessage}
        />
      </QueryClientProvider>,
    );
    await user.click(card().getByRole("button", { name: "Add development keys" }));
    await user.type(screen.getByLabelText("Value for SUPABASE_ANON_KEY"), "test-only");
    await user.click(screen.getByRole("button", { name: "Save and request setup" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No setup request was sent");
    expect(defaults.onSendMessage).not.toHaveBeenCalled();
    client.clear();
  });
});
