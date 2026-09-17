import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ update: vi.fn(), identity: vi.fn(), send: vi.fn() }));
vi.mock("@workspace/api-client-react", () => ({
  useGetAgentRouting: () => ({ data: undefined }),
  useUpdateProject: () => ({ mutate: fixture.update }),
  useUpdateMyPreferences: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/lib/builder-followup-submit", () => ({
  resolveBuilderComposerIntent: () => "build",
}));
vi.mock("./builder-mode-control", () => ({ BuilderModeControl: () => null }));
vi.mock("./plan-templates-picker", () => ({ PlanTemplatesPicker: () => null }));
vi.mock("./plan-history", () => ({ PlanHistoryPanel: () => null }));
vi.mock("@/components/brainstorm-panel", () => ({ BrainstormPanel: () => null }));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: PropsWithChildren) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: PropsWithChildren) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: PropsWithChildren) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect }: PropsWithChildren<{ onSelect?: () => void }>) => (
    <button onClick={onSelect}>{children}</button>
  ),
  DropdownMenuLabel: ({ children }: PropsWithChildren) => <span>{children}</span>,
  DropdownMenuSeparator: () => <hr />,
}));
import { QueueComposer } from "./queue-composer";
function Harness() {
  const [planning, setPlanning] = useState(true);
  return (
    <QueueComposer
      projectId={61}
      agentMode="eco"
      onAgentModeChange={vi.fn()}
      deepReasoning={false}
      onDeepReasoningChange={vi.fn()}
      planMode={planning}
      onPlanModeChange={setPlanning}
      runInBackground={false}
      onRunInBackgroundChange={vi.fn()}
      variantMode={false}
      onVariantModeChange={vi.fn()}
      disabled={false}
      onSingleSend={fixture.send}
      onBatchStarted={vi.fn()}
      onAgentIdentityChange={fixture.identity}
    />
  );
}
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});
afterEach(cleanup);
describe("visible, explicit composer planning mode", () => {
  it("offers an exit when parent planning is true but the local identity is main", () => {
    render(<Harness />);
    expect(screen.getByText("Planning only")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Exit planning" }));
    expect(screen.queryByText("Planning only")).not.toBeInTheDocument();
    expect(fixture.identity).toHaveBeenCalledWith("main");
  });
  it("makes Fix or improve leave planning-only mode", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Fix or improve..." }));
    expect(screen.queryByText("Planning only")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("Fix or improve this app: ");
    expect(fixture.update).toHaveBeenCalledWith({ id: 61, data: { defaultAgent: "main" } });
  });
  it("toggles the effective plan mode rather than a stale local identity", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Plan first/ }));
    expect(screen.queryByText("Planning only")).not.toBeInTheDocument();
  });
});
