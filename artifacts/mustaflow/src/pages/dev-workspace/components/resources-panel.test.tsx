import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authFetch } from "@/lib/api-fetch";
import { ResourcesPanel } from "./resources-panel";

vi.mock("@/lib/api-fetch", () => ({ authFetch: vi.fn() }));

describe("ResourcesPanel telemetry honesty", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("states when live measurements are unavailable instead of showing invented numbers", async () => {
    (authFetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          metricsAvailable: false,
          reason: "provider_metrics_unavailable",
          cpuPercent: null,
          ramMb: null,
          ramLimitMb: null,
          diskMb: null,
          diskLimitMb: null,
          status: "running",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    render(<ResourcesPanel projectId={52} containerStatus="running" />);

    expect(
      await screen.findByText(
        "Live CPU, memory, and disk measurements aren't available for this runtime yet.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Live — updates every 5 seconds")).not.toBeInTheDocument();
    expect(screen.queryByText("CPU")).not.toBeInTheDocument();
  });
});
