import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { OraMemoryManager } from "../ora-memory-manager";

const mockToast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

// The manager talks to the isolated Ora memory endpoints (/api/ora/memories),
// NOT the Builder Knowledge Vault (/api/knowledge). authFetch is the single
// transport for fetchOraMemories / deleteOraMemory, so we mock it here.
const mockAuthFetch = vi.fn();
vi.mock("@/lib/api-fetch", () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

vi.mock("@/lib/ora-memory-settings", () => ({
  getReferenceSavedMemories: () => true,
  setReferenceSavedMemories: vi.fn(),
  getAutoSaveMemories: () => false,
  setAutoSaveMemories: vi.fn(),
}));

const noteMemory = {
  id: 42,
  title: "my company is Acme Corp",
  content: "my company is Acme Corp",
  enabled: true,
  sourceConversationId: null,
  oraProjectId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

/** authFetch returns a list response for GETs and an ok ack for DELETEs. */
function wireAuthFetch(deleteResponse: { ok: boolean; status: number }) {
  mockAuthFetch.mockImplementation((url: string, init?: { method?: string }) => {
    if (init?.method === "DELETE") {
      return Promise.resolve(deleteResponse);
    }
    // GET /api/ora/memories
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ memories: [noteMemory] }),
    });
  });
}

describe("OraMemoryManager — delete flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  function getForgetButton(): HTMLButtonElement {
    const btn = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Forget memory"]',
    );
    if (!btn) throw new Error("Forget memory button not found");
    return btn;
  }

  it("deletes via the Ora memory endpoint and shows success only when ok", async () => {
    wireAuthFetch({ ok: true, status: 200 });
    render(<OraMemoryManager open={true} onOpenChange={vi.fn()} />);

    // Wait for the memory list to load before interacting with it.
    await waitFor(() => getForgetButton());
    fireEvent.click(getForgetButton());

    await waitFor(() => {
      expect(mockAuthFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/ora/memories/42"),
        { method: "DELETE" },
      );
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Memory forgotten" }),
      );
    });
  });

  it("shows a destructive toast and does NOT report success when delete fails (HTTP 403)", async () => {
    wireAuthFetch({ ok: false, status: 403 });
    render(<OraMemoryManager open={true} onOpenChange={vi.fn()} />);

    await waitFor(() => getForgetButton());
    fireEvent.click(getForgetButton());

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Failed to forget memory", variant: "destructive" }),
      );
    });
    expect(mockToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Memory forgotten" }),
    );
  });
});
