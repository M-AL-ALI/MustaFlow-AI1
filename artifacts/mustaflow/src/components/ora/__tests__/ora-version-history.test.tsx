import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { OraVersionHistoryDialog } from "../ora-version-history";

const here = dirname(fileURLToPath(import.meta.url));
const readSource = (relativePath: string) => readFileSync(resolve(here, relativePath), "utf8");

const mockToast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

const mockAuthFetch = vi.fn();
vi.mock("@/lib/api-fetch", () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

const chain = {
  rootAssetId: 10,
  currentAssetId: 12,
  versions: [
    {
      id: 10,
      fileName: "report.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      format: "docx",
      sizeBytes: 1024,
      versionNumber: 1,
      editSummary: null,
      createdAt: "2026-07-01T10:00:00.000Z",
      isCurrent: false,
    },
    {
      id: 11,
      fileName: "report-edited.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      format: "docx",
      sizeBytes: 2048,
      versionNumber: 2,
      editSummary: "Replaced intro paragraph",
      createdAt: "2026-07-02T10:00:00.000Z",
      isCurrent: false,
    },
    {
      id: 12,
      fileName: "report-edited.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      format: "docx",
      sizeBytes: 3072,
      versionNumber: 3,
      editSummary: "Added summary table",
      createdAt: "2026-07-03T10:00:00.000Z",
      isCurrent: true,
    },
  ],
};

beforeEach(() => {
  mockAuthFetch.mockReset();
  mockToast.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("OraVersionHistoryDialog", () => {
  it("lists the version chain newest-first with a Current badge and per-version summaries", async () => {
    mockAuthFetch.mockResolvedValueOnce(jsonResponse(chain));

    render(<OraVersionHistoryDialog assetId={12} open onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("Version 3")).toBeTruthy();
    });
    expect(mockAuthFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/ora/assets/12/versions"),
    );

    const versionLabels = screen.getAllByText(/^Version \d+$/).map((el) => el.textContent);
    expect(versionLabels).toEqual(["Version 3", "Version 2", "Version 1"]);

    expect(screen.getByText("Current")).toBeTruthy();
    expect(screen.getByText("Replaced intro paragraph")).toBeTruthy();
    expect(screen.getByText("Added summary table")).toBeTruthy();
    // The current head must not offer Restore; older versions must.
    expect(screen.getAllByRole("button", { name: /restore/i })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /download/i })).toHaveLength(3);
  });

  it("restores an older version, notifies the caller with the new head id, and reloads the chain", async () => {
    const onRestored = vi.fn();
    const restoredChain = {
      rootAssetId: 10,
      currentAssetId: 13,
      versions: [
        ...chain.versions.map((v) => ({ ...v, isCurrent: false })),
        {
          ...chain.versions[0],
          id: 13,
          versionNumber: 4,
          editSummary: "Restored version 1",
          isCurrent: true,
        },
      ],
    };
    mockAuthFetch
      .mockResolvedValueOnce(jsonResponse(chain))
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, assetId: 13, versionNumber: 4, restoredFromVersion: 1 }),
      )
      .mockResolvedValueOnce(jsonResponse(restoredChain));

    render(
      <OraVersionHistoryDialog assetId={12} open onOpenChange={() => {}} onRestored={onRestored} />,
    );

    await waitFor(() => {
      expect(screen.getByText("Version 1")).toBeTruthy();
    });

    // Restore buttons are rendered newest-first: [v2, v1]. Click v1.
    const restoreButtons = screen.getAllByRole("button", { name: /restore/i });
    fireEvent.click(restoreButtons[1]);

    await waitFor(() => {
      expect(onRestored).toHaveBeenCalledWith(13);
    });
    expect(mockAuthFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/ora/assets/10/restore"),
      expect.objectContaining({ method: "POST" }),
    );
    // Chain reloads against the NEW head id.
    expect(mockAuthFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/ora/assets/13/versions"),
    );
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Version restored" }));
    await waitFor(() => {
      expect(screen.getByText("Version 4")).toBeTruthy();
    });
  });

  it("surfaces restore failures as a destructive toast and keeps the dialog usable", async () => {
    mockAuthFetch
      .mockResolvedValueOnce(jsonResponse(chain))
      .mockResolvedValueOnce(jsonResponse({ error: "Asset storage is full" }, 507));

    render(<OraVersionHistoryDialog assetId={12} open onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("Version 1")).toBeTruthy();
    });
    fireEvent.click(screen.getAllByRole("button", { name: /restore/i })[0]);

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Restore failed",
          variant: "destructive",
          description: "Asset storage is full",
        }),
      );
    });
    // List still rendered after the failure.
    expect(screen.getByText("Version 3")).toBeTruthy();
  });

  it("shows a load error when the versions request fails", async () => {
    mockAuthFetch.mockResolvedValueOnce(jsonResponse({ error: "Asset not found" }, 404));

    render(<OraVersionHistoryDialog assetId={99} open onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("Asset not found")).toBeTruthy();
    });
  });

  it("does not fetch while closed or without an asset id", () => {
    const { rerender } = render(
      <OraVersionHistoryDialog assetId={12} open={false} onOpenChange={() => {}} />,
    );
    rerender(<OraVersionHistoryDialog assetId={null} open onOpenChange={() => {}} />);
    expect(mockAuthFetch).not.toHaveBeenCalled();
  });
});

describe("version history card wiring", () => {
  const panelSource = readSource("../../ora-panel.tsx");
  const bubbleSource = readSource("../../ora-bubble.tsx");
  const librarySource = readSource("../../../pages/ora-library.tsx");

  it("gates the History affordance on a durable asset id in both chat surfaces", () => {
    for (const source of [panelSource, bubbleSource]) {
      expect(source).toContain(
        'import { OraVersionHistoryDialog } from "@/components/ora/ora-version-history";',
      );
      expect(source).toContain("const hasHistory = file.assetId != null;");
      expect(source).toContain("{historyButton}");
      expect(source).toContain("{historyDialog}");
    }
  });

  it("repoints the chat file card at the NEW head after a restore (stale bytes dropped)", () => {
    for (const source of [panelSource, bubbleSource]) {
      // After a restore the card must download the restored content, not the
      // stale inline bytes or the old asset id.
      expect(source).toContain("const { fileData: _staleBytes, ...rest } = fileProp;");
      expect(source).toContain("file = { ...rest, assetId: restoredAssetId };");
      expect(source).toContain("onRestored={setRestoredAssetId}");
    }
  });

  it("exposes version history from the Library for file assets and reloads after restore", () => {
    expect(librarySource).toContain(
      'import { OraVersionHistoryDialog } from "@/components/ora/ora-version-history";',
    );
    expect(librarySource).toContain('asset.kind === "file"');
    expect(librarySource).toContain("setHistoryAssetId(asset.id)");
    expect(librarySource).toContain("onRestored={() => void load()}");
  });
});
