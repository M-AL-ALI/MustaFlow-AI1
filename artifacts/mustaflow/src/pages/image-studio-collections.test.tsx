import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-fetch", () => ({ authFetch }));
vi.mock("@/lib/asset-upload", () => ({
  formatAssetBytes: (bytes: number) => `${bytes} bytes`,
  uploadAccountAsset: vi.fn(),
}));

import ImageStudioPage from "./image-studio";

const projects = [
  { id: 4101, name: "Garden" },
  { id: 4102, name: "Bakery" },
];
const image = {
  id: 901,
  assetId: 1901,
  prompt: "Account sailboat",
  quality: "standard",
  aspectRatio: "1:1",
  status: "completed",
  fileUrl: "/api/assets/1901/content",
  creditCost: 3,
  createdAt: "2026-09-08T00:00:00Z",
};
const projectPath = (id: number) => `/api/images?projectId=${id}&limit=50`;
const bodies: Record<string, unknown> = {
  "/api/projects": projects,
  "/api/images?limit=40": { images: [image] },
  "/api/assets?limit=100": { assets: [] },
  "/api/assets/storage-plans": {
    quota: { usedBytes: 0, reservedBytes: 0, limitBytes: 1024 },
    plans: [],
  },
  "/api/assets/analysis-usage": { total: { count: 0, estimatedProviderCostMicros: 0 } },
  [projectPath(4101)]: { images: [{ ...image, id: 11, prompt: "Garden seedling" }] },
  [projectPath(4102)]: { images: [{ ...image, id: 12, prompt: "Bakery loaf" }] },
};

function reply(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function deferred() {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function mutations() {
  return authFetch.mock.calls.filter(([, init]) => init?.method && init.method !== "GET");
}

async function selectProject(id: number) {
  await screen.findByRole("option", { name: /Garden/ });
  fireEvent.change(screen.getByRole("combobox", { name: "Collection" }), {
    target: { value: String(id) },
  });
}

beforeEach(() => {
  authFetch.mockReset();
  authFetch.mockImplementation(async (url: string) => reply(bodies[url]));
});
afterEach(cleanup);

describe("Image Studio project collections", () => {
  it("uses only the selected project's list and preserves the account draft without assigning images", async () => {
    render(<ImageStudioPage />);
    await screen.findByRole("img", { name: image.prompt });
    const prompt = screen.getByPlaceholderText(/Describe the image you want to generate/);
    fireEvent.change(prompt, { target: { value: "Keep my unfinished prompt" } });
    await selectProject(4101);
    expect(await screen.findByRole("img", { name: "Garden seedling" })).toBeVisible();
    expect(screen.queryByRole("img", { name: image.prompt })).not.toBeInTheDocument();
    expect(authFetch).toHaveBeenCalledWith(projectPath(4101));
    expect(authFetch).not.toHaveBeenCalledWith(projectPath(4102));
    expect(
      screen.getByText(/Images saved only as project files and older chat history/),
    ).toBeVisible();
    fireEvent.change(screen.getByRole("combobox", { name: "Collection" }), {
      target: { value: "account" },
    });
    expect(prompt).toBeVisible();
    expect(prompt).toHaveValue("Keep my unfinished prompt");
    expect(mutations()).toEqual([]);
  });

  it.each(["success", "failure"])(
    "ignores a late %s from the previous collection",
    async (outcome) => {
      const oldRequest = deferred();
      authFetch.mockImplementation((url: string) =>
        url === projectPath(4101) ? oldRequest.promise : Promise.resolve(reply(bodies[url])),
      );
      render(<ImageStudioPage />);
      await selectProject(4101);
      expect(screen.getByText("Loading project images...")).toBeVisible();
      expect(
        screen.queryByText("No generated images in this collection yet"),
      ).not.toBeInTheDocument();
      await selectProject(4102);
      await screen.findByRole("img", { name: "Bakery loaf" });
      await act(async () => {
        if (outcome === "success") oldRequest.resolve(reply(bodies[projectPath(4101)]));
        else oldRequest.reject(new Error("Old project failure"));
      });
      expect(screen.getByRole("img", { name: "Bakery loaf" })).toBeVisible();
      expect(screen.queryByRole("img", { name: "Garden seedling" })).not.toBeInTheDocument();
      expect(
        screen.queryByText(/This project's generated images could not be loaded/),
      ).not.toBeInTheDocument();
      expect(mutations()).toEqual([]);
    },
  );

  it.each(["http", "network", "malformed"])(
    "distinguishes %s project-list failure from an empty list and retries",
    async (failure) => {
      let fail = true;
      authFetch.mockImplementation(async (url: string) => {
        if (url === "/api/projects" && fail) {
          if (failure === "network") throw new Error("Offline");
          return failure === "malformed" ? reply({}) : reply({}, 403);
        }
        return reply(bodies[url]);
      });
      render(<ImageStudioPage />);
      expect(await screen.findByText(/Project collections could not be loaded/)).toBeVisible();
      expect(screen.queryByText(/No projects available/)).not.toBeInTheDocument();
      expect(screen.getByRole("combobox", { name: "Collection" })).toHaveValue("account");
      fail = false;
      fireEvent.click(screen.getByRole("button", { name: "Retry project collections" }));
      await screen.findByRole("option", { name: /Garden/ });
      expect(screen.getByRole("combobox", { name: "Collection" })).toHaveValue("account");
    },
  );

  it.each(["http", "network", "malformed", "invalid-row"])(
    "keeps %s image-list failure distinct from an empty collection",
    async (failure) => {
      let fail = true;
      authFetch.mockImplementation(async (url: string) => {
        if (url === projectPath(4101) && fail) {
          if (failure === "network") throw new Error("Offline");
          return failure === "malformed"
            ? reply({})
            : failure === "invalid-row"
              ? reply({ images: [{}] })
              : reply({}, 403);
        }
        return reply(bodies[url]);
      });
      render(<ImageStudioPage />);
      await selectProject(4101);
      expect(
        await screen.findByText(/This project's generated images could not be loaded/),
      ).toBeVisible();
      expect(
        screen.queryByText("No generated images in this collection yet"),
      ).not.toBeInTheDocument();
      fail = false;
      fireEvent.click(screen.getByRole("button", { name: "Retry project images" }));
      expect(await screen.findByRole("img", { name: "Garden seedling" })).toBeVisible();
    },
  );

  it("shows a scoped empty state only after a successful empty response", async () => {
    authFetch.mockImplementation(async (url: string) =>
      reply(url === projectPath(4101) ? { images: [] } : bodies[url]),
    );
    render(<ImageStudioPage />);
    await selectProject(4101);
    expect(await screen.findByText("No generated images in this collection yet")).toBeVisible();
    expect(screen.queryByRole("img", { name: image.prompt })).not.toBeInTheDocument();
    expect(mutations()).toEqual([]);
  });

  it("keeps the selected project's last results on refresh failure", async () => {
    render(<ImageStudioPage />);
    await selectProject(4101);
    await screen.findByRole("img", { name: "Garden seedling" });
    authFetch.mockImplementation(async (url: string) =>
      url === projectPath(4101) ? reply({}, 503) : reply(bodies[url]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh collection" }));
    expect(await screen.findByText("Showing the last loaded images for Garden.")).toBeVisible();
    expect(screen.getByRole("img", { name: "Garden seedling" })).toBeVisible();
  });

  it("renders pending, failed, missing-file and broken-preview records without reuse actions", async () => {
    authFetch.mockImplementation(async (url: string) =>
      reply(
        url === projectPath(4101)
          ? {
              images: [
                { ...image, id: 21, status: "pending", prompt: "Pending seedling", fileUrl: null },
                {
                  ...image,
                  id: 22,
                  status: "failed",
                  prompt: "Failed seedling",
                  fileUrl: null,
                  errorMessage: "Provider unavailable",
                },
                { ...image, id: 23, prompt: "Missing file", fileUrl: null },
                { ...image, id: 24, prompt: "Broken preview" },
              ],
            }
          : bodies[url],
      ),
    );
    render(<ImageStudioPage />);
    await selectProject(4101);
    expect(await screen.findByText("Queued")).toBeVisible();
    expect(screen.queryByText("Provider unavailable")).not.toBeInTheDocument();
    expect(screen.getByText(/The image could not be created\. Please try again\./)).toBeVisible();
    expect(screen.getByText("Preview unavailable")).toBeVisible();
    fireEvent.error(screen.getByRole("img", { name: "Broken preview" }));
    expect(screen.getAllByText("Preview unavailable")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Use in project" })).not.toBeInTheDocument();
    expect(mutations()).toEqual([]);
  });
});

describe("Image Studio explicit reuse", () => {
  it("requires a new destination choice every time the dialog opens", async () => {
    render(<ImageStudioPage />);
    const useButton = await screen.findByRole("button", { name: "Use in project" });
    await screen.findByRole("option", { name: /Garden/ });
    fireEvent.click(useButton);
    let dialog = within(screen.getByRole("dialog", { name: "Use in a project" }));
    expect(dialog.getByText("Generated image 901")).toBeVisible();
    expect(dialog.getByRole("combobox", { name: "Project for asset" })).toHaveValue("");
    expect(dialog.getByRole("button", { name: "Add to project" })).toBeDisabled();
    fireEvent.change(dialog.getByRole("combobox"), { target: { value: "4102" } });
    expect(dialog.getByRole("button", { name: "Add to project" })).toBeEnabled();
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    fireEvent.click(useButton);
    dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByRole("combobox")).toHaveValue("");
    expect(dialog.getByRole("button", { name: "Add to project" })).toBeDisabled();
    expect(mutations()).toEqual([]);
  });

  it("submits only to the chosen destination and keeps a failed addition visible in the dialog", async () => {
    const addition = deferred();
    authFetch.mockImplementation((url: string) =>
      url.endsWith("/materialize") ? addition.promise : Promise.resolve(reply(bodies[url])),
    );
    render(<ImageStudioPage />);
    await screen.findByRole("option", { name: /Bakery/ });
    fireEvent.click(await screen.findByRole("button", { name: "Use in project" }));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByRole("combobox"), { target: { value: "4102" } });
    fireEvent.click(dialog.getByRole("button", { name: "Add to project" }));
    expect(mutations()).toHaveLength(1);
    expect(mutations()[0][0]).toBe("/api/projects/4102/assets/1901/materialize");
    expect(mutations()[0][1]).toMatchObject({ method: "POST" });
    expect(dialog.getByRole("combobox")).toBeDisabled();
    expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await act(async () => {
      addition.resolve(reply({ error: "Project access denied" }, 403));
    });
    expect(await dialog.findByRole("alert")).toBeVisible();
    expect(dialog.getByRole("combobox")).toHaveValue("4102");
    expect(screen.getByRole("dialog")).toBeVisible();
    await waitFor(() =>
      expect(dialog.getByRole("button", { name: "Add to project" })).toBeEnabled(),
    );
    expect(mutations()).toHaveLength(1);
  });

  it("does not enable reuse when destination loading fails", async () => {
    authFetch.mockImplementation(async (url: string) =>
      url === "/api/projects" ? reply({}, 503) : reply(bodies[url]),
    );
    render(<ImageStudioPage />);
    await screen.findByText(/Project collections could not be loaded/);
    fireEvent.click(await screen.findByRole("button", { name: "Use in project" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(/Destination projects could not be loaded/)).toBeVisible();
    expect(dialog.getByRole("button", { name: "Add to project" })).toBeDisabled();
    expect(dialog.getByRole("combobox")).toHaveValue("");
    expect(mutations()).toEqual([]);
  });
});
