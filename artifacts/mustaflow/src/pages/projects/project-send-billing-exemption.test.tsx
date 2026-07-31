import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProjectWorkspacePage from "./[id]";

const testState = vi.hoisted(() => ({
  billing: {
    data: undefined as
      | {
          enforcementEnabled: boolean;
          exempt: boolean;
          canBuild: boolean;
          blockedReason: null;
          plan: { overageUsdPerCredit: number | null } | null;
          subscription: { currentCycleStart: string | null } | null;
          card: null;
          spendCap: null;
          cycle: { remainingIncludedCredits: number } | null;
        }
      | undefined,
    isLoading: false,
    isError: false,
  },
  sendMessageMutate: vi.fn(),
  cancelTaskMutate: vi.fn(),
  clearComposer: vi.fn(),
  tasks: [] as Array<Record<string, unknown>>,
  messages: [
    {
      id: 1,
      role: "user",
      content: "Existing project",
      plan: null,
      planMode: false,
      createdAt: "2026-07-30T00:00:00.000Z",
    },
  ] as Array<Record<string, unknown>>,
  eventSources: [] as Array<{
    url: string;
    onmessage: ((event: MessageEvent<string>) => void) | null;
    onerror: (() => void) | null;
    close: ReturnType<typeof vi.fn>;
  }>,
  queryClient: null as QueryClient | null,
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
  getListTaskEventsQueryKey: (projectId: number, taskId: number) => [
    "task-events",
    projectId,
    taskId,
  ],
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
  useCancelTask: (options?: {
    mutation?: {
      onSuccess?: (
        data: { id: number; status: string },
        variables: { id: number; taskId: number },
        context: unknown,
      ) => void;
    };
  }) => ({
    mutate: (variables: { id: number; taskId: number }) => {
      testState.cancelTaskMutate(variables);
      options?.mutation?.onSuccess?.(
        { id: variables.taskId, status: "canceled" },
        variables,
        undefined,
      );
    },
    isPending: false,
  }),
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
  useListMessages: () => ({ data: testState.messages }),
  useListProjectFiles: () => ({ data: [] }),
  useListSuggestions: () => ({ data: [] }),
  useListTaskEvents: () => ({ data: [] }),
  useListTasks: () => ({ data: testState.tasks }),
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
    disabled,
    promptValue,
  }: {
    agentMode: string;
    disabled?: boolean;
    promptValue?: string;
    onSingleSend: (
      content: string,
      intent: "build",
      attachments: undefined,
      brainstormContext: undefined,
      clearComposer: () => void,
    ) => void;
  }) => (
    <div>
      <output data-testid="composer-value">{promptValue ?? ""}</output>
      <button
        type="button"
        data-testid="real-send-path"
        data-agent-mode={agentMode}
        disabled={disabled}
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
    </div>
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
  testState.queryClient = queryClient;
  return render(
    <QueryClientProvider client={queryClient}>
      <ProjectWorkspacePage />
    </QueryClientProvider>,
  );
}

function installCapturedTaskEventSource() {
  testState.eventSources = [];
  vi.stubGlobal(
    "EventSource",
    class {
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onerror: (() => void) | null = null;
      close = vi.fn();

      constructor(public readonly url: string) {
        testState.eventSources.push(this);
      }
    },
  );
}

afterEach(() => {
  testState.tasks = [];
  testState.messages = [
    {
      id: 1,
      role: "user",
      content: "Existing project",
      plan: null,
      planMode: false,
      createdAt: "2026-07-30T00:00:00.000Z",
    },
  ];
  testState.eventSources = [];
  testState.queryClient = null;
});

async function sendPowerBuild() {
  const user = userEvent.setup();
  const send = await screen.findByTestId("real-send-path");
  await waitFor(() => expect(send).toHaveAttribute("data-agent-mode", "power"));
  await user.click(send);
}

describe("project send — no confirmation dialog", () => {
  beforeEach(() => {
    testState.sendMessageMutate.mockReset();
    testState.clearComposer.mockReset();
    testState.cancelTaskMutate.mockReset();
    testState.tasks = [];
    testState.messages = [
      {
        id: 1,
        role: "user",
        content: "Existing project",
        plan: null,
        planMode: false,
        createdAt: "2026-07-30T00:00:00.000Z",
      },
    ];
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

  it("submits an exempt Power build directly — no dialog, send proceeds", async () => {
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

    // No confirmation dialog for any user
    expect(screen.queryByRole("alertdialog", { name: /Confirm.*build/ })).not.toBeInTheDocument();
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

  it("submits a non-exempt Power build directly — dialog is gone, no gate for any user", async () => {
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

    // No alertdialog for non-exempt users either — dialog is removed
    expect(screen.queryByRole("alertdialog", { name: /Confirm.*build/ })).not.toBeInTheDocument();
    await waitFor(() => expect(testState.sendMessageMutate).toHaveBeenCalledTimes(1));
    expect(testState.clearComposer).toHaveBeenCalledTimes(1);
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
  ])(
    "sends immediately while billing state is %s — no blocking dialog",
    async (_label, billing) => {
      testState.billing = billing;
      renderPage();

      await sendPowerBuild();

      // Dialog is removed entirely — no gate for unknown billing state either
      expect(screen.queryByRole("alertdialog", { name: /Confirm.*build/ })).not.toBeInTheDocument();
      await waitFor(() => expect(testState.sendMessageMutate).toHaveBeenCalledTimes(1));
      expect(testState.clearComposer).toHaveBeenCalledTimes(1);
    },
  );
});

describe("project Stop with captured task 189 planning traffic", () => {
  beforeEach(() => {
    testState.cancelTaskMutate.mockReset();
    testState.tasks = [
      {
        id: 189,
        projectId: 47,
        kind: "plan",
        status: "planning",
        title: "Plan: Run 8 Activity Scratch B 2026-07-31",
        prompt: "Analyze this project idea and create a structured plan",
        createdAt: "2026-07-31T06:32:09.379Z",
      },
    ];
    testState.messages = [
      {
        id: 1890,
        role: "user",
        content: "Analyze this project idea and create a structured plan",
        plan: null,
        planMode: true,
        createdAt: "2026-07-31T06:32:09.379Z",
      },
    ];
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
    installCapturedTaskEventSource();
  });

  it("terminalizes locally after cancel and makes the captured user message editable again", async () => {
    const user = userEvent.setup();
    renderPage();

    const taskStream = await waitFor(() => {
      const stream = testState.eventSources.find((source) =>
        source.url.includes("/tasks/189/events/stream"),
      );
      expect(stream).toBeDefined();
      return stream!;
    });

    // Real production task 189 frames 7949-7951, captured before Stop.
    await act(async () => {
      for (const frame of [
        { id: 7949, taskId: 189, eventType: "queued", message: "Plan request received..." },
        {
          id: 7950,
          taskId: 189,
          eventType: "planning",
          message: "Analysing project and requirements...",
        },
        {
          id: 7951,
          taskId: 189,
          eventType: "generating_blueprint",
          message: "Generating structured plan with AI...",
        },
      ]) {
        taskStream.onmessage?.(
          new MessageEvent("message", {
            data: JSON.stringify(frame),
          }),
        );
      }
    });

    await user.click(await screen.findByRole("button", { name: "Stop" }));

    expect(testState.cancelTaskMutate).toHaveBeenCalledWith({ id: 47, taskId: 189 });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument(),
    );
    const edit = await screen.findByRole("button", { name: "Edit and resend this message" });
    await user.click(edit);
    expect(screen.getByTestId("composer-value")).toHaveTextContent(
      "Analyze this project idea and create a structured plan",
    );
    expect(screen.getByTestId("real-send-path")).toBeEnabled();
  });
});

describe("composer credit counter", () => {
  beforeEach(() => {
    testState.sendMessageMutate.mockReset();
    testState.clearComposer.mockReset();
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

  it("shows the composer credit counter in the send-bar area for all users", async () => {
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

    const counter = await screen.findByTestId("composer-credit-counter");
    expect(counter).toBeInTheDocument();
    // Project has agentMode: "power" → 160 credits
    expect(counter).toHaveTextContent(/Power/i);
    expect(counter).toHaveTextContent(/160\s*credits/);
  });

  it("shows remaining included credits when cycle data is available", async () => {
    testState.billing = {
      data: {
        enforcementEnabled: true,
        exempt: false,
        canBuild: true,
        blockedReason: null,
        plan: { overageUsdPerCredit: 0.012 },
        subscription: { currentCycleStart: "2026-07-01T00:00:00.000Z" },
        card: null,
        spendCap: null,
        cycle: { remainingIncludedCredits: 42 },
      },
      isLoading: false,
      isError: false,
    };
    renderPage();
    const counter = await screen.findByTestId("composer-credit-counter");
    expect(counter).toHaveTextContent(/42/);
    expect(counter).toHaveTextContent(/remaining/);
  });
});

describe("overage-crossing notice", () => {
  beforeEach(() => {
    testState.sendMessageMutate.mockReset();
    testState.clearComposer.mockReset();
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

  it("shows the overage notice when remainingIncludedCredits < modeCost for a non-exempt account", async () => {
    // Power mode costs 160 credits; remaining = 2 → would cross into overage
    testState.billing = {
      data: {
        enforcementEnabled: true,
        exempt: false,
        canBuild: true,
        blockedReason: null,
        plan: { overageUsdPerCredit: 0.012 },
        subscription: { currentCycleStart: "2026-07-01T00:00:00.000Z" },
        card: null,
        spendCap: null,
        cycle: { remainingIncludedCredits: 2 },
      },
      isLoading: false,
      isError: false,
    };
    renderPage();

    const notice = await screen.findByTestId("overage-crossing-notice");
    expect(notice).toBeInTheDocument();
    expect(notice).toHaveTextContent(/You've used your included credits/);
    expect(notice).toHaveTextContent(/\$0\.012\/credit/);
  });

  it("does NOT show the overage notice when remainingIncludedCredits >= modeCost", async () => {
    // Power mode costs 160 credits; remaining = 200 → still within included
    testState.billing = {
      data: {
        enforcementEnabled: true,
        exempt: false,
        canBuild: true,
        blockedReason: null,
        plan: { overageUsdPerCredit: 0.012 },
        subscription: { currentCycleStart: "2026-07-01T00:00:00.000Z" },
        card: null,
        spendCap: null,
        cycle: { remainingIncludedCredits: 200 },
      },
      isLoading: false,
      isError: false,
    };
    renderPage();

    await screen.findByTestId("composer-credit-counter");
    expect(screen.queryByTestId("overage-crossing-notice")).not.toBeInTheDocument();
  });

  it("does NOT show the overage notice for an exempt account", async () => {
    testState.billing = {
      data: {
        enforcementEnabled: true,
        exempt: true,
        canBuild: true,
        blockedReason: null,
        plan: { overageUsdPerCredit: 0.012 },
        subscription: { currentCycleStart: "2026-07-01T00:00:00.000Z" },
        card: null,
        spendCap: null,
        cycle: { remainingIncludedCredits: 2 },
      },
      isLoading: false,
      isError: false,
    };
    renderPage();

    await screen.findByTestId("composer-credit-counter");
    expect(screen.queryByTestId("overage-crossing-notice")).not.toBeInTheDocument();
  });

  it("dismissing the notice hides it and persists the ack to localStorage", async () => {
    testState.billing = {
      data: {
        enforcementEnabled: true,
        exempt: false,
        canBuild: true,
        blockedReason: null,
        plan: { overageUsdPerCredit: 0.012 },
        subscription: { currentCycleStart: "2026-07-01T00:00:00.000Z" },
        card: null,
        spendCap: null,
        cycle: { remainingIncludedCredits: 2 },
      },
      isLoading: false,
      isError: false,
    };
    const user = userEvent.setup();
    renderPage();

    await screen.findByTestId("overage-crossing-notice");
    await user.click(screen.getByTestId("overage-notice-continue"));

    await waitFor(() =>
      expect(screen.queryByTestId("overage-crossing-notice")).not.toBeInTheDocument(),
    );
    // Ack is persisted so it won't re-appear after a refresh
    expect(localStorage.getItem("nabuflow_overage_ack_2026-07-01")).toBe("1");
  });

  it("don't-show-again suppresses the notice for the rest of the cycle", async () => {
    testState.billing = {
      data: {
        enforcementEnabled: true,
        exempt: false,
        canBuild: true,
        blockedReason: null,
        plan: { overageUsdPerCredit: 0.012 },
        subscription: { currentCycleStart: "2026-07-01T00:00:00.000Z" },
        card: null,
        spendCap: null,
        cycle: { remainingIncludedCredits: 2 },
      },
      isLoading: false,
      isError: false,
    };
    const user = userEvent.setup();
    renderPage();

    await screen.findByTestId("overage-crossing-notice");
    await user.click(screen.getByTestId("overage-notice-dont-show"));

    await waitFor(() =>
      expect(screen.queryByTestId("overage-crossing-notice")).not.toBeInTheDocument(),
    );
    expect(localStorage.getItem("nabuflow_overage_ack_2026-07-01")).toBe("1");
  });

  it("build proceeds immediately even when the overage notice is visible — notice never blocks", async () => {
    testState.billing = {
      data: {
        enforcementEnabled: true,
        exempt: false,
        canBuild: true,
        blockedReason: null,
        plan: { overageUsdPerCredit: 0.012 },
        subscription: { currentCycleStart: "2026-07-01T00:00:00.000Z" },
        card: null,
        spendCap: null,
        cycle: { remainingIncludedCredits: 2 },
      },
      isLoading: false,
      isError: false,
    };
    renderPage();

    await screen.findByTestId("overage-crossing-notice");
    // Send without dismissing the notice first
    await sendPowerBuild();

    await waitFor(() => expect(testState.sendMessageMutate).toHaveBeenCalledTimes(1));
    expect(testState.clearComposer).toHaveBeenCalledTimes(1);
  });

  it("notice re-appears after a billing cycle rollover even if it was dismissed in the previous cycle", async () => {
    // Simulate: user dismissed the notice in the July cycle
    localStorage.setItem("nabuflow_overage_ack_2026-07-01", "1");

    // New cycle (August) — no ack for this key
    testState.billing = {
      data: {
        enforcementEnabled: true,
        exempt: false,
        canBuild: true,
        blockedReason: null,
        plan: { overageUsdPerCredit: 0.012 },
        subscription: { currentCycleStart: "2026-08-01T00:00:00.000Z" },
        card: null,
        spendCap: null,
        cycle: { remainingIncludedCredits: 2 },
      },
      isLoading: false,
      isError: false,
    };
    renderPage();

    // The notice must fire again because the new cycle key has no ack
    await screen.findByTestId("overage-crossing-notice");
    // Old cycle's ack is still in storage and was not incorrectly applied
    expect(localStorage.getItem("nabuflow_overage_ack_2026-08-01")).toBeNull();
  });

  it("notice stays hidden when cycle rolls over and the new cycle already has an ack", async () => {
    // Both old and new cycle acks present
    localStorage.setItem("nabuflow_overage_ack_2026-07-01", "1");
    localStorage.setItem("nabuflow_overage_ack_2026-08-01", "1");

    testState.billing = {
      data: {
        enforcementEnabled: true,
        exempt: false,
        canBuild: true,
        blockedReason: null,
        plan: { overageUsdPerCredit: 0.012 },
        subscription: { currentCycleStart: "2026-08-01T00:00:00.000Z" },
        card: null,
        spendCap: null,
        cycle: { remainingIncludedCredits: 2 },
      },
      isLoading: false,
      isError: false,
    };
    renderPage();

    // Already acked for this cycle — should remain hidden
    await waitFor(() =>
      expect(screen.queryByTestId("overage-crossing-notice")).not.toBeInTheDocument(),
    );
  });
});
