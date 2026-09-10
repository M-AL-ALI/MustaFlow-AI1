import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ImageStudioPage from "./image-studio";
import { IMAGE_FAILURE_FALLBACK } from "@/lib/image-failure-presentation";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-fetch", () => ({ authFetch: fetchMock }));
vi.mock("@/components/image-studio/image-studio-collections", () => ({
  ImageStudioCollections: ({ children }: { children: (context: object) => ReactNode }) =>
    children({
      projects: [],
      projectsLoading: false,
      projectsError: null,
      retryProjects: () => {},
    }),
}));

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () => {
      if (url.startsWith("/api/images?"))
        return {
          images: [
            {
              id: 987,
              prompt: "Test image",
              quality: "draft",
              aspectRatio: "1:1",
              status: "failed",
              creditCost: 1,
              createdAt: "2026-09-08T00:00:00Z",
              errorMessage:
                "429 No credits remaining. Visit https://platform.openai.com/settings/organization/billing/",
            },
          ],
        };
      if (url.includes("storage-plans"))
        return { quota: { usedBytes: 0, reservedBytes: 0, limitBytes: 500000000 }, plans: [] };
      if (url.includes("analysis-usage"))
        return { total: { count: 0, estimatedProviderCostMicros: 0 } };
      return { assets: [] };
    },
  }));
});
afterEach(cleanup);

it("renders a support reference instead of the stored provider billing message without starting a job", async () => {
  render(<ImageStudioPage />);
  expect(await screen.findByText("Image #987")).toBeVisible();
  expect(screen.getByText(IMAGE_FAILURE_FALLBACK)).toBeVisible();
  expect(screen.queryByText(/platform\.openai\.com/)).toBeNull();
  expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(
    true,
  );
});
