import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-fetch", () => ({ authFetch }));
vi.mock("@/lib/asset-upload", () => ({
  formatAssetBytes: (bytes: number) => String(bytes) + " bytes",
  uploadAccountAsset: vi.fn(),
}));

import ImageStudioPage from "./image-studio";

const bodies: Record<string, unknown> = {
  "/api/images?limit=40": { images: [] },
  "/api/assets?limit=100": { assets: [] },
  "/api/assets/storage-plans": {
    quota: { usedBytes: 0, reservedBytes: 0, limitBytes: 1024 },
    plans: [],
  },
  "/api/assets/analysis-usage": { total: { count: 0, estimatedProviderCostMicros: 0 } },
  "/api/projects": [],
};

function reply(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => {
  authFetch.mockReset();
  authFetch.mockImplementation(async (url: string) => reply(bodies[url]));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const loadCases = [
  {
    path: "/api/images?limit=40",
    error: "Generated images could not be loaded. Please try again.",
    retry: "Retry generated images",
    empty: /No images yet/,
    success: /No images yet/,
  },
  {
    path: "/api/assets?limit=100",
    error: "Your private asset library could not be loaded. Please try again.",
    retry: "Retry asset library",
    empty: /Upload an asset or ask Zero to observe a preview/,
    success: /Upload an asset or ask Zero to observe a preview/,
  },
  {
    path: "/api/assets/storage-plans",
    error: "Your storage allowance could not be loaded. Please try again.",
    retry: "Retry storage",
    empty: /Reading your private storage allowance/,
    success: /0 bytes used of 1024 bytes/,
  },
];

describe.each(["http", "network", "malformed"] as const)("%s load failure", (failure) => {
  it.each(loadCases)(
    "offers $retry without claiming an empty library or pending quota",
    async ({ path, error, retry, empty, success }) => {
      let failNext = true;
      authFetch.mockImplementation(async (url: string) => {
        if (url === path && failNext) {
          failNext = false;
          if (failure === "network") throw new Error("Network unavailable");
          return failure === "malformed" ? reply({}) : reply({ error: "Not found" }, 404);
        }
        return reply(bodies[url]);
      });

      render(<ImageStudioPage />);
      expect(await screen.findByText(error)).toBeInTheDocument();
      expect(screen.queryByText(empty)).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: retry }));
      expect(await screen.findByText(success)).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByText(error)).not.toBeInTheDocument());
    },
  );
});

it("loads the private library even when the independent storage request rejects", async () => {
  authFetch.mockImplementation(async (url: string) => {
    if (url === "/api/assets/storage-plans") throw new Error("Network unavailable");
    if (url === "/api/assets?limit=100")
      return reply({
        assets: [
          {
            id: 9,
            kind: "file",
            source: "upload",
            filename: "saved-reference.txt",
            mimeType: "text/plain",
            sizeBytes: 12,
            scanState: "not-scanned",
            contentUrl: "/api/assets/9/content",
            createdAt: "2026-09-05T00:00:00.000Z",
          },
        ],
      });
    return reply(bodies[url]);
  });
  render(<ImageStudioPage />);
  expect(await screen.findByText("saved-reference.txt")).toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "Retry storage" })).toBeInTheDocument();
});

it("offers an independent retry when image analysis usage cannot be loaded", async () => {
  let failNext = true;
  authFetch.mockImplementation(async (url: string) => {
    if (url === "/api/assets/analysis-usage" && failNext) {
      failNext = false;
      return reply({ error: "Unavailable" }, 503);
    }
    return reply(bodies[url]);
  });
  render(<ImageStudioPage />);
  expect(
    await screen.findByText("Image analysis usage could not be loaded. Please try again."),
  ).toBeInTheDocument();
  expect(screen.queryByText("No image analysis usage yet.")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry analysis usage" }));
  expect(await screen.findByText(/0 analyses/)).toBeInTheDocument();
});

it("shows the known retryable storage-admission message without creating a pending image", async () => {
  authFetch.mockImplementation(async (url: string) => {
    if (url === "/api/images/generate")
      return reply(
        {
          code: "asset_storage_reconciliation_required",
          error: "Image generation failed",
        },
        409,
      );
    return reply(bodies[url]);
  });
  render(<ImageStudioPage />);
  await screen.findByText("No images yet");
  fireEvent.change(screen.getByPlaceholderText(/Describe the image you want to generate/), {
    target: { value: "A quiet mountain landscape" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Generate" }));
  expect(
    await screen.findByText(
      "Your storage total is still being verified. Please try again after storage reconciliation finishes.",
    ),
  ).toBeInTheDocument();
  expect(screen.queryByText("Image generation failed")).not.toBeInTheDocument();
  expect(screen.getByText("No images yet")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
});

const generatedAsset = {
  id: 901,
  kind: "image",
  source: "image-generation",
  filename: "generated-901.webp",
  mimeType: "image/webp",
  sizeBytes: 12,
  scanState: "decoded",
  contentUrl: "/api/assets/901/content",
  createdAt: "2026-09-07T00:00:00.000Z",
};
const generatedImage = {
  id: 901,
  assetId: 901,
  prompt: "Private blue sailboat",
  quality: "draft",
  aspectRatio: "1:1",
  status: "completed",
  fileUrl: "/api/assets/901/content",
  creditCost: 1,
  createdAt: "2026-09-07T00:00:00.000Z",
};

it.each(["completed", "failed"])(
  "refreshes the asset library and storage after a generation becomes %s",
  async (status) => {
    vi.useFakeTimers();
    let settled = false;
    authFetch.mockImplementation(async (url: string) => {
      if (url === "/api/images/generate")
        return reply({ jobId: "job-901", imageId: 901, creditCost: 1, status: "pending" });
      if (url === "/api/images/status/job-901") {
        settled = true;
        return reply({ jobId: "job-901", imageId: 901, status });
      }
      if (url === "/api/images?limit=40")
        return reply({ images: settled ? [{ ...generatedImage, status }] : [] });
      if (url === "/api/assets?limit=100")
        return reply({ assets: settled && status === "completed" ? [generatedAsset] : [] });
      return reply(bodies[url]);
    });
    await act(async () => {
      render(<ImageStudioPage />);
    });
    fireEvent.change(screen.getByPlaceholderText(/Describe the image you want to generate/), {
      target: { value: generatedImage.prompt },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(authFetch.mock.calls.filter(([url]) => url === "/api/assets?limit=100")).toHaveLength(2);
    expect(
      authFetch.mock.calls.filter(([url]) => url === "/api/assets/storage-plans"),
    ).toHaveLength(2);
    if (status === "completed")
      expect(screen.getByText(generatedAsset.filename)).toBeInTheDocument();
    else expect(screen.getByText("Generation failed")).toBeInTheDocument();
  },
);

it.each([403, 409, 503, "network"])(
  "keeps a generated image after deletion fails with %s and refreshes assets only on success",
  async (failure) => {
    let rejectDeletion = true;
    let deleted = false;
    authFetch.mockImplementation(async (url: string) => {
      if (url === "/api/images?limit=40") return reply({ images: [generatedImage] });
      if (url === "/api/assets?limit=100")
        return reply({ assets: deleted ? [] : [generatedAsset] });
      if (url === "/api/images/901") {
        if (rejectDeletion) {
          if (failure === "network") throw new Error("Network unavailable");
          return reply({ error: "Deletion denied" }, Number(failure));
        }
        deleted = true;
        return reply({}, 204);
      }
      return reply(bodies[url]);
    });
    render(<ImageStudioPage />);
    await screen.findByText(generatedAsset.filename);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("It remains in your library");
    expect(screen.getByAltText(generatedImage.prompt)).toBeInTheDocument();
    expect(authFetch.mock.calls.filter(([url]) => url === "/api/assets?limit=100")).toHaveLength(1);
    rejectDeletion = false;
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(screen.queryByText(generatedAsset.filename)).not.toBeInTheDocument(),
    );
    expect(screen.queryByAltText(generatedImage.prompt)).not.toBeInTheDocument();
    expect(
      authFetch.mock.calls.filter(([url]) => url === "/api/assets/storage-plans"),
    ).toHaveLength(2);
  },
);

it("keeps an asset and shows a retryable message when its delete request rejects", async () => {
  authFetch.mockImplementation(async (url: string) => {
    if (url === "/api/assets?limit=100") return reply({ assets: [generatedAsset] });
    if (url === "/api/assets/901") throw new Error("Network unavailable");
    return reply(bodies[url]);
  });
  render(<ImageStudioPage />);
  await screen.findByText(generatedAsset.filename);
  fireEvent.click(screen.getByRole("button", { name: `Delete ${generatedAsset.filename}` }));
  expect(
    await screen.findByText(
      "This asset could not be deleted. It remains in your library. Please try again.",
    ),
  ).toBeInTheDocument();
  expect(screen.getByText(generatedAsset.filename)).toBeInTheDocument();
});
