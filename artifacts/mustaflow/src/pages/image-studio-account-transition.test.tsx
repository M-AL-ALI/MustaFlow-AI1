import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authFetch, uploadAccountAsset, auth } = vi.hoisted(() => ({
  authFetch: vi.fn(),
  uploadAccountAsset: vi.fn(),
  auth: {
    isLoaded: true,
    isSignedIn: true,
    user: { id: "account-a" } as { id: string } | null,
  },
}));
vi.mock("@/lib/api-fetch", () => ({ authFetch }));
vi.mock("@/lib/clerk-safe", () => ({ useClerkUser: () => auth }));
vi.mock("@/lib/asset-upload", () => ({
  formatAssetBytes: (bytes: number) => `${bytes} bytes`,
  uploadAccountAsset,
}));

import ImageStudioPage from "./image-studio";

const pagePaths = [
  "/api/projects",
  "/api/images?limit=40",
  "/api/assets?limit=100",
  "/api/assets/storage-plans",
  "/api/assets/analysis-usage",
];
const projectPath = "/api/images?projectId=4101&limit=50";
const materializePath = "/api/projects/4101/assets/1901/materialize";

function imageFor(owner: string) {
  return {
    id: 901,
    assetId: 1901,
    prompt: `${owner} image`,
    quality: "standard",
    aspectRatio: "1:1",
    status: "completed",
    fileUrl: "/api/assets/1901/content",
    creditCost: 3,
    createdAt: "2026-09-08T00:00:00Z",
  };
}

// Deliberately reuse numeric IDs across accounts: local identity must come
// from the auth boundary, never from a project or asset ID.
function bodyFor(owner: string, url: string): unknown {
  const asset = {
    id: 1901,
    kind: "image",
    source: "upload",
    filename: `${owner}.png`,
    mimeType: "image/png",
    sizeBytes: 12,
    scanState: "not-required",
    contentUrl: "/api/assets/1901/content",
    context: { altText: `${owner} saved alt`, brandRole: "none" },
    createdAt: "2026-09-08T00:00:00Z",
  };
  const bodies: Record<string, unknown> = {
    "/api/projects": [{ id: 4101, name: `${owner} project` }],
    "/api/images?limit=40": { images: [imageFor(owner)] },
    "/api/assets?limit=100": {
      assets: [asset, { ...asset, id: 1902, filename: `${owner}-replacement.png` }],
    },
    "/api/assets/storage-plans": {
      quota: { usedBytes: owner === "account-a" ? 101 : 202, reservedBytes: 0, limitBytes: 1000 },
      plans: [{ sku: "extra", label: "Extra storage", allowanceBytes: 5000, monthlyCents: 100 }],
    },
    "/api/assets/analysis-usage": {
      total: { count: owner === "account-a" ? 7 : 9, estimatedProviderCostMicros: 0 },
    },
    [projectPath]: { images: [{ ...imageFor(owner), prompt: `${owner} collection image` }] },
    "/api/assets/1901/usage": {
      usages: [
        { id: 1, projectId: 4101, versionId: 1, filePath: "/public/logo.png", consumer: "app" },
      ],
    },
  };
  if (!(url in bodies)) throw new Error(`Unexpected mocked request: ${url}`);
  return bodies[url];
}

function reply(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const defaultRequest = (url: string) => Promise.resolve(reply(bodyFor(auth.user!.id, url)));

function mutations() {
  return authFetch.mock.calls.filter(([, init]) => init?.method && init.method !== "GET");
}

async function mountPage() {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<ImageStudioPage />);
  });
  return view;
}

async function switchAccount(view: ReturnType<typeof render>, id: string) {
  auth.isLoaded = true;
  auth.isSignedIn = true;
  auth.user = { id };
  await act(async () => {
    view.rerender(<ImageStudioPage />);
  });
}

async function selectCollection() {
  await act(async () => {
    fireEvent.change(screen.getByRole("combobox", { name: "Collection" }), {
      target: { value: "4101" },
    });
  });
}

function openReuse() {
  fireEvent.click(screen.getByRole("button", { name: "Use in project" }));
  return within(screen.getByRole("dialog", { name: "Use in a project" }));
}

function chooseDestination() {
  fireEvent.change(screen.getByRole("combobox", { name: "Project for asset" }), {
    target: { value: "4101" },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(auth, { isLoaded: true, isSignedIn: true, user: { id: "account-a" } });
  authFetch.mockReset();
  authFetch.mockImplementation(defaultRequest);
  uploadAccountAsset.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Image Studio account lifetime", () => {
  it("retains same-user drafts while browsing, then clears all cached state before the next account loads", async () => {
    const view = await mountPage();
    const prompt = screen.getByPlaceholderText(/Describe the image you want to generate/);
    fireEvent.change(prompt, { target: { value: "Unfinished account-a prompt" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Alt text for account-a.png" }), {
      target: { value: "Unfinished account-a alt text" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Brand role for account-a.png" }), {
      target: { value: "logo" },
    });
    await selectCollection();
    const beforeSameUser = authFetch.mock.calls.length;
    await switchAccount(view, "account-a");
    expect(authFetch).toHaveBeenCalledTimes(beforeSameUser);
    expect(screen.getByRole("combobox", { name: "Collection" })).toHaveValue("4101");
    expect(prompt).toHaveValue("Unfinished account-a prompt");
    expect(screen.getByRole("img", { name: "account-a collection image" })).toBeVisible();

    const pending = new Map(pagePaths.map((path) => [path, deferred<Response>()]));
    authFetch.mockImplementation((url: string) => pending.get(url)!.promise);
    await switchAccount(view, "account-b");
    expect(screen.getByRole("combobox", { name: "Collection" })).toHaveValue("account");
    expect(screen.getByPlaceholderText(/Describe the image you want to generate/)).toHaveValue("");
    expect(screen.queryByDisplayValue("Unfinished account-a alt text")).not.toBeInTheDocument();
    expect(screen.queryByText("account-a.png")).not.toBeInTheDocument();
    expect(screen.queryByText("account-a image")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("img", { name: "account-a collection image" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "account-a project (#4101)" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("asset-quota-panel")).not.toHaveTextContent("101 bytes used");
    expect(screen.queryByText(/7 analyses/)).not.toBeInTheDocument();
    expect(screen.getByText("Loading project collections...")).toBeVisible();
    expect(screen.getByText("Loading private asset library...")).toBeVisible();

    await act(async () => {
      for (const [path, request] of pending) request.resolve(reply(bodyFor("account-b", path)));
    });
    expect(screen.getByRole("img", { name: "account-b image" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Alt text for account-b.png" })).toHaveValue(
      "account-b saved alt",
    );
    expect(screen.getByRole("combobox", { name: "Brand role for account-b.png" })).toHaveValue(
      "none",
    );
    expect(screen.getByTestId("asset-quota-panel")).toHaveTextContent(
      "202 bytes used of 1000 bytes",
    );
    expect(screen.getByText(/9 analyses/)).toBeVisible();
    expect(mutations()).toEqual([]);
  });

  it.each(["signed-out", "loading"] as const)(
    "unmounts drafts and reuse intent while %s, including a return to the same user",
    async (state) => {
      const view = await mountPage();
      fireEvent.change(screen.getByPlaceholderText(/Describe the image you want to generate/), {
        target: { value: "Discard this prompt" },
      });
      openReuse();
      chooseDestination();
      const before = authFetch.mock.calls.length;
      if (state === "signed-out") Object.assign(auth, { isSignedIn: false, user: null });
      else auth.isLoaded = false;
      await act(async () => {
        view.rerender(<ImageStudioPage />);
      });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.queryByRole("combobox", { name: "Collection" })).not.toBeInTheDocument();
      expect(authFetch).toHaveBeenCalledTimes(before);

      await switchAccount(view, "account-a");
      expect(screen.getByPlaceholderText(/Describe the image you want to generate/)).toHaveValue(
        "",
      );
      const dialog = openReuse();
      expect(dialog.getByRole("combobox")).toHaveValue("");
      expect(dialog.getByRole("button", { name: "Add to project" })).toBeDisabled();
      expect(mutations()).toEqual([]);
    },
  );

  it.each(["response", "body", "network", "body-failure"] as const)(
    "ignores obsolete project, image, asset and meter loads at the %s boundary",
    async (boundary) => {
      const responses = new Map(pagePaths.map((path) => [path, deferred<Response>()]));
      const bodies = new Map(pagePaths.map((path) => [path, deferred<unknown>()]));
      authFetch.mockImplementation((url: string) => {
        if (auth.user?.id !== "account-a") return defaultRequest(url);
        return boundary.startsWith("body")
          ? Promise.resolve({ ...reply(null), json: () => bodies.get(url)!.promise })
          : responses.get(url)!.promise;
      });
      const view = await mountPage();
      const oldSignals = authFetch.mock.calls.map(([, init]) => init.signal as AbortSignal);
      await switchAccount(view, "account-b");
      const afterSwitch = authFetch.mock.calls.length;
      expect(oldSignals.every((signal) => signal.aborted)).toBe(true);
      await act(async () => {
        for (const path of pagePaths) {
          if (boundary === "network") responses.get(path)!.reject(new Error("Old request failed"));
          else if (boundary === "body-failure")
            bodies.get(path)!.reject(new Error("Old body failed"));
          else if (boundary === "body") bodies.get(path)!.resolve(bodyFor("account-a", path));
          else responses.get(path)!.resolve(reply(bodyFor("account-a", path)));
        }
      });
      expect(authFetch).toHaveBeenCalledTimes(afterSwitch);
      expect(screen.getByRole("img", { name: "account-b image" })).toBeVisible();
      expect(screen.getByRole("option", { name: "account-b project (#4101)" })).toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "Alt text for account-b.png" })).toHaveValue(
        "account-b saved alt",
      );
      expect(screen.queryByText("account-a.png")).not.toBeInTheDocument();
      expect(screen.queryByRole("option", { name: /account-a project/ })).not.toBeInTheDocument();
      expect(screen.getByTestId("asset-quota-panel")).toHaveTextContent(
        "202 bytes used of 1000 bytes",
      );
      expect(screen.getByText(/9 analyses/)).toBeVisible();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(mutations()).toEqual([]);
    },
  );

  it.each(["success", "failure"] as const)(
    "fences a previous account's late collection %s even when project IDs match",
    async (outcome) => {
      const old = deferred<Response>();
      authFetch.mockImplementation((url: string) =>
        auth.user?.id === "account-a" && url === projectPath ? old.promise : defaultRequest(url),
      );
      const view = await mountPage();
      await selectCollection();
      await switchAccount(view, "account-b");
      expect(screen.getByRole("combobox", { name: "Collection" })).toHaveValue("account");
      await selectCollection();
      const afterSwitch = authFetch.mock.calls.length;
      await act(async () => {
        if (outcome === "success") old.resolve(reply(bodyFor("account-a", projectPath)));
        else old.reject(new Error("Old collection failure"));
      });
      expect(screen.getByRole("img", { name: "account-b collection image" })).toBeVisible();
      expect(
        screen.queryByRole("img", { name: "account-a collection image" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(authFetch).toHaveBeenCalledTimes(afterSwitch);
      expect(mutations()).toEqual([]);
    },
  );

  it("does not revive a prior account lifetime after switching A to B to A", async () => {
    const old = deferred<Response>();
    let first = true;
    authFetch.mockImplementation((url: string) => {
      if (first && url === "/api/images?limit=40") {
        first = false;
        return old.promise;
      }
      return defaultRequest(url);
    });
    const view = await mountPage();
    await switchAccount(view, "account-b");
    await switchAccount(view, "account-a");
    const afterReturn = authFetch.mock.calls.length;
    await act(async () => {
      old.resolve(
        reply({ images: [{ ...imageFor("account-a"), prompt: "Abandoned first visit" }] }),
      );
    });
    expect(screen.getByRole("img", { name: "account-a image" })).toBeVisible();
    expect(screen.queryByText("Abandoned first visit")).not.toBeInTheDocument();
    expect(authFetch).toHaveBeenCalledTimes(afterReturn);
  });

  it("keeps discarded StrictMode requests fenced when the same user effect activates again", async () => {
    const firstRequests = new Map<string, ReturnType<typeof deferred<Response>>>();
    authFetch.mockImplementation((url: string) => {
      if (!firstRequests.has(url)) {
        const request = deferred<Response>();
        firstRequests.set(url, request);
        return request.promise;
      }
      return defaultRequest(url);
    });
    await act(async () => {
      render(
        <StrictMode>
          <ImageStudioPage />
        </StrictMode>,
      );
    });
    expect(screen.getByRole("img", { name: "account-a image" })).toBeVisible();
    await act(async () => {
      for (const request of firstRequests.values()) request.reject(new Error("Discarded effect"));
    });
    expect(screen.getByRole("img", { name: "account-a image" })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("continues one account generation while browsing a collection for the same user", async () => {
    let finished = false;
    authFetch.mockImplementation((url: string) => {
      if (url === "/api/images/generate")
        return Promise.resolve(reply({ jobId: "current-job", imageId: 902, status: "pending" }));
      if (url === "/api/images/status/current-job") {
        finished = true;
        return Promise.resolve(reply({ jobId: "current-job", imageId: 902, status: "completed" }));
      }
      if (url === "/api/images?limit=40" && finished)
        return Promise.resolve(
          reply({
            images: [{ ...imageFor("account-a"), id: 902, prompt: "Finished current generation" }],
          }),
        );
      return defaultRequest(url);
    });
    const view = await mountPage();
    fireEvent.change(screen.getByPlaceholderText(/Describe the image you want to generate/), {
      target: { value: "Keep this account generation" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    });
    await selectCollection();
    await switchAccount(view, "account-a");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Collection" }), {
      target: { value: "account" },
    });
    expect(screen.getByRole("img", { name: "Finished current generation" })).toBeVisible();
    expect(screen.getByPlaceholderText(/Describe the image you want to generate/)).toHaveValue(
      "Keep this account generation",
    );
    expect(mutations()).toHaveLength(1);
    expect(mutations()[0][0]).toBe("/api/images/generate");
    expect(JSON.parse(mutations()[0][1].body)).toEqual({
      prompt: "Keep this account generation",
      quality: "standard",
      aspectRatio: "1:1",
      style: "vivid",
      purpose: "general",
      transparentBackground: false,
      variationCount: 1,
    });
  });
});

describe("Image Studio obsolete actions", () => {
  it.each(["success", "http", "network"] as const)(
    "discards a late reuse %s without closing or unlocking the new account's pending confirmation",
    async (outcome) => {
      const old = deferred<Response>();
      const current = deferred<Response>();
      authFetch.mockImplementation((url: string) =>
        url === materializePath
          ? auth.user?.id === "account-a"
            ? old.promise
            : current.promise
          : defaultRequest(url),
      );
      const view = await mountPage();
      openReuse();
      chooseDestination();
      fireEvent.click(screen.getByRole("button", { name: "Add to project" }));
      expect(mutations()).toHaveLength(1);
      const oldSignal = mutations()[0][1].signal as AbortSignal;
      expect(mutations()[0][0]).toBe(materializePath);
      expect(JSON.parse(mutations()[0][1].body)).toEqual({});

      await switchAccount(view, "account-b");
      expect(oldSignal.aborted).toBe(true);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      const dialog = openReuse();
      expect(dialog.getByRole("combobox")).toHaveValue("");
      expect(dialog.getByRole("button", { name: "Add to project" })).toBeDisabled();
      chooseDestination();
      fireEvent.click(dialog.getByRole("button", { name: "Add to project" }));
      const afterNewConfirmation = authFetch.mock.calls.length;

      await act(async () => {
        if (outcome === "network") old.reject(new Error("Old reuse failure"));
        else
          old.resolve(
            reply(
              outcome === "http" ? { error: "Old reuse denied" } : { src: "/old-only.png" },
              outcome === "http" ? 403 : 200,
            ),
          );
      });
      expect(authFetch).toHaveBeenCalledTimes(afterNewConfirmation);
      expect(screen.getByRole("dialog")).toBeVisible();
      expect(dialog.getByRole("combobox")).toHaveValue("4101");
      expect(dialog.getByRole("button", { name: "Adding..." })).toBeDisabled();
      expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
      expect(dialog.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByText(/old-only/)).not.toBeInTheDocument();
      expect(mutations()).toHaveLength(2);

      await act(async () => {
        current.resolve(reply({ src: "/current-only.png" }));
      });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByText(/current-only/)).toBeVisible();
      expect(authFetch).toHaveBeenCalledTimes(afterNewConfirmation + 3);
      expect(mutations()).toHaveLength(2);
    },
  );

  describe.each(["generate", "edit"] as const)("%s", (operation) => {
    it.each(["success", "failure"] as const)(
      "does not adopt late %s jobs or errors in the next account",
      async (outcome) => {
        const old = deferred<Response>();
        const path = operation === "generate" ? "/api/images/generate" : "/api/images/901/edit";
        authFetch.mockImplementation((url: string) =>
          url === path ? old.promise : defaultRequest(url),
        );
        const view = await mountPage();
        if (operation === "generate") {
          fireEvent.change(screen.getByPlaceholderText(/Describe the image you want to generate/), {
            target: { value: "Old generation intent" },
          });
          fireEvent.click(screen.getByRole("button", { name: "Generate" }));
        } else {
          fireEvent.click(screen.getByRole("button", { name: "Edit with AI" }));
          fireEvent.change(screen.getByPlaceholderText(/Describe what you want to change/), {
            target: { value: "Old edit intent" },
          });
          fireEvent.click(screen.getByRole("button", { name: "Apply edit" }));
        }
        expect(mutations()).toHaveLength(1);
        expect(JSON.parse(mutations()[0][1].body)).not.toHaveProperty("projectId");
        const signal = mutations()[0][1].signal as AbortSignal;
        await switchAccount(view, "account-b");
        expect(signal.aborted).toBe(true);
        const prompt = screen.getByPlaceholderText(/Describe the image you want to generate/);
        fireEvent.change(prompt, { target: { value: "New account draft" } });
        const afterSwitch = authFetch.mock.calls.length;
        await act(async () => {
          if (outcome === "failure") old.reject(new Error("Old generation failure"));
          else
            old.resolve(
              reply({ jobId: "old-job", imageId: 902, creditCost: 3, status: "pending" }),
            );
          await vi.advanceTimersByTimeAsync(6000);
        });
        expect(authFetch).toHaveBeenCalledTimes(afterSwitch);
        expect(prompt).toHaveValue("New account draft");
        expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled();
        expect(
          screen.queryByPlaceholderText(/Describe what you want to change/),
        ).not.toBeInTheDocument();
        expect(screen.queryByText(/Queued/)).not.toBeInTheDocument();
        expect(screen.queryByText(/Old generation failure/)).not.toBeInTheDocument();
        expect(screen.getByRole("img", { name: "account-b image" })).toBeVisible();
        expect(mutations()).toHaveLength(1);
      },
    );
  });

  it.each(["completed", "failed", "http", "network"] as const)(
    "stops an old polling batch after a late %s result without refreshing or requesting its next job",
    async (outcome) => {
      const old = deferred<Response>();
      authFetch.mockImplementation((url: string) => {
        if (url === "/api/images/generate")
          return Promise.resolve(
            reply({ jobIds: ["old-job-1", "old-job-2"], imageIds: [902, 903], status: "pending" }),
          );
        if (url === "/api/images/status/old-job-1") return old.promise;
        return defaultRequest(url);
      });
      const view = await mountPage();
      fireEvent.change(screen.getByPlaceholderText(/Describe the image you want to generate/), {
        target: { value: "Old variations" },
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Generate" }));
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(authFetch.mock.calls.some(([url]) => url === "/api/images/status/old-job-1")).toBe(
        true,
      );
      await switchAccount(view, "account-b");
      const afterSwitch = authFetch.mock.calls.length;
      await act(async () => {
        if (outcome === "network") old.reject(new Error("Old polling failure"));
        else
          old.resolve(
            reply(
              { jobId: "old-job-1", imageId: 902, status: outcome },
              outcome === "http" ? 503 : 200,
            ),
          );
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(authFetch).toHaveBeenCalledTimes(afterSwitch);
      expect(authFetch.mock.calls.some(([url]) => url === "/api/images/status/old-job-2")).toBe(
        false,
      );
      expect(screen.getByRole("img", { name: "account-b image" })).toBeVisible();
      expect(screen.queryByText(/Queued/)).not.toBeInTheDocument();
      expect(mutations()).toHaveLength(1);
    },
  );

  it.each([
    { action: "details", path: "/api/assets/1901", body: {} },
    {
      action: "alt",
      path: "/api/assets/1901/alt-text-proposal",
      body: { proposedAltText: "Old proposed alt" },
    },
    { action: "sizes", path: "/api/assets/1901/derivatives", body: { derivatives: [{}] } },
    { action: "asset-delete", path: "/api/assets/1901", body: {} },
    { action: "image-delete", path: "/api/images/901", body: {} },
    { action: "usage", path: "/api/assets/1901/usage", body: { usages: [] } },
    {
      action: "replace",
      path: "/api/projects/4101/assets/1901/replace",
      body: { replacements: [{}] },
    },
  ])(
    "fences late $action completion and any follow-up requests",
    async ({ action, path, body }) => {
      const old = deferred<Response>();
      authFetch.mockImplementation((url: string) =>
        auth.user?.id === "account-a" && url === path ? old.promise : defaultRequest(url),
      );
      const view = await mountPage();
      const asset = within(
        screen.getByRole("textbox", { name: "Alt text for account-a.png" }).closest("article")!,
      );
      if (action === "replace") {
        await act(async () => {
          fireEvent.click(asset.getByRole("button", { name: "Show where account-a.png is used" }));
        });
        fireEvent.click(screen.getByRole("button", { name: "Replace every use in this project" }));
      } else if (action === "image-delete") {
        fireEvent.click(screen.getByRole("button", { name: "Delete" }));
      } else {
        const names: Record<string, string> = {
          details: "Save details",
          alt: "Ask Zero for alt text",
          sizes: "App sizes",
          "asset-delete": "Delete account-a.png",
          usage: "Show where account-a.png is used",
        };
        fireEvent.click(asset.getByRole("button", { name: names[action] }));
      }
      const request = authFetch.mock.calls.find(([url]) => url === path)!;
      expect(request).toBeDefined();
      await switchAccount(view, "account-b");
      expect((request[1].signal as AbortSignal).aborted).toBe(true);
      const afterSwitch = authFetch.mock.calls.length;
      await act(async () => {
        old.resolve(reply(body));
      });
      expect(authFetch).toHaveBeenCalledTimes(afterSwitch);
      expect(screen.getByRole("img", { name: "account-b image" })).toBeVisible();
      expect(screen.getByRole("textbox", { name: "Alt text for account-b.png" })).toHaveValue(
        "account-b saved alt",
      );
      expect(screen.queryByText("Where this asset is used")).not.toBeInTheDocument();
      expect(screen.queryByText(/Old proposed alt/)).not.toBeInTheDocument();
      expect(mutations()).toHaveLength(action === "usage" ? 0 : 1);
    },
  );

  it.each(["success", "failure"] as const)(
    "ignores upload %s after switching accounts and passes the existing cancellation signal",
    async (outcome) => {
      const old = deferred<unknown>();
      uploadAccountAsset.mockReturnValue(old.promise);
      const view = await mountPage();
      fireEvent.change(view.container.querySelector('input[type="file"]')!, {
        target: { files: [new File(["image"], "old-upload.png", { type: "image/png" })] },
      });
      expect(uploadAccountAsset).toHaveBeenCalledTimes(1);
      const input = uploadAccountAsset.mock.calls[0][0];
      expect(input.source).toBe("picker");
      expect(input).not.toHaveProperty("projectId");
      await switchAccount(view, "account-b");
      expect(input.signal.aborted).toBe(true);
      const afterSwitch = authFetch.mock.calls.length;
      await act(async () => {
        if (outcome === "failure") old.reject(new Error("Old upload failed"));
        else old.resolve({ assetId: 1903, name: "old-upload.png", resized: false });
      });
      expect(authFetch).toHaveBeenCalledTimes(afterSwitch);
      expect(screen.getByRole("button", { name: "Choose file" })).toBeEnabled();
      expect(screen.queryByText(/old-upload|Old upload failed/)).not.toBeInTheDocument();
    },
  );

  it("does not consume a checkout URL from the previous account", async () => {
    const old = deferred<Response>();
    const readCheckoutUrl = vi.fn(() => {
      throw new Error("An obsolete checkout URL must not be consumed");
    });
    authFetch.mockImplementation((url: string) =>
      url === "/api/assets/storage-checkout" ? old.promise : defaultRequest(url),
    );
    const view = await mountPage();
    fireEvent.click(screen.getByRole("button", { name: /Add Extra storage/ }));
    await switchAccount(view, "account-b");
    const afterSwitch = authFetch.mock.calls.length;
    await act(async () => {
      old.resolve(
        reply({
          get checkoutUrl() {
            return readCheckoutUrl();
          },
        }),
      );
    });
    expect(readCheckoutUrl).not.toHaveBeenCalled();
    expect(authFetch).toHaveBeenCalledTimes(afterSwitch);
    expect(screen.getByRole("button", { name: /Add Extra storage/ })).toBeEnabled();
  });
});
