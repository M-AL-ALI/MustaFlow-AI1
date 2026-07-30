import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { BuilderModeControl } from "./builder-mode-control";

function renderWithQueryClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe("BuilderModeControl", () => {
  it("shows every mode and prices from the shared pricing tables", () => {
    const onModeChange = vi.fn();
    const onDeepReasoningChange = vi.fn();
    renderWithQueryClient(
      <BuilderModeControl
        mode="eco"
        deepReasoning={false}
        disabled={false}
        onModeChange={onModeChange}
        onDeepReasoningChange={onDeepReasoningChange}
      />,
    );

    fireEvent.click(screen.getByTestId("builder-mode-trigger"));
    const trigger = screen.getByTestId("builder-mode-trigger");
    const panel = screen.getByTestId("builder-mode-panel");

    expect(trigger.querySelector(".lucide-leaf")).not.toBeNull();
    expect(panel.querySelector(".lucide-feather")).not.toBeNull();
    expect(panel.querySelector(".lucide-leaf")).not.toBeNull();
    expect(panel.querySelector(".lucide-zap")).not.toBeNull();
    expect(panel.querySelector(".lucide-gem")).not.toBeNull();
    expect(panel.querySelector(".lucide-brain")).not.toBeNull();

    expect(screen.getByRole("button", { name: /LiteQuick, minimal changes/ })).toHaveTextContent(
      "1 credit",
    );
    expect(
      screen.getByRole("button", { name: /EcoBalanced planning and clean typed code/ }),
    ).toHaveTextContent("2 credits");
    expect(
      screen.getByRole("button", { name: /PowerDeeper planning for production-ready work/ }),
    ).toHaveTextContent("5 credits");
    expect(
      screen.getByRole("button", { name: /ProDeepest planning with strict review/ }),
    ).toHaveTextContent("10 credits");
    expect(screen.getByText(/Eco 3 credits · Power 7 credits · Pro 13 credits/)).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", { name: /PowerDeeper planning for production-ready work/ }),
    );
    expect(onModeChange).toHaveBeenCalledWith("power");

    fireEvent.click(screen.getByTestId("deep-reasoning-toggle"));
    expect(onDeepReasoningChange).toHaveBeenCalledWith(true);
  });

  it("keeps Deep Reasoning disabled in Lite", () => {
    renderWithQueryClient(
      <BuilderModeControl
        mode="lite"
        deepReasoning={false}
        disabled={false}
        onModeChange={vi.fn()}
        onDeepReasoningChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("builder-mode-trigger"));
    expect(screen.getByTestId("deep-reasoning-toggle")).toBeDisabled();
  });

  it("keeps modes out of the plus menu and constrains the panel to the viewport", () => {
    const composer = readFileSync(
      resolve(process.cwd(), "src/pages/projects/components/queue-composer.tsx"),
      "utf8",
    );
    const control = readFileSync(
      resolve(process.cwd(), "src/pages/projects/components/builder-mode-control.tsx"),
      "utf8",
    );

    expect(composer).toContain("<BuilderModeControl");
    expect(composer).not.toContain("<DropdownMenuItem key={mode}");
    expect(control).toContain("max-w-[calc(100vw-2rem)]");
  });
});
