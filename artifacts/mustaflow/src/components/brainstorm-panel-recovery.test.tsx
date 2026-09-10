import type { ComponentProps } from "react";
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  chat: vi.fn(),
  resolve: vi.fn(),
  create: vi.fn(),
  navigate: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("wouter", () => ({ useLocation: () => ["/projects", mocks.navigate] }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/lib/api-fetch", () => ({ authFetch: vi.fn() }));
vi.mock("@workspace/api-client-react", () => ({
  useBrainstormChat: () => useMutation({ mutationFn: mocks.chat }),
  useBrainstormResolve: () => useMutation({ mutationFn: mocks.resolve }),
  useCreateProject: () => useMutation({ mutationFn: mocks.create }),
  getListProjectsQueryKey: () => ["/api/projects"],
}));
import { BrainstormPanel } from "./brainstorm-panel";

let client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.chat.mockReset();
  mocks.resolve.mockReset();
  mocks.create.mockReset();
  localStorage.clear();
  client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false, gcTime: 0 } },
  });
});
afterEach(() => {
  cleanup();
  client.clear();
});
function mount(props: Partial<ComponentProps<typeof BrainstormPanel>> = {}) {
  return render(
    <QueryClientProvider client={client}>
      <BrainstormPanel onClose={vi.fn()} {...props} />
    </QueryClientProvider>,
  );
}
describe("brainstorm recovery and accessible controls", () => {
  it("labels controls and preserves multiline replies and automatic direction", async () => {
    mocks.chat.mockResolvedValue({
      reply: "Home -> Dashboard\nDashboard -> Note",
      buildIntent: false,
    });
    mount({ initialInput: "Plan my notebook" });
    expect(screen.getByRole("button", { name: "Close brainstorm" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "Brainstorm message" })).toHaveAttribute(
      "dir",
      "auto",
    );
    fireEvent.click(screen.getByRole("button", { name: "Send brainstorm message" }));
    const reply = await screen.findByText(/Home -> Dashboard/);
    expect(reply).toHaveAttribute("dir", "auto");
    expect(reply.className).toContain("whitespace-pre-wrap");
    expect(screen.getByRole("log", { name: "Brainstorm conversation" })).toContainElement(reply);
  });
  it("retries without duplicating the message or inventing an assistant reply", async () => {
    const message =
      "\u0623\u0631\u064a\u062f \u062a\u0637\u0628\u064a\u0642 \u0645\u0644\u0627\u062d\u0638\u0627\u062a";
    const activity = vi.fn();
    mocks.chat
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce({ reply: "A real plan", buildIntent: true });
    mount({ initialInput: message, onActivityChange: activity });
    fireEvent.click(screen.getByRole("button", { name: "Send brainstorm message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your message is kept");
    expect(activity).toHaveBeenLastCalledWith({
      status: "failed",
      label: "Brainstorming needs a retry",
    });
    expect(screen.queryByText(/Sorry, I had trouble connecting/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("A real plan");
    expect(mocks.chat.mock.calls[0][0]).toEqual(mocks.chat.mock.calls[1][0]);
    expect(within(screen.getByRole("log")).getAllByText(message)).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(activity).toHaveBeenLastCalledWith({
      status: "completed",
      label: "Brainstormed the idea",
    });
  });
  it("does not dispatch during composition or accept an oversized seed", () => {
    const view = mount({ initialInput: "Draft" });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", isComposing: true });
    expect(mocks.chat).not.toHaveBeenCalled();
    view.unmount();
    mount({ initialInput: "x".repeat(2001) });
    expect(screen.getByRole("button", { name: "Send brainstorm message" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("2,000 characters");
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(mocks.chat).not.toHaveBeenCalled();
  });
  it("does not submit an enclosing form from its controls", () => {
    const submit = vi.fn((event) => event.preventDefault());
    mocks.chat.mockResolvedValue({ reply: "Plan", buildIntent: false });
    render(
      <QueryClientProvider client={client}>
        <form onSubmit={submit}>
          <BrainstormPanel onClose={vi.fn()} initialInput="Notebook" />
        </form>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Send brainstorm message" }));
    expect(submit).not.toHaveBeenCalled();
  });
  it("ignores late results after unmount", async () => {
    let finish: (value: { reply: string; buildIntent: boolean }) => void = () => undefined;
    mocks.chat.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const activity = vi.fn();
    const view = mount({ initialInput: "Plan", onActivityChange: activity });
    fireEvent.click(screen.getByRole("button", { name: "Send brainstorm message" }));
    await waitFor(() => expect(mocks.chat).toHaveBeenCalledOnce());
    view.unmount();
    await act(async () => finish({ reply: "Late result", buildIntent: false }));
    expect(activity).toHaveBeenLastCalledWith({ status: "running", label: "Brainstorming" });
  });
  it("keeps the conversation on resolution failure instead of handing off", async () => {
    mocks.chat.mockResolvedValue({ reply: "Ready to plan", buildIntent: true });
    mocks.resolve.mockRejectedValue(new Error("invalid"));
    const resolved = vi.fn();
    const activity = vi.fn();
    mount({ initialInput: "Build my notebook", onResolved: resolved, onActivityChange: activity });
    fireEvent.click(screen.getByRole("button", { name: "Send brainstorm message" }));
    fireEvent.click(await screen.findByRole("button", { name: "Turn into plan" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("conversation is kept");
    expect(resolved).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(activity).toHaveBeenLastCalledWith({
      status: "failed",
      label: "Project brief needs a retry",
    });
  });
});

describe("brainstorm scope and boundary recovery", () => {
  it("loads a changed storage scope without overwriting it or carrying a failed retry", async () => {
    const first = [
      { role: "user", content: "Workspace A only" },
      { role: "assistant", content: "A response" },
    ];
    const second = [
      { role: "user", content: "Workspace B only" },
      { role: "assistant", content: "B response" },
    ];
    localStorage.setItem("scope-a", JSON.stringify({ messages: first, buildIntent: false }));
    localStorage.setItem("scope-b", JSON.stringify({ messages: second, buildIntent: false }));
    mocks.chat.mockRejectedValue(new Error("unavailable"));
    const view = mount({ storageKey: "scope-a", initialInput: "Follow up A" });
    fireEvent.click(screen.getByRole("button", { name: "Send brainstorm message" }));
    await screen.findByRole("alert");
    view.rerender(
      <QueryClientProvider client={client}>
        <BrainstormPanel onClose={vi.fn()} storageKey="scope-b" initialInput="B draft" />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Workspace B only")).toBeInTheDocument();
    expect(screen.queryByText("Workspace A only")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.getByRole("textbox")).toHaveValue("B draft");
    expect(JSON.parse(localStorage.getItem("scope-b")!).messages).toEqual(second);
    expect(JSON.parse(localStorage.getItem("scope-a")!).messages).toHaveLength(3);
  });
  it("fences late responses and pending state when the mounted project changes", async () => {
    let finish: (value: { reply: string; buildIntent: boolean }) => void = () => undefined;
    mocks.chat.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const activity = vi.fn();
    const view = mount({
      projectId: 601,
      initialInput: "Only project A",
      onActivityChange: activity,
    });
    fireEvent.click(screen.getByRole("button", { name: "Send brainstorm message" }));
    await waitFor(() => expect(mocks.chat).toHaveBeenCalledOnce());
    view.rerender(
      <QueryClientProvider client={client}>
        <BrainstormPanel
          onClose={vi.fn()}
          projectId={602}
          initialInput="Only project B"
          onActivityChange={activity}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("textbox")).toHaveValue("Only project B");
    expect(screen.getByRole("button", { name: "Send brainstorm message" })).toBeEnabled();
    expect(screen.queryByText("Only project A")).toBeNull();
    await act(async () => finish({ reply: "Late A response", buildIntent: true }));
    expect(screen.queryByText("Late A response")).toBeNull();
    expect(JSON.parse(localStorage.getItem("brainstorm_messages_602")!).messages).toHaveLength(1);
    expect(activity).toHaveBeenLastCalledWith({ status: "running", label: "Brainstorming" });
  });
  it("keeps a failed final turn retryable without creating a 31-message conversation", async () => {
    const history = Array.from({ length: 28 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: "Requirement " + index,
    }));
    localStorage.setItem("boundary", JSON.stringify({ messages: history, buildIntent: true }));
    mocks.chat
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce({ reply: "Final reply", buildIntent: true });
    mocks.resolve.mockImplementation(({ data }) =>
      Promise.resolve({
        name: "Notebook",
        prompt: "Keep the requirements",
        kind: "web",
        action: data.action,
        brainstormContext: data.messages,
      }),
    );
    const resolved = vi.fn();
    mount({ storageKey: "boundary", initialInput: "Final requirement", onResolved: resolved });
    fireEvent.click(screen.getByRole("button", { name: "Send brainstorm message" }));
    await screen.findByRole("alert");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Another turn" } });
    fireEvent.click(screen.getByRole("button", { name: "Send brainstorm message" }));
    expect(mocks.chat).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent("message limit");
    expect(screen.getByRole("textbox")).toHaveValue("Another turn");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Final reply");
    expect(mocks.chat.mock.calls[1][0].data.messages).toHaveLength(29);
    expect(JSON.parse(localStorage.getItem("boundary")!).messages).toHaveLength(30);
    fireEvent.click(screen.getByRole("button", { name: "Turn into plan" }));
    await waitFor(() => expect(resolved).toHaveBeenCalledOnce());
    expect(mocks.resolve.mock.calls[0][0].data.messages).toHaveLength(30);
  });
  it("gives the thread shrinkable space and keeps the recovery controls scrollable", async () => {
    localStorage.setItem(
      "full-thread",
      JSON.stringify({
        messages: Array.from({ length: 20 }, (_, index) => ({
          role: index % 2 ? "assistant" : "user",
          content: "Long requirement " + index,
        })),
        buildIntent: true,
      }),
    );
    mocks.chat.mockRejectedValue(new Error("unavailable"));
    mount({ storageKey: "full-thread", initialInput: "One more requirement" });
    fireEvent.click(screen.getByRole("button", { name: "Send brainstorm message" }));
    await screen.findByRole("alert");
    const panel = screen.getByRole("region", { name: "Brainstorm panel" });
    expect(panel.className).toContain("flex-col");
    expect(panel.className).toContain("overflow-y-auto");
    expect(screen.getByRole("log").className).toContain("min-h-0");
    expect(screen.getByRole("alert").className).toContain("shrink-0");
    expect(panel.parentElement!.className).not.toContain("max-h-[460px]");
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Turn into plan" })).toBeEnabled();
  });
});
