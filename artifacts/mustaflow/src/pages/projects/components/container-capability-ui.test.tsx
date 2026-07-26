import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DebuggerPanel } from "./debugger-panel";
import { RuntimeTab } from "./runtime-tab";
import { TerminalTab } from "./terminal-tab";

describe("Builder live-server capability gate", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders inert empty states without container network calls when unavailable", () => {
    const fetchMock = vi.fn();
    const webSocketMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", webSocketMock);

    const { unmount: unmountTerminal } = render(
      <TerminalTab
        projectId={28}
        containerStatus="stopped"
        containerUrl={null}
        onStartContainer={vi.fn()}
        onStopContainer={vi.fn()}
        isStarting={false}
        containerLayerConfigured={false}
      />,
    );
    expect(screen.getByText("Needs a live server")).toBeInTheDocument();
    unmountTerminal();

    const { unmount: unmountRuntime } = render(
      <RuntimeTab projectId={28} containerLayerConfigured={false} />,
    );
    expect(screen.getByText("Needs a live server")).toBeInTheDocument();
    unmountRuntime();

    render(
      <DebuggerPanel projectId={28} containerStatus="stopped" containerLayerConfigured={false} />,
    );
    expect(screen.getByText("Needs a live server")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(webSocketMock).not.toHaveBeenCalled();
  });
});
