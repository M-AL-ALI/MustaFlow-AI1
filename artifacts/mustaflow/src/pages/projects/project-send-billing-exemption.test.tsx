import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProjectWorkspacePage from "./[id]";

const testState = vi.hoisted(() => ({
  billing: {
    data: undefined as
      | {
          enforcementEnabled: boolean;
          exempt: boolean;
          canBuild: boolean;
          blockedReason: null;
          plan: null;
          subscription: null;
          card: null;
          spendCap: null;
          cycle: null;
        }
      | undefined,
    isLoading: false,
    isError: false,
  },
  sendMessageMutate: vi.fn(),
  clearComposer: vi.fn(),
}));

vi.mock("wouter", () => ({
  useParams: () => ({ id: "47" }),
  useLocation: () => ["/projects/47", vi.fn()],
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@workspace/api-client-react", () => ({
  getGetCveScanStatusQueryKey: () => ["cve-status"],
  getGetMyPreferencesQueryKey: () => ["preferences"],
  getGetNabuflowBillingStateQueryKey: () => ["nabuflow-billing-state"],
  getGetPageMapQueryKey: (projectId: number) => ["page-map", projectId],
  getGetProjectQueryKey: (projectId: number) => ["project", projectId],
  getGetUserCreditsQueryKey: () => ["credits"],
  getListMessagesQueryKey: (projectId: number) => ["messages", projectId],
  getListProjectFilesQueryKey: (projectId: number) => ["files", projectId],
  getListSuggestionsQueryKey: (projectId: number) => ["suggestions", projectId],
  getListTasksQueryKey: (projectId: number) => ["tasks", projectId],
  getListVersionsQueryKey: (projectId: number) => ["versions", projectId],
  getAuthToken: vi.fn().mockResolvedValue(null),
  getBillingSubscription: vi.fn().mockResolvedValue({ tier: "core" }),
  getContainerStatus: vi.fn().mockResolvedValue({ status: "stopped" }),
  getProjectProvisioningStatus: vi.fn().mockResolvedValue({ status: "idle" }),
  listVersions: vi.fn().mockResolvedValue([]),
  resumePausedQueue: vi.fn().mockResolvedValue({ resumed: 0 }),
  retryProjectProvisioning: vi.fn().mockResolvedValue(undefined),
  startContainer: vi.fn().mockResolvedValue(undefined),
  stopContainer: vi.fn().mockResolvedValue(undefined),
  submitProjectQueue: vi.fn().mockResolvedValue(undefined),
  useAcknowledgeCveScan: () => ({ mutate: vi.fn() }),
  useCancelTask: () => ({ mutate: vi.fn(), isPending: false }),
  useGetCveScanStatus: () => ({ data: undefined }),
  useGetMyPreferences: () => ({
    data: { dismissedOnboarding: true, containerLayerConfigured: false },
  }),
  useGetNabuflowBillingState: () => testState.billing,
  useGetProject: () => ({
    data: {
      id: 47,
      name: "Run 8 recovery scratch",
      status: "ready",
      agentMode: "power",
      builderMode: "static",
      projectFormat: "static",
      kind: "web",
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useGetUserCredits: () => ({ data: { balance: 1600 }, isLoading: false }),
  useListMessages: () => ({
    data: [
      {
        id: 1,
        role: "user",
        content: "Existing project",
        plan: null,
        planMode: false,
        createdAt: "2026-07-30T00:00:00.000Z",
      },
    ],
  }),
  useListProjectFiles: () => ({ data: [] }),
  useListSuggestions: () => ({ data: [] }),
  useListTasks: () => ({ data: [] }),
  useRollbackVersion: () => ({ mutate: vi.fn(), isPending: false }),
  useSendMessage: () => ({ mutate: testState.sendMessageMutate, isPending: false }),
  useUpdateMyPreferences: () => ({ mutate: vi.fn() }),
  useUpdateProject: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
}));

vi.mock("@/hooks/use-web-container", () => ({
  useWebContainer: () => ({}),
}));

vi.mock("@/hooks/use-project-issues", () => ({
  useProjectIssues: () => ({
    totalCount: 0,
    hasFailedBuild: false,
    hasContainerError: false,
    hasCodeQuality: false,
  }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/lib/builder-lazy", () => ({
  builderLazy: () => () => null,
}));

vi.mock("./components/queue-composer", () => ({
  QueueComposer: ({
    agentMode,
    onSingleSend,
  }: {
    agentMode: string;
    onSingleSend: (
      content: string,
      intent: "build",
      attachments: undefined,
      brainstormContext: undefined,
      clearComposer: () => void,
    ) => void;
  }) => (
    <button
      type="button"
      data-testid="real-send-path"
      data-agent-mode={agentMode}
      onClick={() =>
        onSingleSend(
          "Migrate the shared status API across the project",
          "build",
          undefined,
          undefined,
          testState.clearComposer,
        )
      }
    >
      Send Power build
    </button>
  ),
}));

vi.mock("./components/preview-tab", () => ({
  PreviewTab: () => null,
}));

vi.mock("./components/workspace-tour", () => ({
  WorkspaceTour: () => null,
  useCompleteWorkspaceTourOnBuild: () => undefined,
}));

vi.mock("./components/use-project-images", () => ({
  useProjectImages: () => ({
    images: [],
    loading: false,
    isGenerating: false,
    error: null,
    generateImage: vi.fn(),
    regenerateImage: vi.fn(),
    insertIntoProject: vi.fn(),
    hasMoreHistory: false,
    loadMoreHistory: vi.fn(),
  }),
}));

vi.mock("./components/use-cve-critical-high-count", () => ({
  useCveCriticalHighCount: () => 0,
}));

vi.mock("@/components/credit-balance-pill", () => ({
  CreditBalancePill: () => null,
}));

vi.mock("@/components/notifications-bell", () => ({
  NotificationsBell: () => null,
}));

vi.mock("@/components/buy-credits-sheet", () => ({
  BuyCreditsSheet: () => null,
  CreditsSuccessBanner: () => null,
}));

vi.mock("@/components/agentic-onboarding-tooltip", () => ({
  AgenticOnboardingTooltip: () => null,
}));

vi.mock("./components/getting-started-checklist", () => ({
  GettingStartedChecklist: () => null,
}));

vi.mock("./components/memory-indicator", () => ({
  MemoryIndicator: () => null,
}));

vi.mock("./components/brand-pill", () => ({
  BrandPill: () => null,
}));

vi.mock("./components/connection-quality-indicator", () => ({
  ConnectionQualityIndicator: () => null,
}));

vi.mock("./components/provisioning-progress", () => ({
  ProvisioningProgress: () => null,
}));

vi.mock("./components/queue-progress-strip", () => ({
  QueueProgressStrip: () => null,
}));

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ProjectWorkspacePage />
    </QueryClientProvider>,
  );
}

async function sendPowerBuild() {
  const user = userEvent.setup();
  const send = await screen.findByTestId("real-send-path");
  await waitFor(() => expect(send).toHaveAttribute("data-agent-mode", "power"));
  await user.click(send);
}

describe("project send billing exemption", () => {
  beforeEach(() => {
    testState.sendMessageMutate.mockReset();
    testState.clearComposer.mockReset();
    testState.billing = {
      data: undefined,
      isLoading: false,
      isError: false,
    };
    localStorage.clear();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        media: "",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    });
    vi.stubGlobal(
      "EventSource",
      class {
        onmessage: ((event: MessageEvent<string>) => void) | null = null;
        onerror: (() => void) | null = null;
        close() {}
      },
    );
  });

  it("submits an exempt Power build directly through the real page send path", async () => {
    testState.billing = {
      data: {
        enforcementEnabled: true,
        exempt: true,
        canBuild: true,
        blockedReason: null,
        plan: null,
        subscription: null,
        card: null,
        spendCap: null,
        cycle: null,
      },
      isLoading: false,
      isError: false,
    };
    renderPage();

    await sendPowerBuild();

    expect(
      screen.queryByRole("alertdialog", { name: "Confirm Power build" }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(testState.sendMessageMutate).toHaveBeenCalledTimes(1));
    expect(testState.sendMessageMutate.mock.calls[0]?.[0]).toMatchObject({
      id: 47,
      data: {
        content: "Migrate the shared status API across the project",
        agentMode: "power",
        agentIntent: "build",
      },
    });
    expect(testState.clearComposer).toHaveBeenCalledTimes(1);
  });

  it("keeps the Power confirmation gate unchanged for a non-exempt account", async () => {
    testState.billing = {
      data: {
        enforcementEnabled: true,
        exempt: false,
        canBuild: true,
        blockedReason: null,
        plan: null,
        subscription: null,
        card: null,
        spendCap: null,
        cycle: null,
      },
      isLoading: false,
      isError: false,
    };
    renderPage();

    await sendPowerBuild();

    expect(screen.getByRole("alertdialog", { name: "Confirm Power build" })).toBeVisible();
    expect(testState.sendMessageMutate).not.toHaveBeenCalled();
    expect(testState.clearComposer).not.toHaveBeenCalled();
  });

  it.each([
    ["absent", { data: undefined, isLoading: false, isError: false }],
    [
      "loading",
      {
        data: {
          enforcementEnabled: true,
          exempt: true,
          canBuild: true,
          blockedReason: null,
          plan: null,
          subscription: null,
          card: null,
          spendCap: null,
          cycle: null,
        },
        isLoading: true,
        isError: false,
      },
    ],
    [
      "errored",
      {
        data: {
          enforcementEnabled: true,
          exempt: true,
          canBuild: true,
          blockedReason: null,
          plan: null,
          subscription: null,
          card: null,
          spendCap: null,
          cycle: null,
        },
        isLoading: false,
        isError: true,
      },
    ],
  ])("fails closed while billing state is %s", async (_label, billing) => {
    testState.billing = billing;
    renderPage();

    await sendPowerBuild();

    expect(screen.getByRole("alertdialog", { name: "Confirm Power build" })).toBeVisible();
    expect(testState.sendMessageMutate).not.toHaveBeenCalled();
    expect(testState.clearComposer).not.toHaveBeenCalled();
  });
});
